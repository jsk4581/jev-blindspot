import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUsage, seedUsage, summarizeUsage, type UsageRecord } from "../src/shared/usage.js";
import { claudeStream } from "../src/brain/runner.js";

const brain = (ts: number, cost: number, ctx: number, ok = true): UsageRecord => ({
  v: 1, kind: "brain", ts, turn_id: `b${ts}`, agent: "claude", model: "sonnet", ok, brain_ms: 1000,
  usage: { input_tokens: 40000, output_tokens: 1000, cached_input_tokens: 30000, cache_write_tokens: 9000, context_tokens: ctx, cost_usd: cost, turns: 4 },
});

test("summarizeUsage counts prompts once, sums tokens, and converts cost to plan share", () => {
  const recs: UsageRecord[] = [
    { v: 1, kind: "gate", ts: 1, turn_id: "a", agent: "claude", state: "quiet" },
    { v: 1, kind: "gate", ts: 2, turn_id: "b", agent: "codex", state: "analyzing" },
    { v: 1, kind: "gate", ts: 3, turn_id: "c", agent: "claude", state: "analyzing" },
    { v: 1, kind: "gate", ts: 3, turn_id: "c", agent: "claude", state: "analyzing" },
    brain(4, 0.06, 15000),
    brain(5, 0.08, 17000, false),
    brain(99, 1, 1), // outside the period
  ];
  const s = summarizeUsage(recs, 0, 10, 0.5);
  assert.equal(s.prompts, 3);
  assert.deepEqual(s.by_agent, { claude: 2, codex: 1 });
  assert.equal(s.brain_runs, 2);
  assert.equal(s.brain_failed, 1);
  assert.equal(s.input_tokens, 80000);
  assert.equal(s.cache_write_tokens, 18000);
  assert.equal(s.context_median, 16000);
  assert.ok(Math.abs(s.cost_usd - 0.14) < 1e-9);
  assert.ok(Math.abs(s.plan_percent! - 0.28) < 1e-9);
  assert.equal(summarizeUsage(recs, 0, 10).plan_percent, undefined);
});

test("seedUsage builds the ledger from session files once", () => {
  const dir = mkdtempSync(join(tmpdir(), "jbs-usage-"));
  const sessions = join(dir, "sessions");
  const ledger = join(dir, "usage.jsonl");
  mkdirSync(sessions);
  writeFileSync(join(sessions, "s.jsonl"), [
    { kind: "prompt", turn_id: "t1", ts: 1, agent: "codex", prompt: "secret prompt" },
    { kind: "gate", turn_id: "t1", ts: 2, state: "analyzing" },
    { kind: "brain", turn_id: "t1", ts: 3, model: "m", brain_ms: 9, usage: { input_tokens: 5, output_tokens: 1 } },
    { kind: "error", turn_id: "t1", ts: 4, stage: "brain", message: "x" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(seedUsage(sessions, ledger), 3);
  assert.equal(seedUsage(sessions, ledger), 0, "never overwrites an existing ledger");
  const recs = readUsage(ledger);
  assert.equal(recs.length, 3);
  assert.equal(recs[0].agent, "codex");
  assert.ok(!readFileSync(ledger, "utf8").includes("secret"), "no prompt text in the ledger");
});

test("claudeStream sums a run cut short before its result event", () => {
  const out = [
    '{"type":"assistant","message":{"id":"a","usage":{"input_tokens":2,"cache_read_input_tokens":4000,"cache_creation_input_tokens":10000,"output_tokens":10}}}',
    '{"type":"assistant","message":{"id":"a","usage":{"input_tokens":2,"cache_read_input_tokens":4000,"cache_creation_input_tokens":10000,"output_tokens":30}}}',
    '{"type":"assistant","message":{"id":"b","usage":{"input_tokens":2,"cache_read_input_tokens":14000,"cache_creation_input_tokens":500,"output_tokens":20}}}',
  ].join("\n");
  const { envelope, partial } = claudeStream(out);
  assert.equal(envelope, undefined);
  assert.deepEqual(partial, { input_tokens: 28504, output_tokens: 50, cached_input_tokens: 18000, cache_write_tokens: 10500, context_tokens: 14502 });
});
