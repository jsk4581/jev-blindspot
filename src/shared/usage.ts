// Usage ledger: one JSON line per gate decision and per brain run, in
// ~/.local/share/jev-blindspot/usage.jsonl. It carries no prompt text and is not
// pruned with the session files, so `jev-blindspot usage` can add up any period.
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS, ensureDir } from "./paths.js";
import type { Agent, BrainUsage, TurnState } from "./protocol.js";

export const USAGE_VERSION = 1;

export type UsageRecord =
  | { v: number; kind: "gate"; ts: number; turn_id: string; agent?: Agent; state: TurnState }
  | { v: number; kind: "brain"; ts: number; turn_id: string; agent?: Agent; model?: string; ok: boolean; brain_ms: number; usage?: BrainUsage };

export function appendUsage(rec: UsageRecord, file = PATHS.usageLog): void {
  try {
    ensureDir(PATHS.dataDir);
    appendFileSync(file, JSON.stringify(rec) + "\n", { mode: 0o600 });
  } catch {
    /* accounting never breaks the pipeline */
  }
}

export function readUsage(file = PATHS.usageLog): UsageRecord[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && (r.kind === "gate" || r.kind === "brain") && typeof r.ts === "number") out.push(r);
    } catch {
      /* torn line */
    }
  }
  return out;
}

/** Build the ledger from the session files still on disk, once, when it does not exist yet. */
export function seedUsage(sessionsDir = PATHS.sessionsDir, file = PATHS.usageLog): number {
  if (existsSync(file)) return 0;
  const recs: UsageRecord[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    /* no sessions yet */
  }
  for (const name of names) {
    const agents = new Map<string, Agent | undefined>();
    let text = "";
    try {
      text = readFileSync(join(sessionsDir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      let r: any;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      const agent = agents.get(r?.turn_id);
      if (r?.kind === "prompt") agents.set(r.turn_id, r.agent);
      else if (r?.kind === "gate") recs.push({ v: USAGE_VERSION, kind: "gate", ts: r.ts, turn_id: r.turn_id, agent, state: r.state });
      else if (r?.kind === "brain") recs.push({ v: USAGE_VERSION, kind: "brain", ts: r.ts, turn_id: r.turn_id, agent, model: r.model, ok: true, brain_ms: r.brain_ms, usage: r.usage });
      else if (r?.kind === "error" && r.stage === "brain") recs.push({ v: USAGE_VERSION, kind: "brain", ts: r.ts, turn_id: r.turn_id, agent, ok: false, brain_ms: 0 });
    }
  }
  recs.sort((a, b) => a.ts - b.ts);
  try {
    ensureDir(PATHS.dataDir);
    writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + (recs.length ? "\n" : ""), { mode: 0o600 });
  } catch {
    return 0;
  }
  return recs.length;
}

export interface UsageSummary {
  from: number;
  to: number;
  prompts: number;
  by_agent: Record<string, number>;
  brain_runs: number;
  brain_failed: number;
  pass_rate?: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  context_median?: number;
  context_max?: number;
  cost_usd: number;
  /** runs that reported a cost (Claude); Codex runs report none */
  cost_runs: number;
  cost_median?: number;
  cost_per_prompt?: number;
  /** cost / planUsdPerPercent: how much of one 5-hour window the period used in total */
  plan_percent?: number;
}

export function summarizeUsage(recs: UsageRecord[], from: number, to: number, planUsdPerPercent?: number): UsageSummary {
  const s: UsageSummary = {
    from, to, prompts: 0, by_agent: {}, brain_runs: 0, brain_failed: 0,
    input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, cost_usd: 0, cost_runs: 0,
  };
  const contexts: number[] = [];
  const costs: number[] = [];
  const seen = new Set<string>();
  for (const r of recs) {
    if (r.ts < from || r.ts > to) continue;
    if (r.kind === "gate") {
      // one prompt, one count, however many gate lines it got
      if (seen.has(r.turn_id)) continue;
      seen.add(r.turn_id);
      s.prompts++;
      const a = r.agent ?? "claude";
      s.by_agent[a] = (s.by_agent[a] ?? 0) + 1;
      continue;
    }
    s.brain_runs++;
    if (!r.ok) s.brain_failed++;
    const u = r.usage;
    if (!u) continue;
    s.input_tokens += u.input_tokens;
    s.output_tokens += u.output_tokens;
    s.cache_read_tokens += u.cached_input_tokens ?? 0;
    s.cache_write_tokens += u.cache_write_tokens ?? 0;
    if (u.context_tokens) contexts.push(u.context_tokens);
    if (typeof u.cost_usd === "number") {
      s.cost_usd += u.cost_usd;
      s.cost_runs++;
      costs.push(u.cost_usd);
    }
  }
  if (s.prompts) s.pass_rate = s.brain_runs / s.prompts;
  if (contexts.length) {
    s.context_median = median(contexts);
    s.context_max = Math.max(...contexts);
  }
  if (costs.length) s.cost_median = median(costs);
  if (s.prompts && s.cost_runs) s.cost_per_prompt = s.cost_usd / s.prompts;
  if (planUsdPerPercent && s.cost_runs) s.plan_percent = s.cost_usd / planUsdPerPercent;
  return s;
}

function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
