import { test } from "node:test";
import assert from "node:assert/strict";
import { brainKind, codexBrainArgs, codexBrainPrompt } from "../src/brain/runner.js";
import { BRAIN_JSON_SCHEMA_STRICT } from "../src/brain/schema.js";
import { DEFAULT_THRESHOLDS, type Config } from "../src/shared/config.js";

const cfg: Config = {
  port: 1, bindExtra: [], allowedHosts: [], idleMinutes: 1, jevModel: "x", gateTimeoutMs: 1, gateFallback: "skip",
  brainTimeoutMs: 1, brainModel: "sonnet", brain: "auto", brainCodexModel: "gpt-5.6-luna", brainCodexReasoning: "low",
  brainClaudeEffort: "low", logLevel: "info", thresholds: DEFAULT_THRESHOLDS, fake: false, hasTypesafeKey: false,
};
const input = { prompt: "add auth", cwd: "/tmp/x", project: { dir_name: "x", languages: [], frameworks: [], has_tests: false, has_ci: false, git_branch: undefined, is_git_repo: false }, history: [] } as any;

test("brain follows the agent unless forced", () => {
  assert.equal(brainKind({ ...input, agent: "codex" }, cfg), "codex");
  assert.equal(brainKind({ ...input, agent: "claude" }, cfg), "claude");
  assert.equal(brainKind(input, cfg), "claude");
  assert.equal(brainKind({ ...input, agent: "codex" }, { ...cfg, brain: "claude" }), "claude");
  assert.equal(brainKind(input, { ...cfg, brain: "codex" }), "codex");
});

test("codex exec is read-only, ephemeral, hook-free, and reads the prompt from stdin", () => {
  const args = codexBrainArgs({ ...input, agent: "codex" }, cfg, "/s.json", "/o.json");
  assert.equal(args[0], "exec");
  assert.ok(args.includes("read-only") && args.includes("--ephemeral") && args.includes("--disable") && args.includes("hooks"));
  assert.deepEqual(args.slice(-1), ["-"]);
  assert.ok(args.includes("gpt-5.6-luna"));
  assert.ok(codexBrainPrompt(input).startsWith("<instructions>\n"));
});

test("strict schema requires every property and allows a null suggestion", () => {
  const item = BRAIN_JSON_SCHEMA_STRICT.properties.items.items;
  assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort());
  assert.deepEqual(item.properties.suggestion.type, ["string", "null"]);
});

import { claudeUsage, codexUsage, codexFinalMessage } from "../src/brain/runner.js";

test("claudeUsage folds cache tokens into input and keeps cost and turns", () => {
  const u = claudeUsage({ usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500 }, total_cost_usd: 0.0123, num_turns: 4 });
  assert.deepEqual(u, { input_tokens: 9600, output_tokens: 40, cached_input_tokens: 9500, cost_usd: 0.0123, turns: 4 });
  assert.equal(claudeUsage({ result: "x" }), undefined);
});

test("codexUsage reads the last turn.completed event; codexFinalMessage the last agent_message", () => {
  const jsonl = [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\\"language\\":\\"en\\"}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":11599,"cached_input_tokens":8960,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
    '{"type":"turn.compl',
  ].join("\n");
  assert.deepEqual(codexUsage(jsonl), { input_tokens: 11599, output_tokens: 5, cached_input_tokens: 8960 });
  assert.equal(codexFinalMessage(jsonl), '{"language":"en"}');
  assert.equal(codexUsage(""), undefined);
});
