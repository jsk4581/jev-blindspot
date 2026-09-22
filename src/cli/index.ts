// CLI: start | stop | status | open | gate <prompt> | fixtures | install-hook | smoke
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync, appendFileSync, mkdirSync } from "node:fs";
import { codexHookHash, codexStateKey, codexTrustToml } from "./codex-trust.js";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../shared/config.js";
import { PATHS } from "../shared/paths.js";
import { runGate } from "../gate/client.js";
import { buildGateState } from "../gate/state.js";
import { decideGate, hashPrompt } from "../gate/thresholds.js";
import { healthy, readPid, pidAlive } from "../daemon/singleton.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const daemonEntry = join(root, "dist", "src", "daemon", "index.js");
const hookPath = join(root, "bin", "jev-blindspot-hook.mjs");

const [, , cmd = "status", ...rest] = process.argv;
const cfg = loadConfig();

function http(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      { host: "127.0.0.1", port: cfg.port, path, method, timeout: 5000, headers: data ? { "content-type": "application/json", "content-length": data.length } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: text });
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end(data);
  });
}

async function start(): Promise<void> {
  if (await healthy(cfg.port)) {
    console.log(`daemon already running (pid ${readPid()}) at http://127.0.0.1:${cfg.port}/`);
    return;
  }
  const child = spawn(process.execPath, [daemonEntry], { detached: true, stdio: "ignore", cwd: homedir(), env: { ...process.env, JEV_BLINDSPOT_DAEMON: "1" } });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await healthy(cfg.port)) {
      console.log(`daemon started (pid ${readPid()}), panel: ${panelUrl()}`);
      return;
    }
  }
  console.error(`daemon did not come up; see ${PATHS.daemonLog}`);
  process.exitCode = 1;
}

function panelUrl(): string {
  const host = cfg.bindExtra[0] ?? "127.0.0.1";
  return `http://${host}:${cfg.port}/`;
}

async function stop(): Promise<void> {
  try {
    await http("POST", "/api/shutdown");
    console.log("daemon stopping");
  } catch {
    const pid = readPid();
    if (pid && pidAlive(pid)) {
      process.kill(pid, "SIGTERM");
      console.log(`sent SIGTERM to ${pid}`);
    } else console.log("daemon not running");
  }
}

async function status(): Promise<void> {
  const up = await healthy(cfg.port);
  console.log(`daemon: ${up ? "up" : "down"}${up ? ` (pid ${readPid()})` : ""}`);
  console.log(`panel:  ${panelUrl()}`);
  console.log(`gate:   ${cfg.fake ? "FAKE (JEV_FAKE=1)" : cfg.hasTypesafeKey ? `jev ${cfg.jevModel}` : "no TYPESAFE_API_KEY (gate_unavailable)"}`);
  console.log(`brain:  ${cfg.fake ? "FAKE" : `claude -p --model ${cfg.brainModel} --effort ${cfg.brainClaudeEffort} | codex exec -m ${cfg.brainCodexModel} (${cfg.brain === "auto" ? "by agent" : "forced " + cfg.brain})`}`);
  console.log(`config: ${PATHS.configFile}${existsSync(PATHS.configFile) ? "" : " (missing)"}`);
  if (cfg.configFileMode !== undefined && (cfg.configFileMode & 0o077) !== 0) console.log(`warn:   config file mode ${cfg.configFileMode.toString(8)}; run chmod 600 ${PATHS.configFile}`);
  const agents = detectedAgents();
  console.log(`hooks:  ${agents.length ? agents.map((a) => `${a} ${hookInstalled(a) ? "installed" : "not installed"}`).join(", ") : "no agent found"} (jev-blindspot install-hook [claude|codex|all])`);
  if (up) {
    const h = await http("GET", "/health");
    console.log(`stats:  ${JSON.stringify(h.json?.stats)}`);
    console.log(`sse clients: ${h.json?.sse_clients}, sessions: ${h.json?.sessions}, brains: ${h.json?.brain_running}`);
  }
}

type Agent = "claude" | "codex";

/** Each agent's hook registry: a JSON file with `hooks.UserPromptSubmit[]` groups.
 *  Claude Code: ~/.claude/settings.json. Codex CLI: ~/.codex/hooks.json (same group shape). */
const AGENT_FILES: Record<Agent, { file: string; dir: string; command: string; commandFile: string; commandText: string }> = {
  claude: {
    file: join(homedir(), ".claude", "settings.json"),
    dir: join(homedir(), ".claude"),
    command: `node ${hookPath}`,
    commandFile: join(homedir(), ".claude", "commands", "blindspot.md"),
    commandText: "---\ndescription: Show the jev-blindspot panel URL (answered by the hook, no model turn)\nargument-hint: \"[status]\"\n---\nThe jev-blindspot hook did not intercept this command, so it is not installed or not active in this session. Tell the user to run `jev-blindspot status` in a terminal.\n",
  },
  codex: {
    file: join(homedir(), ".codex", "hooks.json"),
    dir: join(homedir(), ".codex"),
    command: `node ${hookPath} --agent codex`,
    commandFile: join(homedir(), ".codex", "prompts", "blindspot.md"),
    commandText: "---\ndescription: Show the jev-blindspot panel URL (answered by the hook, no model turn)\nargument-hint: \"[status]\"\n---\nThe jev-blindspot hook did not intercept this command, so it is not installed or not trusted. Tell the user to run `jev-blindspot status` in a terminal.\n",
  },
};

/** `/blindspot` (Claude Code) and `/prompts:blindspot` (Codex) exist as commands so they
 *  autocomplete; the hook answers them before any model turn. */
function installCommandFile(agent: Agent): void {
  const f = AGENT_FILES[agent].commandFile;
  if (existsSync(f)) return;
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, AGENT_FILES[agent].commandText);
  console.log(`${agent}: command file written to ${f}`);
}

function settingsPath(agent: Agent = "claude"): string {
  return AGENT_FILES[agent].file;
}

/** Agents that have a config directory on this machine. */
function detectedAgents(): Agent[] {
  return (Object.keys(AGENT_FILES) as Agent[]).filter((a) => existsSync(AGENT_FILES[a].dir));
}

function hookInstalled(agent: Agent = "claude"): boolean {
  try {
    const s = JSON.parse(readFileSync(settingsPath(agent), "utf8"));
    const groups: any[] = s?.hooks?.UserPromptSubmit ?? [];
    return groups.some((g) => (g.hooks ?? []).some((h: any) => typeof h.command === "string" && h.command.includes("jev-blindspot-hook.mjs")));
  } catch {
    return false;
  }
}

function installHook(args: string[]): void {
  const trust = args.includes("--trust");
  const arg = args.find((a) => !a.startsWith("--"));
  const agents: Agent[] = arg === "all" ? detectedAgents() : arg === "claude" || arg === "codex" ? [arg] : detectedAgents();
  if (!agents.length) {
    console.error("no agent config directory found (~/.claude or ~/.codex); pass claude or codex explicitly");
    process.exitCode = 1;
    return;
  }
  for (const a of agents) installHookFor(a, trust);
}

function installHookFor(agent: Agent, trust: boolean): void {
  installCommandFile(agent);
  const p = settingsPath(agent);
  const raw = existsSync(p) ? readFileSync(p, "utf8") : "{}";
  const s = JSON.parse(raw);
  if (hookInstalled(agent)) {
    console.log(`${agent}: hook already installed (${p})`);
    if (agent === "codex") codexTrustStep(s, trust);
    return;
  }
  const backup = `${p}.bak-${Date.now()}`;
  if (existsSync(p)) copyFileSync(p, backup);
  s.hooks ??= {};
  s.hooks.UserPromptSubmit ??= [];
  s.hooks.UserPromptSubmit.push({
    hooks: [{ type: "command", command: AGENT_FILES[agent].command, timeout: 5, statusMessage: "jev-blindspot" }],
  });
  const text = JSON.stringify(s, null, 2) + "\n";
  JSON.parse(text); // re-validate before writing
  writeFileSync(p, text);
  console.log(`${agent}: hook added to ${p}${existsSync(backup) ? ` (backup: ${backup})` : ""}`);
  if (agent === "codex") codexTrustStep(s, trust);
}

/** Codex skips a new hook until it is trusted. Default: say so and leave the review to `/hooks`.
 *  With --trust, write the same config.toml entry `/hooks` would. */
function codexTrustStep(hooksJson: any, trust: boolean): void {
  const hooksPath = settingsPath("codex");
  const configPath = join(AGENT_FILES.codex.dir, "config.toml");
  const groups: any[] = hooksJson?.hooks?.UserPromptSubmit ?? [];
  for (const [gi, g] of groups.entries()) {
    for (const [hi, h] of (g.hooks ?? []).entries()) {
      if (typeof h.command !== "string" || !h.command.includes("jev-blindspot-hook.mjs")) continue;
      const key = codexStateKey(hooksPath, "user_prompt_submit", gi, hi);
      const hash = codexHookHash("user_prompt_submit", g, h);
      const toml = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
      const header = `[hooks.state.${JSON.stringify(key)}]`;
      const trusted = toml.includes(header) && toml.slice(toml.indexOf(header)).includes(`trusted_hash = "${hash}"`);
      if (trusted) {
        console.log("codex: hook is trusted");
        return;
      }
      if (!trust) {
        console.log("codex: Codex runs a new hook only after you trust it. Open Codex, run /hooks and trust jev-blindspot,");
        console.log("       or run `jev-blindspot install-hook codex --trust` to write that trust entry to config.toml yourself.");
        return;
      }
      if (toml.includes(header)) {
        console.log("codex: a trust entry for this hook exists with another hash; run /hooks inside Codex to review it");
        return;
      }
      if (toml.length) copyFileSync(configPath, `${configPath}.bak-${Date.now()}`);
      appendFileSync(configPath, (toml.length && !toml.endsWith("\n") ? "\n" : "") + codexTrustToml(key, hash));
      console.log(`codex: trust entry written to ${configPath} (review with /hooks inside Codex)`);
      return;
    }
  }
}

async function gate(prompt: string): Promise<void> {
  if (!prompt) {
    console.error('usage: jev-blindspot gate "<prompt>" [--cwd <dir>]');
    process.exitCode = 2;
    return;
  }
  const cwdIdx = rest.indexOf("--cwd");
  const cwd = cwdIdx >= 0 ? resolve(rest[cwdIdx + 1]) : process.cwd();
  const state = buildGateState({ prompt, cwd });
  const out = await runGate(state, cfg);
  if (!out.ok) {
    console.log(`gate unavailable: ${out.failure} (${out.message}) after ${out.latency_ms}ms`);
    process.exitCode = 1;
    return;
  }
  const d = decideGate(out.answers, cfg.thresholds, { recentPrompts: [] }, Date.now(), hashPrompt(prompt));
  console.log(`model ${out.answers.model}  latency ${out.latency_ms}ms  tokens ${out.usage?.input_tokens ?? "?"}`);
  console.log(`worth ${out.answers.worth_checking.toFixed(2)}  risk ${out.answers.risk.toFixed(2)} (conf ${out.answers.risk_confidence.toFixed(2)})`);
  console.log(`decision: ${d.decision}${d.reason ? "/" + d.reason : ""}  flagged: ${d.flagged_gaps.join(", ") || "-"}`);
  for (const [k, v] of Object.entries(out.answers.gaps).sort((a, b) => b[1] - a[1])) console.log(`  ${v.toFixed(2)}  ${k}`);
}

interface Fixture {
  prompt: string;
  cwd?: string;
  /** exchanges before the prompt, oldest first */
  history?: { user: string; assistant: string }[];
  expect: { decision: "analyze" | "quiet"; reason?: string; flagged_any?: string[]; risk_min?: number };
}

async function fixtures(arg?: string): Promise<void> {
  const own = join(root, "test", "fixtures", "prompts.json");
  const example = join(root, "test", "fixtures", "prompts.example.json");
  const file = arg ? resolve(arg) : existsSync(own) ? own : example;
  console.log(`fixtures: ${file}`);
  const list: Fixture[] = JSON.parse(readFileSync(file, "utf8"));
  let mismatches = 0;
  const lat: number[] = [];
  console.log("| # | prompt | expected | actual | worth | risk | flagged | ms |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const [i, f] of list.entries()) {
    const cwd = f.cwd ? resolve(f.cwd) : root;
    const out = await runGate(buildGateState({ prompt: f.prompt, cwd, history: Array.isArray(f.history) ? f.history : [] }), cfg);
    if (!out.ok) {
      console.log(`| ${i + 1} | ${f.prompt} | ${f.expect.decision} | UNAVAILABLE ${out.failure} | | | | ${out.latency_ms} |`);
      mismatches++;
      continue;
    }
    lat.push(out.latency_ms);
    const d = decideGate(out.answers, cfg.thresholds, { recentPrompts: [] }, Date.now(), hashPrompt(f.prompt));
    let ok = d.decision === f.expect.decision;
    if (ok && f.expect.reason) ok = d.reason === f.expect.reason;
    if (ok && f.expect.flagged_any) ok = f.expect.flagged_any.some((k) => d.flagged_gaps.includes(k as any));
    if (ok && f.expect.risk_min !== undefined) ok = out.answers.risk >= f.expect.risk_min;
    if (!ok) mismatches++;
    const exp = `${f.expect.decision}${f.expect.reason ? "/" + f.expect.reason : ""}${f.expect.flagged_any ? " " + f.expect.flagged_any.join("|") : ""}${f.expect.risk_min ? ` risk>=${f.expect.risk_min}` : ""}`;
    console.log(`| ${i + 1} | ${f.prompt.slice(0, 40)} | ${exp} | ${ok ? "" : "**"}${d.decision}${d.reason ? "/" + d.reason : ""}${ok ? "" : "**"} | ${out.answers.worth_checking.toFixed(2)} | ${out.answers.risk.toFixed(1)} | ${d.flagged_gaps.join(", ") || "-"} | ${out.latency_ms} |`);
  }
  const sorted = [...lat].sort((a, b) => a - b);
  const p = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : "-");
  console.log(`\n${list.length - mismatches}/${list.length} matched. gate latency p50 ${p(0.5)}ms p95 ${p(0.95)}ms`);
  process.exitCode = mismatches;
}

async function smoke(): Promise<void> {
  await start();
  const ev = {
    v: 1,
    type: "prompt_submitted",
    event_id: `smoke-${Date.now()}`,
    ts: Date.now(),
    session_id: "smoke-session",
    cwd: root,
    prompt: rest.join(" ") || "로그인 기능 만들어줘. 소셜 로그인도 되게.",
    hook_version: "smoke",
  };
  const r = await http("POST", "/event", ev);
  console.log(`POST /event -> ${r.status} ${JSON.stringify(r.json)}`);
  for (let i = 0; i < 240; i++) {
    await new Promise((res) => setTimeout(res, 500));
    const t = await http("GET", `/api/sessions/smoke-session?limit=1`);
    const turn = t.json?.[0];
    if (turn?.turn_id === ev.event_id && ["done", "quiet", "error", "gate_unavailable"].includes(turn.state)) {
      console.log(`turn ${turn.state} in ${(i + 1) * 500}ms; gate ${turn.gate_latency_ms}ms; brain ${turn.brain_ms ?? "-"}ms`);
      if (turn.gate_decision) console.log(`  decision ${turn.gate_decision.decision}${turn.gate_decision.reason ? "/" + turn.gate_decision.reason : ""}, flagged ${turn.gate_decision.flagged_gaps.join(", ") || "-"}`);
      if (turn.result) for (const it of turn.result.items) console.log(`  [${it.severity}] ${it.domain}: ${it.title}`);
      if (turn.error) console.log(`  error: ${turn.error.stage}: ${turn.error.message}`);
      return;
    }
  }
  console.log("timed out waiting for the turn to settle");
  process.exitCode = 1;
}

switch (cmd) {
  case "start": await start(); break;
  case "stop": await stop(); break;
  case "status": await status(); break;
  case "open": console.log(panelUrl()); break;
  case "gate": await gate(rest.filter((a, i) => !(a === "--cwd" || rest[i - 1] === "--cwd")).join(" ")); break;
  case "fixtures": await fixtures(rest[0]); break;
  case "install-hook": installHook(rest); break;
  case "smoke": await smoke(); break;
  default:
    console.log("usage: jev-blindspot <start|stop|status|open|gate <prompt>|fixtures [file]|install-hook [claude|codex|all] [--trust]|smoke [prompt]>");
    process.exitCode = 2;
}
