// In-memory turns + append-only JSONL per session. On boot the most recent
// files are tailed so the panel survives a daemon restart.
import { appendFileSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { PATHS, ensureDir } from "../shared/paths.js";
import {
  PROTOCOL_VERSION,
  type SessionSummary,
  type StoreRecord,
  type Turn,
} from "../shared/protocol.js";

const REBUILD_FILES = 20;
const REBUILD_TAIL_BYTES = 256 * 1024;
const MAX_TURNS_PER_SESSION = 50;

export class SessionStore {
  private turns = new Map<string, Turn>(); // turn_id -> turn
  private bySession = new Map<string, string[]>(); // session_id -> turn_ids (oldest first)
  private sessionCwd = new Map<string, string>();

  constructor() {
    ensureDir(PATHS.sessionsDir);
  }

  // ── reads ────────────────────────────────────────────────────────────
  getTurn(id: string): Turn | undefined {
    return this.turns.get(id);
  }

  turnsOf(sessionId: string, limit = 20): Turn[] {
    const ids = this.bySession.get(sessionId) ?? [];
    return ids
      .slice(-limit)
      .map((id) => this.turns.get(id)!)
      .filter(Boolean);
  }

  latestTurnOf(sessionId: string): Turn | undefined {
    const ids = this.bySession.get(sessionId);
    return ids && ids.length ? this.turns.get(ids[ids.length - 1]) : undefined;
  }

  recentTurns(sessionId: string, sinceTs: number): Turn[] {
    return this.turnsOf(sessionId, MAX_TURNS_PER_SESSION).filter((t) => t.ts >= sinceTs);
  }

  sessions(): SessionSummary[] {
    const out: SessionSummary[] = [];
    for (const [sid, ids] of this.bySession) {
      const last = this.turns.get(ids[ids.length - 1]);
      if (!last) continue;
      out.push(this.summary(sid, last, ids.length));
    }
    return out.sort((a, b) => b.last_ts - a.last_ts);
  }

  summaryOf(sessionId: string): SessionSummary | undefined {
    const ids = this.bySession.get(sessionId);
    const last = ids && this.turns.get(ids[ids.length - 1]);
    return last ? this.summary(sessionId, last, ids!.length) : undefined;
  }

  private summary(sid: string, last: Turn, count: number): SessionSummary {
    const cwd = this.sessionCwd.get(sid) ?? last.cwd;
    return {
      session_id: sid,
      cwd,
      cwd_base: basename(cwd) || cwd,
      agent: last.agent,
      last_ts: last.ts,
      turn_count: count,
      last_state: last.state,
      ...this.usageTotals(sid),
    };
  }

  private usageTotals(sid: string): { brain_tokens: number; brain_cost_usd?: number } {
    let tokens = 0;
    let cost = 0;
    let hasCost = false;
    for (const id of this.bySession.get(sid) ?? []) {
      const u = this.turns.get(id)?.brain_usage;
      if (!u) continue;
      tokens += u.input_tokens + u.output_tokens;
      if (typeof u.cost_usd === "number") {
        cost += u.cost_usd;
        hasCost = true;
      }
    }
    return hasCost ? { brain_tokens: tokens, brain_cost_usd: cost } : { brain_tokens: tokens };
  }

  // ── writes ───────────────────────────────────────────────────────────
  addTurn(t: Turn, transcriptPath?: string): void {
    this.turns.set(t.turn_id, t);
    const ids = this.bySession.get(t.session_id) ?? [];
    ids.push(t.turn_id);
    while (ids.length > MAX_TURNS_PER_SESSION) {
      const old = ids.shift()!;
      this.turns.delete(old);
    }
    this.bySession.set(t.session_id, ids);
    this.sessionCwd.set(t.session_id, t.cwd);
    this.append(t.session_id, {
      v: PROTOCOL_VERSION,
      kind: "prompt",
      turn_id: t.turn_id,
      ts: t.ts,
      session_id: t.session_id,
      prompt: t.prompt,
      cwd: t.cwd,
      agent: t.agent,
      transcript_path: transcriptPath,
    });
  }

  /** Mutate a turn in place and persist the matching record. */
  update(t: Turn, rec: StoreRecord): void {
    this.turns.set(t.turn_id, t);
    this.append(t.session_id, rec);
  }

  private append(sessionId: string, rec: StoreRecord): void {
    try {
      appendFileSync(join(PATHS.sessionsDir, safeName(sessionId) + ".jsonl"), JSON.stringify(rec) + "\n", {
        mode: 0o600,
      });
    } catch {
      /* persistence is best effort */
    }
  }

  // ── rebuild ──────────────────────────────────────────────────────────
  rebuild(): number {
    let files: Array<{ path: string; mtime: number }> = [];
    try {
      files = readdirSync(PATHS.sessionsDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          const p = join(PATHS.sessionsDir, f);
          return { path: p, mtime: statSync(p).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, REBUILD_FILES);
    } catch {
      return 0;
    }
    let n = 0;
    for (const f of files.reverse()) n += this.loadFile(f.path);
    return n;
  }

  private loadFile(path: string): number {
    let text: string;
    try {
      const size = statSync(path).size;
      const buf = readFileSync(path);
      text = buf.subarray(Math.max(0, size - REBUILD_TAIL_BYTES)).toString("utf8");
      if (size > REBUILD_TAIL_BYTES) text = text.slice(text.indexOf("\n") + 1);
    } catch {
      return 0;
    }
    let n = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec: StoreRecord;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      this.applyRecord(rec);
      n++;
    }
    return n;
  }

  private applyRecord(rec: StoreRecord): void {
    if (rec.kind === "prompt") {
      const t: Turn = {
        turn_id: rec.turn_id,
        session_id: rec.session_id,
        ts: rec.ts,
        prompt: rec.prompt,
        cwd: rec.cwd,
        agent: rec.agent,
        state: "pending",
      };
      this.turns.set(t.turn_id, t);
      const ids = this.bySession.get(t.session_id) ?? [];
      ids.push(t.turn_id);
      while (ids.length > MAX_TURNS_PER_SESSION) this.turns.delete(ids.shift()!);
      this.bySession.set(t.session_id, ids);
      this.sessionCwd.set(t.session_id, t.cwd);
      return;
    }
    const t = this.turns.get(rec.turn_id);
    if (!t) return;
    if (rec.kind === "gate") {
      t.state = rec.state;
      t.gate = rec.gate;
      t.gate_decision = rec.decision;
      t.gate_failure = rec.failure;
      t.gate_latency_ms = rec.latency_ms;
    } else if (rec.kind === "brain") {
      t.state = "done";
      t.result = rec.result;
      t.brain_ms = rec.brain_ms;
      t.brain_model = rec.model;
      t.brain_usage = rec.usage;
    } else if (rec.kind === "error") {
      t.state = "error";
      t.error = { stage: rec.stage, message: rec.message };
    } else if (rec.kind === "cancelled") {
      t.state = "cancelled";
      t.cancel_reason = rec.reason;
    }
  }

  /** After rebuild, anything still pending/analyzing was interrupted. */
  markInterrupted(): void {
    for (const t of this.turns.values()) {
      if (t.state === "pending" || t.state === "analyzing") {
        const stage = t.state === "pending" ? "gate" : "brain";
        t.state = "error";
        t.error = { stage, message: "daemon restarted" };
      }
    }
  }

  /** Delete session files older than `days`. Returns count removed. */
  prune(days: number): number {
    const cutoff = Date.now() - days * 86_400_000;
    let n = 0;
    try {
      for (const f of readdirSync(PATHS.sessionsDir)) {
        const p = join(PATHS.sessionsDir, f);
        if (statSync(p).mtimeMs < cutoff) {
          unlinkSync(p);
          n++;
        }
      }
    } catch {
      /* ignore */
    }
    return n;
  }
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "session";
}
