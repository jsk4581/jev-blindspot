import { test } from "node:test";
import assert from "node:assert/strict";
import { codexHookHash, codexStateKey, codexTrustToml } from "../src/cli/codex-trust.js";

// Expected values come from the same recipe run against three real entries Codex 0.144 had
// written to config.toml (all three matched); this fixture pins the recipe.
test("hashes a command handler the way Codex records trust", () => {
  const group = { hooks: [{ type: "command", command: "node /opt/hook.mjs --agent codex", timeout: 5, statusMessage: "jev-blindspot" }] };
  assert.equal(
    codexHookHash("user_prompt_submit", group, group.hooks[0]),
    "sha256:12bc53180dcd066306efdfa07707c3723bf644c0f3e107b156a3e5b3ee702971",
  );
});

test("timeout defaults to 600 and async to false; matcher is included only when set", () => {
  const a = codexHookHash("user_prompt_submit", { hooks: [] }, { command: "x" });
  const b = codexHookHash("user_prompt_submit", { hooks: [] }, { command: "x", timeout: 600, async: false });
  assert.equal(a, b);
  const c = codexHookHash("user_prompt_submit", { matcher: "foo", hooks: [] }, { command: "x" });
  assert.notEqual(a, c);
});

test("state key and toml fragment", () => {
  const key = codexStateKey("/home/u/.codex/hooks.json", "user_prompt_submit", 1, 0);
  assert.equal(key, "/home/u/.codex/hooks.json:user_prompt_submit:1:0");
  assert.equal(codexTrustToml(key, "sha256:abc"), '\n[hooks.state."/home/u/.codex/hooks.json:user_prompt_submit:1:0"]\ntrusted_hash = "sha256:abc"\n');
});
