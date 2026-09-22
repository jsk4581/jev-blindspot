// Pure decision function. Two rules: a repeat of the same prompt is quiet,
// and a prompt an expert would have nothing to add to is quiet. Everything
// else is analyzed. Gap flags never decide; they are chips and brain hints.
import type { Thresholds } from "../shared/config.js";
import { GAP_KEYS, type GateAnswers, type GateDecision, type GapKey } from "../shared/protocol.js";

export interface SessionHistory {
  /** [ts, promptHash] of prior turns, for the duplicate check */
  recentPrompts: Array<{ ts: number; hash: string }>;
}

export function decideGate(
  g: GateAnswers,
  t: Thresholds,
  hist: SessionHistory,
  now: number,
  promptHash: string,
): GateDecision {
  const sorted = GAP_KEYS.map((key) => ({ key, p: g.gaps[key] ?? 0 })).sort((a, b) => b.p - a.p);
  const top_gaps = sorted.slice(0, 3);
  const flagged_gaps: GapKey[] = sorted.filter((x) => x.p >= t.gapMin).map((x) => x.key);
  const quiet = (reason: GateDecision["reason"]): GateDecision => ({
    decision: "quiet",
    reason,
    flagged_gaps,
    top_gaps,
  });

  if (hist.recentPrompts.some((r) => r.hash === promptHash && now - r.ts <= t.duplicateWindowMs)) {
    return quiet("duplicate");
  }
  const worthMin = g.risk >= t.riskHigh ? t.worthMinHighRisk : t.worthMin;
  if (g.worth_checking < worthMin) return quiet("low_worth");
  return { decision: "analyze", flagged_gaps, top_gaps };
}

export function hashPrompt(s: string): string {
  // FNV-1a 32-bit over the normalized prompt; collisions are harmless here.
  let h = 0x811c9dc5;
  const norm = s.trim().replace(/\s+/g, " ");
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
