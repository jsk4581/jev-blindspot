// Orchestrates one turn: store -> gate -> (brain) -> SSE. Turns of a session
// run in order; only daemon shutdown cancels a running brain.
import type { Config } from "../shared/config.js";
import type { FileLogger } from "../shared/log.js";
import {
  PROTOCOL_VERSION,
  type GateFailure,
  type PromptSubmittedEvent,
  type Turn,
} from "../shared/protocol.js";
import { runGate } from "../gate/client.js";
import { buildGateState } from "../gate/state.js";
import type { Exchange } from "../context/transcript.js";
import { decideGate, hashPrompt, type SessionHistory } from "../gate/thresholds.js";
import { runBrain } from "../brain/runner.js";
import { BrainQueue } from "./queue.js";
import type { SessionStore } from "./store.js";
import type { SseHub } from "./sse.js";

export class Pipeline {
  private queue = new BrainQueue(2);
  private seen = new Set<string>();
  private lastActivity = Date.now();
  stats = { events: 0, gate_ok: 0, gate_fail: 0, analyzed: 0, brain_ok: 0, brain_fail: 0, gate_ms: [] as number[], brain_ms: [] as number[] };

  constructor(
    private cfg: Config,
    private store: SessionStore,
    private hub: SseHub,
    private log: FileLogger,
  ) {}

  get activeBrains(): number {
    return this.queue.active;
  }
  get lastActivityTs(): number {
    return this.lastActivity;
  }
  touch(): void {
    this.lastActivity = Date.now();
  }

  shutdown(): void {
    this.queue.cancelAll();
  }

  /** Entry point for POST /event and spool drain. Returns false on duplicate event_id. */
  accept(ev: PromptSubmittedEvent): boolean {
    this.touch();
    if (this.seen.has(ev.event_id) || this.store.getTurn(ev.event_id)) return false;
    this.seen.add(ev.event_id);
    if (this.seen.size > 5000) this.seen.clear();
    this.stats.events++;

    const turn: Turn = {
      turn_id: ev.event_id,
      session_id: ev.session_id,
      ts: ev.ts,
      prompt: ev.prompt,
      cwd: ev.cwd,
      agent: ev.agent,
      state: "pending",
    };
    const isNewSession = !this.store.summaryOf(ev.session_id);
    this.store.addTurn(turn, ev.transcript_path);
    if (isNewSession) this.hub.broadcast("session", this.store.summaryOf(ev.session_id));
    this.emit(turn);
    void this.runGateStage(turn, ev).catch((e) => this.log.error("pipeline crashed", { turn: turn.turn_id, e: String(e) }));
    return true;
  }

  private emit(turn: Turn): void {
    this.hub.broadcast("turn", turn);
    const s = this.store.summaryOf(turn.session_id);
    if (s) this.hub.broadcast("session", s);
  }

  private async runGateStage(turn: Turn, ev: PromptSubmittedEvent): Promise<void> {
    const state = buildGateState(ev);
    const out = await runGate(state, this.cfg);
    this.touch();
    turn.gate_latency_ms = out.latency_ms;
    this.stats.gate_ms.push(out.latency_ms);
    if (this.stats.gate_ms.length > 500) this.stats.gate_ms.shift();

    if (!out.ok) {
      this.stats.gate_fail++;
      this.log.warn("gate unavailable", { turn: turn.turn_id, failure: out.failure, message: out.message, ms: out.latency_ms });
      const failure: GateFailure = out.failure;
      if (this.cfg.gateFallback === "brain") {
        turn.state = "analyzing";
        turn.gate_failure = failure;
        this.store.update(turn, { v: PROTOCOL_VERSION, kind: "gate", turn_id: turn.turn_id, ts: Date.now(), state: "analyzing", failure, latency_ms: out.latency_ms });
        this.emit(turn);
        this.enqueueBrain(turn, ev, state.project, state.history);
        return;
      }
      turn.state = "gate_unavailable";
      turn.gate_failure = failure;
      turn.error = { stage: "gate", message: out.message };
      this.store.update(turn, { v: PROTOCOL_VERSION, kind: "gate", turn_id: turn.turn_id, ts: Date.now(), state: "gate_unavailable", failure, latency_ms: out.latency_ms });
      this.emit(turn);
      return;
    }

    this.stats.gate_ok++;
    if (out.answers.model !== this.cfg.jevModel && !this.cfg.fake) {
      this.log.warn("jev model differs from pin", { pinned: this.cfg.jevModel, got: out.answers.model });
    }
    const now = Date.now();
    const hist = this.historyFor(turn);
    const decision = decideGate(out.answers, this.cfg.thresholds, hist, now, hashPrompt(ev.prompt));
    turn.gate = out.answers;
    turn.gate_decision = decision;
    this.log.info("gate", { turn: turn.turn_id, ms: out.latency_ms, worth: out.answers.worth_checking.toFixed(2), risk: out.answers.risk.toFixed(1), decision: decision.decision, reason: decision.reason, flagged: decision.flagged_gaps });

    if (decision.decision === "quiet") {
      turn.state = "quiet";
      this.store.update(turn, { v: PROTOCOL_VERSION, kind: "gate", turn_id: turn.turn_id, ts: now, state: "quiet", gate: out.answers, decision, latency_ms: out.latency_ms });
      this.emit(turn);
      return;
    }
    this.stats.analyzed++;
    turn.state = "analyzing";
    this.store.update(turn, { v: PROTOCOL_VERSION, kind: "gate", turn_id: turn.turn_id, ts: now, state: "analyzing", gate: out.answers, decision, latency_ms: out.latency_ms });
    this.emit(turn);
    this.enqueueBrain(turn, ev, state.project, state.history);
  }

  private historyFor(turn: Turn): SessionHistory {
    const prior = this.store.turnsOf(turn.session_id, 50).filter((t) => t.turn_id !== turn.turn_id);
    return {
      recentPrompts: prior.map((t) => ({ ts: t.ts, hash: hashPrompt(t.prompt) })),
    };
  }

  private enqueueBrain(turn: Turn, ev: PromptSubmittedEvent, project: ReturnType<typeof buildGateState>["project"], history: Exchange[]): void {
    this.queue.push({
      turn_id: turn.turn_id,
      session_id: turn.session_id,
      run: async (signal) => {
        const out = await runBrain(
          { prompt: ev.prompt, cwd: ev.cwd, project, history, agent: ev.agent, gate: turn.gate, decision: turn.gate_decision },
          this.cfg,
          signal,
        );
        this.touch();
        if (out.ok) {
          this.stats.brain_ok++;
          this.stats.brain_ms.push(out.brain_ms);
          if (this.stats.brain_ms.length > 500) this.stats.brain_ms.shift();
          turn.state = "done";
          turn.result = out.result;
          turn.brain_ms = out.brain_ms;
          turn.brain_model = out.model;
          turn.brain_usage = out.usage;
          this.store.update(turn, { v: PROTOCOL_VERSION, kind: "brain", turn_id: turn.turn_id, ts: Date.now(), result: out.result, brain_ms: out.brain_ms, model: out.model, usage: out.usage });
          this.log.info("brain", { turn: turn.turn_id, ms: out.brain_ms, items: out.result.items.length, domains: out.result.domains, tokens: out.usage ? out.usage.input_tokens + out.usage.output_tokens : undefined });
        } else if (out.cancelled) {
          turn.state = "cancelled";
          turn.cancel_reason = "shutdown";
          this.store.update(turn, { v: PROTOCOL_VERSION, kind: "cancelled", turn_id: turn.turn_id, ts: Date.now(), reason: "shutdown" });
        } else {
          this.stats.brain_fail++;
          turn.state = "error";
          turn.error = { stage: "brain", message: out.message };
          this.store.update(turn, { v: PROTOCOL_VERSION, kind: "error", turn_id: turn.turn_id, ts: Date.now(), stage: "brain", message: out.message });
          this.log.warn("brain failed", { turn: turn.turn_id, ms: out.brain_ms, message: out.message.slice(0, 300) });
        }
        this.emit(turn);
      },
    });
  }
}

