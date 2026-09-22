// Wire contract shared by the hook, the daemon and the panel. Bump
// PROTOCOL_VERSION on any incompatible change; the panel shows a
// "reload" banner when the daemon's version differs from its own.

export const PROTOCOL_VERSION = 1;

/** Which coding agent the prompt was typed into. */
export type Agent = "claude" | "codex";

/** Hook -> daemon. One per UserPromptSubmit. */
export interface PromptSubmittedEvent {
  v: number;
  type: "prompt_submitted";
  /** uuid; also the turn_id everywhere downstream. */
  event_id: string;
  ts: number;
  session_id: string;
  cwd: string;
  prompt: string;
  agent?: Agent;
  transcript_path?: string;
  hook_event_name?: string;
  hook_version?: string;
}

export type TurnState =
  | "pending"
  | "analyzing"
  | "quiet"
  | "gate_unavailable"
  | "done"
  | "error"
  | "cancelled";

export type QuietReason =
  | "duplicate"
  | "low_worth";

export type GateFailure = "no_api_key" | "timeout" | "http" | "parse" | "unknown";

export const GAP_KEYS = [
  "missing_context",
  "missing_specification",
  "unclear_instruction",
  "multiple_context",
] as const;
export type GapKey = (typeof GAP_KEYS)[number];

/** Raw gate answers, already reduced to plain numbers. */
export interface GateAnswers {
  worth_checking: number;
  /** probability-weighted mean on the 1..5 rubric */
  risk: number;
  risk_confidence: number;
  gaps: Record<GapKey, number>;
  model: string;
}

export interface GateDecision {
  decision: "analyze" | "quiet";
  reason?: QuietReason;
  flagged_gaps: GapKey[];
  /** gaps sorted by probability, top 3, for the quiet line */
  top_gaps: Array<{ key: GapKey; p: number }>;
}

export type Severity = "note" | "worth-asking" | "likely-costly";

export interface BrainItem {
  title: string;
  why: string;
  suggestion?: string;
  domain: string;
  severity: Severity;
  confidence: number;
}

/** What one brain run consumed, in the agent's own accounting. Cached tokens are
 *  the part of input served from cache; cost is only present when the agent reports it. */
export interface BrainUsage {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens?: number;
  cost_usd?: number;
  turns?: number;
}

export interface BrainResult {
  language: string;
  domains: string[];
  items: BrainItem[];
}

/** One turn as the panel sees it (also the in-memory store shape). */
export interface Turn {
  turn_id: string;
  session_id: string;
  ts: number;
  prompt: string;
  cwd: string;
  agent?: Agent;
  state: TurnState;
  gate?: GateAnswers;
  gate_decision?: GateDecision;
  gate_failure?: GateFailure;
  gate_latency_ms?: number;
  result?: BrainResult;
  brain_ms?: number;
  brain_model?: string;
  brain_usage?: BrainUsage;
  error?: { stage: "gate" | "brain"; message: string };
  cancel_reason?: "shutdown";
}

export interface SessionSummary {
  session_id: string;
  cwd: string;
  cwd_base: string;
  agent?: Agent;
  last_ts: number;
  turn_count: number;
  last_state: TurnState;
  /** summed over the session's brain runs */
  brain_tokens: number;
  brain_cost_usd?: number;
}

/** SSE frames, keyed by event name. */
export interface SseFrames {
  snapshot: { v: number; sessions: SessionSummary[]; turns: Turn[] };
  session: SessionSummary;
  turn: Turn;
}

/** JSONL records in ~/.local/share/jev-blindspot/sessions/<sid>.jsonl */
export type StoreRecord =
  | { v: number; kind: "prompt"; turn_id: string; ts: number; session_id: string; prompt: string; cwd: string; agent?: Agent; transcript_path?: string }
  | { v: number; kind: "gate"; turn_id: string; ts: number; state: TurnState; gate?: GateAnswers; decision?: GateDecision; failure?: GateFailure; latency_ms?: number }
  | { v: number; kind: "brain"; turn_id: string; ts: number; result: BrainResult; brain_ms: number; model: string; usage?: BrainUsage }
  | { v: number; kind: "error"; turn_id: string; ts: number; stage: "gate" | "brain"; message: string }
  | { v: number; kind: "cancelled"; turn_id: string; ts: number; reason: "shutdown" };

export function isPromptSubmittedEvent(x: unknown): x is PromptSubmittedEvent {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    o.type === "prompt_submitted" &&
    typeof o.event_id === "string" &&
    typeof o.session_id === "string" &&
    typeof o.cwd === "string" &&
    typeof o.prompt === "string" &&
    typeof o.ts === "number"
  );
}
