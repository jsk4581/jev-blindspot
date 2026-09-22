import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGate, hashPrompt } from "../src/gate/thresholds.js";
import { DEFAULT_THRESHOLDS } from "../src/shared/config.js";
import { GAP_KEYS, type GateAnswers, type GapKey } from "../src/shared/protocol.js";

const T = DEFAULT_THRESHOLDS;
const NOW = 1_000_000_000;
const empty = { recentPrompts: [] };

function answers(worth: number, risk: number, gaps: Partial<Record<GapKey, number>> = {}): GateAnswers {
  const g = Object.fromEntries(GAP_KEYS.map((k) => [k, gaps[k] ?? 0.1])) as Record<GapKey, number>;
  return { worth_checking: worth, risk, risk_confidence: 0.8, gaps: g, model: "test" };
}

test("low worth is quiet, whatever the gap flags say", () => {
  const d = decideGate(answers(0.3, 2, { unclear_instruction: 0.9 }), T, empty, NOW, "h");
  assert.equal(d.decision, "quiet");
  assert.equal(d.reason, "low_worth");
  assert.deepEqual(d.flagged_gaps, ["unclear_instruction"]); // still reported as a chip
});

test("worth at or above the threshold analyzes, with or without gap flags", () => {
  assert.equal(decideGate(answers(T.worthMin - 0.001, 2), T, empty, NOW, "h").reason, "low_worth");
  assert.equal(decideGate(answers(T.worthMin, 2), T, empty, NOW, "h").decision, "analyze");
  assert.equal(decideGate(answers(0.95, 2), T, empty, NOW, "h").decision, "analyze");
});

test("high risk lowers the worth threshold", () => {
  const w = (T.worthMinHighRisk + T.worthMin) / 2;
  assert.equal(decideGate(answers(w, 2), T, empty, NOW, "h").reason, "low_worth");
  assert.equal(decideGate(answers(w, T.riskHigh), T, empty, NOW, "h").decision, "analyze");
});

test("gap flags at or above gapMin are listed, sorted by probability", () => {
  const d = decideGate(answers(0.9, 2, { multiple_context: 0.9, missing_specification: 0.8, missing_context: T.gapMin - 0.001 }), T, empty, NOW, "h");
  assert.deepEqual(d.flagged_gaps, ["multiple_context", "missing_specification"]);
  assert.deepEqual(d.top_gaps.map((g) => g.key), ["multiple_context", "missing_specification", "missing_context"]);
});

test("same prompt within the duplicate window is quiet", () => {
  const hist = { recentPrompts: [{ ts: NOW - 5000, hash: "same" }] };
  assert.equal(decideGate(answers(0.9, 2), T, hist, NOW, "same").reason, "duplicate");
  assert.equal(decideGate(answers(0.9, 2), T, hist, NOW + 20_000, "same").decision, "analyze");
});

test("hashPrompt normalises whitespace", () => {
  assert.equal(hashPrompt("a  b\n c"), hashPrompt("a b c"));
  assert.notEqual(hashPrompt("a"), hashPrompt("b"));
});
