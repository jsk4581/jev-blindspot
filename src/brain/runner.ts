// Spawn the brain headless on the user's own login. Two runners, chosen by the
// agent the prompt came from (or forced with JEV_BRAIN):
//   claude: `claude -p --effort low` (subscription auth). CLAUDE.md, user and project
//           settings load as in a normal session; `--tools Read,Grep,Glob` keeps it read-only.
//           Recursion is blocked by JEV_BLINDSPOT_CHILD=1 in the child env: the hook sees
//           it and exits (neither --safe-mode nor --restricted is used, both drop CLAUDE.md).
//   codex:  `codex exec` with a light model, read-only sandbox, hooks disabled, ephemeral;
//           AGENTS.md loads as usual.
// Both get the same prompt and the same JSON schema; wall-clock timeout replaces a turn limit.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Config } from "../shared/config.js";
import { PATHS } from "../shared/paths.js";
import type { BrainResult, BrainUsage } from "../shared/protocol.js";
import { buildUserPrompt, SYSTEM_PROMPT, type BrainInput } from "./prompt.js";
import { BRAIN_JSON_SCHEMA, BRAIN_JSON_SCHEMA_STRICT, parseBrainOutput } from "./schema.js";

export type BrainOutcome =
  | { ok: true; result: BrainResult; brain_ms: number; model: string; usage?: BrainUsage }
  | { ok: false; message: string; brain_ms: number; cancelled?: boolean };

export type BrainKind = "claude" | "codex";

const STDOUT_MAX = 2 * 1024 * 1024;
/** Read-only tools for the Claude brain; how much it reads is left to the effort level. */
export const CLAUDE_TOOLS = "Read,Grep,Glob";

/** Which runner a prompt gets: the forced one, else the agent it was typed into. */
export function brainKind(input: BrainInput, cfg: Config): BrainKind {
  if (cfg.brain === "claude" || cfg.brain === "codex") return cfg.brain;
  return input.agent === "codex" ? "codex" : "claude";
}

export function brainArgs(input: BrainInput, cfg: Config): string[] {
  return [
    "-p",
    buildUserPrompt(input),
    "--model",
    cfg.brainModel,
    "--effort",
    cfg.brainClaudeEffort,
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(BRAIN_JSON_SCHEMA),
    "--system-prompt",
    SYSTEM_PROMPT,
    "--tools",
    CLAUDE_TOOLS,
    "--allowedTools",
    CLAUDE_TOOLS,
    "--disallowedTools",
    "Bash,Edit,Write,MultiEdit,NotebookEdit,Task,Agent,WebFetch,WebSearch",
    "--permission-prompts",
    "none",
    "--strict-mcp-config",
    "--add-dir",
    input.cwd,
  ];
}

/** `codex exec` has no system-prompt flag: the instructions travel in the prompt (stdin). */
export function codexBrainPrompt(input: BrainInput): string {
  return `<instructions>\n${SYSTEM_PROMPT}\n</instructions>\n\n${buildUserPrompt(input)}`;
}

export function codexBrainArgs(input: BrainInput, cfg: Config, schemaFile: string, outFile: string): string[] {
  return [
    "exec",
    "-m",
    cfg.brainCodexModel,
    "-c",
    `model_reasoning_effort=${JSON.stringify(cfg.brainCodexReasoning)}`,
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--disable",
    "hooks",
    "--color",
    "never",
    "--json",
    "--output-schema",
    schemaFile,
    "-o",
    outFile,
    "-C",
    input.cwd,
    "-",
  ];
}

function brainTmpDir(): string {
  const dir = join(PATHS.stateDir, "brain");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function runBrain(input: BrainInput, cfg: Config, signal: AbortSignal): Promise<BrainOutcome> {
  const t0 = Date.now();
  if (cfg.fake) return fakeBrain(input, t0, signal);
  if (brainKind(input, cfg) === "codex") return runCodex(input, cfg, signal, t0);
  return runClaude(input, cfg, signal, t0);
}

interface ChildRun {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin?: string;
  /** Turn (stdout, exit code, stderr tail) into the outcome once the child exits. */
  collect: (stdout: string, code: number | null, errTail: string) => BrainOutcome;
}

function runChild(input: BrainInput, cfg: Config, signal: AbortSignal, t0: number, run: ChildRun): Promise<BrainOutcome> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    let child: ChildProcess;
    const finish = (o: BrainOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      resolve(o);
    };
    const kill = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* gone */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }, 5000).unref();
    };
    const killTimer = setTimeout(() => {
      kill();
      finish({ ok: false, message: `brain timeout after ${cfg.brainTimeoutMs}ms`, brain_ms: Date.now() - t0 });
    }, cfg.brainTimeoutMs);
    const onAbort = () => {
      kill();
      finish({ ok: false, message: "cancelled", brain_ms: Date.now() - t0, cancelled: true });
    };
    child = spawn(run.cmd, run.args, {
      cwd: input.cwd,
      env: run.env,
      stdio: [run.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    if (run.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        /* child exited early; close() reports it */
      });
      child.stdin.end(run.stdin);
    }
    child.stdout!.on("data", (b: Buffer) => {
      out += b.toString("utf8");
      if (out.length > STDOUT_MAX) {
        kill();
        finish({ ok: false, message: "brain output exceeded 2MB", brain_ms: Date.now() - t0 });
      }
    });
    child.stderr!.on("data", (b: Buffer) => {
      if (err.length < 8192) err += b.toString("utf8");
    });
    child.on("error", (e) => finish({ ok: false, message: `spawn failed: ${e.message}`, brain_ms: Date.now() - t0 }));
    child.on("close", (code) => {
      if (done) return;
      finish(run.collect(out, code, (err || out).trim().slice(-300)));
    });
  });
}

function runClaude(input: BrainInput, cfg: Config, signal: AbortSignal, t0: number): Promise<BrainOutcome> {
  return runChild(input, cfg, signal, t0, {
    cmd: "claude",
    args: brainArgs(input, cfg),
    env: { ...process.env, JEV_BLINDSPOT_CHILD: "1", MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS ?? "0" },
    collect: (out, code, tail) => {
      const brain_ms = Date.now() - t0;
      const parsed = parseBrainOutput(out);
      if (!parsed.ok) return { ok: false, message: `${parsed.message} (exit ${code})${tail ? ": " + tail : ""}`, brain_ms };
      let model = cfg.brainModel;
      let usage: BrainUsage | undefined;
      try {
        const env = JSON.parse(out);
        if (typeof env?.model === "string") model = env.model;
        usage = claudeUsage(env);
      } catch {
        /* keep alias */
      }
      return { ok: true, result: parsed.result, brain_ms, model, usage };
    },
  });
}

function runCodex(input: BrainInput, cfg: Config, signal: AbortSignal, t0: number): Promise<BrainOutcome> {
  const dir = brainTmpDir();
  const schemaFile = join(dir, "schema-strict.json");
  writeFileSync(schemaFile, JSON.stringify(BRAIN_JSON_SCHEMA_STRICT));
  const outFile = join(dir, `codex-${randomUUID()}.json`);
  return runChild(input, cfg, signal, t0, {
    cmd: "codex",
    args: codexBrainArgs(input, cfg, schemaFile, outFile),
    env: { ...process.env, JEV_BLINDSPOT_CHILD: "1" },
    stdin: codexBrainPrompt(input),
    collect: (out, code, tail) => {
      const brain_ms = Date.now() - t0;
      let text = "";
      try {
        text = readFileSync(outFile, "utf8");
      } catch {
        /* no final message */
      }
      try {
        unlinkSync(outFile);
      } catch {
        /* already gone */
      }
      const parsed = parseBrainOutput(text || codexFinalMessage(out));
      if (!parsed.ok) return { ok: false, message: `${parsed.message} (exit ${code})${tail ? ": " + tail : ""}`, brain_ms };
      return { ok: true, result: parsed.result, brain_ms, model: cfg.brainCodexModel, usage: codexUsage(out) };
    },
  });
}

/** `claude -p --output-format json` envelope: usage counts plus total_cost_usd and num_turns. */
export function claudeUsage(env: any): BrainUsage | undefined {
  const u = env?.usage;
  if (!u || typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") return undefined;
  const cached = (typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0) + (typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0);
  const usage: BrainUsage = { input_tokens: u.input_tokens + cached, output_tokens: u.output_tokens };
  if (cached > 0) usage.cached_input_tokens = cached;
  if (typeof env.total_cost_usd === "number") usage.cost_usd = env.total_cost_usd;
  if (typeof env.num_turns === "number") usage.turns = env.num_turns;
  return usage;
}

/** `codex exec --json` prints JSONL events; `turn.completed` carries the usage of the run. */
export function codexUsage(jsonl: string): BrainUsage | undefined {
  let usage: BrainUsage | undefined;
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"turn.completed"')) continue;
    try {
      const e = JSON.parse(line);
      const u = e?.usage;
      if (e?.type !== "turn.completed" || typeof u?.input_tokens !== "number" || typeof u?.output_tokens !== "number") continue;
      usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens };
      if (typeof u.cached_input_tokens === "number" && u.cached_input_tokens > 0) usage.cached_input_tokens = u.cached_input_tokens;
    } catch {
      /* partial line */
    }
  }
  return usage;
}

/** Fallback when `-o` wrote nothing: the last agent_message item in the JSONL stream. */
export function codexFinalMessage(jsonl: string): string {
  let text = "";
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"agent_message"')) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string") text = e.item.text;
    } catch {
      /* partial line */
    }
  }
  return text;
}

function fakeBrain(input: BrainInput, t0: number, signal: AbortSignal): Promise<BrainOutcome> {
  return new Promise((resolve) => {
    const ko = /[가-힣]/.test(input.prompt);
    const timer = setTimeout(() => {
      resolve({
        ok: true,
        brain_ms: Date.now() - t0,
        model: "fake",
        usage: { input_tokens: 12000, output_tokens: 400, cached_input_tokens: 9000, turns: 3 },
        result: {
          language: ko ? "ko" : "en",
          domains: ko ? ["백엔드 설계", "UX"] : ["backend design", "UX"],
          items: [
            {
              title: ko ? "성공 기준이 정해지지 않음" : "No success criteria stated",
              why: ko ? "무엇이 되면 끝인지 없으면 결과를 검수할 기준이 없다." : "Without a definition of done there is nothing to check the result against.",
              suggestion: ko ? "\"다음 세 가지가 동작하면 완료: ...\"" : '"Done when these three things work: ..."',
              domain: ko ? "요청 설계" : "request design",
              severity: "worth-asking",
              confidence: 0.8,
            },
            {
              title: ko ? "영향 범위가 명시되지 않음" : "Scope of change not bounded",
              why: ko ? "어디까지 건드려도 되는지 없으면 예상 밖의 파일이 바뀐다." : "Without a boundary, files you did not expect get changed.",
              domain: ko ? "요청 설계" : "request design",
              severity: "note",
              confidence: 0.6,
            },
          ],
        },
      });
    }, 1500);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve({ ok: false, message: "cancelled", brain_ms: Date.now() - t0, cancelled: true });
      },
      { once: true },
    );
  });
}
