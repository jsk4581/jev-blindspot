// One systemOne call with a hard timeout. Failures are mapped to a small
// closed set so the panel can show why the gate was unavailable.
import { TypeSafeClient, type SystemOneResult } from "@typesafe-ai/sdk";
import type { Config } from "../shared/config.js";
import { GAP_KEYS, type GateAnswers, type GateFailure, type GapKey } from "../shared/protocol.js";
import { buildQuestions, type GateQuestions } from "./questions.js";
import type { GateState } from "./state.js";

export type GateOutcome =
  | { ok: true; answers: GateAnswers; latency_ms: number; usage?: { input_tokens: number; output_tokens: number } }
  | { ok: false; failure: GateFailure; message: string; latency_ms: number };

let client: TypeSafeClient | undefined;
const questions: GateQuestions = buildQuestions();

export async function runGate(state: GateState, cfg: Config): Promise<GateOutcome> {
  const t0 = Date.now();
  if (cfg.fake) return fakeGate(state, t0);
  if (!cfg.hasTypesafeKey) return { ok: false, failure: "no_api_key", message: "TYPESAFE_API_KEY not set", latency_ms: 0 };
  client ??= new TypeSafeClient({ timeout: cfg.gateTimeoutMs, retry: { maxRetries: 0 } });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.gateTimeoutMs);
  try {
    const res: SystemOneResult<GateQuestions> = await client.systemOne(
      { state: state as unknown as Record<string, any>, questions, model: cfg.jevModel },
      { signal: ctrl.signal, timeout: cfg.gateTimeoutMs },
    );
    return { ok: true, answers: reduce(res), latency_ms: Date.now() - t0, usage: res.usage };
  } catch (e: any) {
    const latency_ms = Date.now() - t0;
    const name = String(e?.name ?? "");
    if (ctrl.signal.aborted || /Timeout|Abort/i.test(name)) return { ok: false, failure: "timeout", message: `gate timeout after ${cfg.gateTimeoutMs}ms`, latency_ms };
    if (typeof e?.status === "number") return { ok: false, failure: "http", message: `HTTP ${e.status}: ${e.message ?? ""}`.trim(), latency_ms };
    if (/JSON|parse/i.test(String(e?.message))) return { ok: false, failure: "parse", message: String(e.message), latency_ms };
    return { ok: false, failure: "unknown", message: String(e?.message ?? e), latency_ms };
  } finally {
    clearTimeout(timer);
  }
}

function reduce(res: SystemOneResult<GateQuestions>): GateAnswers {
  const a = res.answers;
  const gaps = Object.fromEntries(GAP_KEYS.map((k) => [k, clamp01(a[k].noul)])) as Record<GapKey, number>;
  return {
    worth_checking: clamp01(a.worth_checking.noul),
    risk: Number(a.risk.score) + 1, // rubric index 0..4 -> 1..5
    risk_confidence: clamp01(a.risk.confidence),
    gaps,
    model: res.model,
  };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** M1 stub: deterministic, no network. Short prompts are quiet, longer ones analyze. */
function fakeGate(state: GateState, t0: number): GateOutcome {
  const len = state.prompt.trim().length;
  const worth = len < 12 ? 0.08 : Math.min(0.95, 0.5 + len / 200);
  const gaps = Object.fromEntries(GAP_KEYS.map((k, i) => [k, len < 12 ? 0.05 : ((len + i * 37) % 100) / 100])) as Record<GapKey, number>;
  return {
    ok: true,
    answers: { worth_checking: worth, risk: /prod|delete|drop|force/i.test(state.prompt) ? 4.6 : 2.1, risk_confidence: 0.7, gaps, model: "fake" },
    latency_ms: Date.now() - t0,
  };
}
