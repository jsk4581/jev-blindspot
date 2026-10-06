#!/usr/bin/env node
// Measures what the Claude brain costs per analyzed prompt.
//
//   node scripts/bench-brain.mjs [passes=2] [out=bench-brain.jsonl] [--plan]
//
// BENCH_REPO=<dir> runs the brain against another checkout (for example a fresh
// clone, without your private CLAUDE.md); CLAUDE_CONFIG_DIR is passed through, so
// an empty config dir measures Claude Code without your skills, memory and hooks.
//
// Runs every prompt in scripts/bench-prompts.json through the real brain
// (`claude -p`, the same arguments the daemon uses) against this repository,
// `passes` times, one at a time. For each run it records the turns, the size of
// the first and the largest request, the input split into uncached / cache read
// / cache write (by TTL), the output, thinking tokens, time and the cost Claude
// Code reports. With --plan it also reads the subscription usage meter between
// runs. Needs `npm run build` first.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { brainArgs } = await import(join(root, "dist/src/brain/runner.js"));
const { loadConfig } = await import(join(root, "dist/src/shared/config.js"));
const { detectRepoContext } = await import(join(root, "dist/src/context/repo.js"));

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const PASSES = Number(args[0] || 2);
const OUT = args[1] || "bench-brain.jsonl";
const PLAN = process.argv.includes("--plan");
const PLAN_EVERY = 4;
const prompts = JSON.parse(readFileSync(join(root, "scripts/bench-prompts.json"), "utf8"));
const cfg = loadConfig();
const target = resolve(process.env.BENCH_REPO || root);
const project = detectRepoContext(target);

const log = (o) => {
  const rec = { at: new Date().toISOString(), ...o };
  appendFileSync(OUT, JSON.stringify(rec) + "\n");
  console.log(JSON.stringify(rec));
};

/** The subscription meter, as /usage shows it (whole percents). */
async function plan() {
  try {
    const creds = JSON.parse(readFileSync(join(homedir(), ".claude/.credentials.json"), "utf8"));
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${creds.claudeAiOauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    const j = await res.json();
    return { five_hour: j.five_hour?.utilization, seven_day: j.seven_day?.utilization };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

function run(input) {
  return new Promise((done) => {
    const t0 = Date.now();
    let out = "";
    const child = spawn("claude", brainArgs(input, cfg), {
      cwd: target,
      env: { ...process.env, JEV_BLINDSPOT_CHILD: "1", MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS ?? "0" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), cfg.brainTimeoutMs);
    child.stdout.on("data", (b) => (out += b));
    child.on("close", (code) => {
      clearTimeout(timer);
      const requests = new Map();
      let result;
      for (const line of out.split("\n")) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type === "result") result = e;
        const u = e.type === "assistant" ? e.message?.usage : undefined;
        if (u) requests.set(e.message.id, u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
      }
      const sizes = [...requests.values()];
      const u = result?.usage ?? {};
      done({
        ok: !!result && !result.is_error,
        exit: code,
        ms: Date.now() - t0,
        turns: result?.num_turns,
        requests: sizes.length,
        first_context: sizes[0],
        peak_context: sizes.length ? Math.max(...sizes) : undefined,
        uncached: u.input_tokens,
        cache_read: u.cache_read_input_tokens,
        cache_write_5m: u.cache_creation?.ephemeral_5m_input_tokens,
        cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens,
        cache_write: u.cache_creation_input_tokens,
        output: u.output_tokens,
        thinking: u.output_tokens_details?.thinking_tokens,
        cost_usd: result?.total_cost_usd,
        items: result?.structured_output?.items?.length,
        deeper: result?.structured_output?.deeper?.length,
      });
    });
  });
}

log({ kind: "start", target, config_dir: process.env.CLAUDE_CONFIG_DIR ?? "default", passes: PASSES, prompts: prompts.length, model: cfg.brainModel, effort: cfg.brainClaudeEffort, ...(PLAN ? await plan() : {}) });
let n = 0;
for (let pass = 1; pass <= PASSES; pass++) {
  for (const [i, p] of prompts.entries()) {
    const input = { prompt: p.prompt, cwd: target, project, history: p.history ?? [], agent: "claude" };
    log({ kind: "run", pass, i, history: (p.history ?? []).length, ...(await run(input)) });
    n++;
    if (PLAN && n % PLAN_EVERY === 0) log({ kind: "plan", n, ...(await plan()) });
  }
}
if (PLAN && n % PLAN_EVERY !== 0) log({ kind: "plan", n, ...(await plan()) });
