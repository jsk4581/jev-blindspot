import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan, readGitBranch } from "../src/context/repo.js";
import { buildGateState } from "../src/gate/state.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "jev-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "1", express: "1" }, devDependencies: { typescript: "5" } }));
  mkdirSync(join(dir, "tests"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "on: push");
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feat/x\n");
  return dir;
}

test("scan detects languages, frameworks, tests, ci, branch", () => {
  const ctx = scan(repo());
  assert.deepEqual(ctx.languages.sort(), ["typescript"]);
  assert.deepEqual(ctx.frameworks.sort(), ["express", "react"]);
  assert.equal(ctx.has_tests, true);
  assert.equal(ctx.has_ci, true);
  assert.equal(ctx.git_branch, "feat/x");
});

test("detached HEAD yields a short sha; worktree gitdir file is followed", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  assert.equal(readGitBranch(dir), "0123456789ab");
  const wt = mkdtempSync(join(tmpdir(), "jev-wt-"));
  mkdirSync(join(wt, "real"));
  writeFileSync(join(wt, "real", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(wt, ".git"), "gitdir: real\n");
  assert.equal(readGitBranch(wt), "main");
});

test("buildGateState truncates the prompt to 6000 chars", () => {
  const s = buildGateState({ prompt: "a".repeat(7000), cwd: repo() });
  assert.equal(s.prompt.length, 6000);
  assert.deepEqual(s.history, []);
});

import { upsertEnvLines } from "../src/shared/config.js";

test("upsertEnvLines replaces keys in place, keeps comments, appends new keys", () => {
  const before = "# gate\nTYPESAFE_API_KEY=abc\nJEV_BRAIN=auto   \n\nJEV_PORT=7461\n";
  const after = upsertEnvLines(before, { JEV_BRAIN: "codex", JEV_BRAIN_CODEX_MODEL: "gpt-5.6-luna" });
  assert.equal(after, "# gate\nTYPESAFE_API_KEY=abc\nJEV_BRAIN=codex\n\nJEV_PORT=7461\nJEV_BRAIN_CODEX_MODEL=gpt-5.6-luna\n");
  assert.equal(upsertEnvLines("", { A: "1" }), "A=1\n");
});
