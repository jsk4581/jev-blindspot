// Runtime configuration: ~/.config/jev-blindspot/env (KEY=VALUE lines) with
// process.env taking precedence. Keys never leave this module except via
// getters that need them (the jev client reads TYPESAFE_API_KEY itself).
import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "./paths.js";

export interface Config {
  port: number;
  bindExtra: string[];
  allowedHosts: string[];
  token?: string;
  idleMinutes: number;
  jevModel: string;
  gateTimeoutMs: number;
  gateFallback: "skip" | "brain";
  brainTimeoutMs: number;
  brainModel: string;
  /** which runner: auto follows the agent the prompt came from */
  brain: "auto" | "claude" | "codex";
  /** model passed to `codex exec -m` for prompts that came from Codex */
  brainCodexModel: string;
  brainCodexReasoning: string;
  /** `claude -p --effort`; the only brake on how much the Claude brain reads */
  brainClaudeEffort: string;
  logLevel: "debug" | "info" | "warn" | "error";
  thresholds: Thresholds;
  /** M1 plumbing mode: stub gate and brain, no network. */
  fake: boolean;
  hasTypesafeKey: boolean;
  configFileMode?: number;
}

export interface Thresholds {
  worthMin: number;
  worthMinHighRisk: number;
  gapMin: number;
  riskHigh: number;
  duplicateWindowMs: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  worthMin: 0.65,
  worthMinHighRisk: 0.45,
  gapMin: 0.7,
  riskHigh: 3.5,
  duplicateWindowMs: 10_000,
};

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

let cached: Config | undefined;

/** Load once per process; the env file is applied into process.env so the
 *  jev SDK (which reads TYPESAFE_API_KEY itself) sees it too. */
export function loadConfig(): Config {
  if (cached) return cached;
  const file = parseEnvFile(PATHS.configFile);
  for (const [k, v] of Object.entries(file)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  cached = build();
  return cached;
}

/** Keys the panel may change at runtime, with their accepted values. */
export const EDITABLE_KEYS: Record<string, (v: string) => boolean> = {
  JEV_BRAIN: (v) => ["auto", "claude", "codex"].includes(v),
  JEV_BRAIN_MODEL: (v) => /^[\w.:-]{1,64}$/.test(v),
  JEV_BRAIN_CODEX_MODEL: (v) => /^[\w.:-]{1,64}$/.test(v),
  JEV_BRAIN_CODEX_REASONING: (v) => ["minimal", "low", "medium", "high", "xhigh"].includes(v),
  JEV_BRAIN_CLAUDE_EFFORT: (v) => ["low", "medium", "high"].includes(v),
  JEV_MODEL: (v) => /^[\w.:-]{1,64}$/.test(v),
};

/** Replace or append KEY=VALUE lines, keeping comments and unrelated lines. */
export function upsertEnvLines(text: string, patch: Record<string, string>): string {
  const lines = text.length ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const pending = new Map(Object.entries(patch));
  const out = lines.map((raw) => {
    const t = raw.trim();
    if (!t || t.startsWith("#")) return raw;
    const eq = t.indexOf("=");
    if (eq <= 0) return raw;
    const key = t.slice(0, eq).trim();
    if (!pending.has(key)) return raw;
    const v = pending.get(key)!;
    pending.delete(key);
    return `${key}=${v}`;
  });
  for (const [k, v] of pending) out.push(`${k}=${v}`);
  return out.join("\n") + "\n";
}

/** Apply validated runtime changes: process.env, the env file (0600), and the
 *  cached Config object in place so every holder sees the new values. */
export function updateConfig(patch: Record<string, string>): { applied: Record<string, string>; rejected: string[] } {
  const applied: Record<string, string> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const ok = EDITABLE_KEYS[k];
    if (!ok || typeof v !== "string" || !ok(v.trim())) rejected.push(k);
    else applied[k] = v.trim();
  }
  if (Object.keys(applied).length) {
    for (const [k, v] of Object.entries(applied)) process.env[k] = v;
    mkdirSync(dirname(PATHS.configFile), { recursive: true, mode: 0o700 });
    const current = existsSync(PATHS.configFile) ? readFileSync(PATHS.configFile, "utf8") : "";
    writeFileSync(PATHS.configFile, upsertEnvLines(current, applied), { mode: 0o600 });
    const fresh = build();
    if (cached) Object.assign(cached, fresh);
    else cached = fresh;
  }
  return { applied, rejected };
}

/** The editable subset, for the panel. */
export function editableConfig(cfg: Config): Record<string, string> {
  return {
    JEV_BRAIN: cfg.brain,
    JEV_BRAIN_MODEL: cfg.brainModel,
    JEV_BRAIN_CODEX_MODEL: cfg.brainCodexModel,
    JEV_BRAIN_CODEX_REASONING: cfg.brainCodexReasoning,
    JEV_BRAIN_CLAUDE_EFFORT: cfg.brainClaudeEffort,
    JEV_MODEL: cfg.jevModel,
  };
}

function build(): Config {
  const env = process.env;
  const num = (k: string, d: number) => {
    const v = env[k];
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const list = (k: string, d: string[]) =>
    env[k] !== undefined ? env[k]!.split(",").map((s) => s.trim()).filter(Boolean) : d;

  let mode: number | undefined;
  try {
    mode = statSync(PATHS.configFile).mode & 0o777;
  } catch {
    /* no file */
  }

  return {
    port: num("JEV_PORT", 7461),
    bindExtra: list("JEV_BIND_EXTRA", []),
    allowedHosts: list("JEV_ALLOWED_HOSTS", []),
    token: env.JEV_TOKEN || undefined,
    idleMinutes: num("JEV_IDLE_MINUTES", 30),
    jevModel: env.JEV_MODEL || "jev-1.13.0",
    gateTimeoutMs: num("JEV_GATE_TIMEOUT_MS", 2000),
    gateFallback: env.JEV_GATE_FALLBACK === "brain" ? "brain" : "skip",
    brainTimeoutMs: num("JEV_BRAIN_TIMEOUT_MS", 90_000),
    brainModel: env.JEV_BRAIN_MODEL || "sonnet",
    brain: env.JEV_BRAIN === "claude" || env.JEV_BRAIN === "codex" ? env.JEV_BRAIN : "auto",
    brainCodexModel: env.JEV_BRAIN_CODEX_MODEL || "gpt-5.6-luna",
    brainCodexReasoning: env.JEV_BRAIN_CODEX_REASONING || "low",
    brainClaudeEffort: env.JEV_BRAIN_CLAUDE_EFFORT || "low",
    logLevel: (["debug", "info", "warn", "error"].includes(env.JEV_LOG_LEVEL || "")
      ? env.JEV_LOG_LEVEL
      : "info") as Config["logLevel"],
    thresholds: {
      worthMin: num("JEV_WORTH_MIN", DEFAULT_THRESHOLDS.worthMin),
      worthMinHighRisk: num("JEV_WORTH_MIN_HIGH_RISK", DEFAULT_THRESHOLDS.worthMinHighRisk),
      gapMin: num("JEV_GAP_MIN", DEFAULT_THRESHOLDS.gapMin),
      riskHigh: num("JEV_RISK_HIGH", DEFAULT_THRESHOLDS.riskHigh),
      duplicateWindowMs: DEFAULT_THRESHOLDS.duplicateWindowMs,
    },
    fake: env.JEV_FAKE === "1",
    hasTypesafeKey: Boolean(env.TYPESAFE_API_KEY),
    configFileMode: mode,
  };
}
