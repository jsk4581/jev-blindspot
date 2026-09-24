#!/usr/bin/env node
// jev-blindspot UserPromptSubmit hook. Hot path: no dependencies, no build,
// never writes to stdout or stderr (stdout would become Claude context), except
// for the `/blindspot` command, which is answered with a block decision.
// Reads the hook JSON, POSTs it to the local daemon, and if the daemon is
// down, spools the event and spawns the daemon detached. Always exits 0.
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, renameSync, appendFileSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HOOK_VERSION = "0.1.0";
// Which agent invoked us: `--agent codex` is written into the Codex hooks.json entry;
// Claude Code needs no flag. Codex sends `prompt` and `turn_id`, Claude Code `user_prompt` and `prompt_id`.
const AGENT = (() => {
  const i = process.argv.indexOf("--agent");
  const a = i >= 0 ? process.argv[i + 1] : undefined;
  return a === "codex" ? "codex" : "claude";
})();
const PROTOCOL_VERSION = 1;
const STDIN_TIMEOUT_MS = 800;
const POST_TIMEOUT_MS = 400;
const STDIN_MAX = 1024 * 1024;

const home = homedir();
const stateDir = join(process.env.XDG_STATE_HOME || join(home, ".local/state"), "jev-blindspot");
const spoolDir = join(stateDir, "spool");
const hookLog = join(stateDir, "hook.log");
const here = dirname(fileURLToPath(import.meta.url));
const daemonEntry = resolve(here, "..", "dist", "src", "daemon", "index.js");

// Messages that reach UserPromptSubmit without a person typing them:
// subagent hand-backs, task notifications, slash-command echoes, system reminders.
const SYNTHETIC_PREFIXES = [
  "<agent-message", "<task-notification", "<system-reminder", "<command-name>", "<local-command",
  "[SYSTEM NOTIFICATION", "[Subagent hand-back]", "Caveat:", "[Request interrupted",
];
function isSynthetic(prompt) {
  const head = prompt.trimStart().slice(0, 64);
  return SYNTHETIC_PREFIXES.some((p) => head.startsWith(p));
}

function log(msg) {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    appendFileSync(hookLog, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch {
    /* never throw */
  }
}

/** KEY=VALUE lines from ~/.config/jev-blindspot/env; process.env wins. */
function readEnvFile() {
  const out = {};
  try {
    const cfgFile = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "jev-blindspot", "env");
    for (const raw of readFileSync(cfgFile, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no file */
  }
  return out;
}

function readPort() {
  const env = process.env.JEV_PORT;
  if (env && Number(env) > 0) return Number(env);
  try {
    const cfgFile = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "jev-blindspot", "env");
    const m = readFileSync(cfgFile, "utf8").match(/^\s*JEV_PORT\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  } catch {
    /* default */
  }
  return 7461;
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const t = setTimeout(finish, STDIN_TIMEOUT_MS);
    process.stdin.on("data", (c) => {
      size += c.length;
      if (size > STDIN_MAX) {
        clearTimeout(t);
        finish();
      } else chunks.push(c);
    });
    process.stdin.on("end", () => {
      clearTimeout(t);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(t);
      finish();
    });
  });
}

function optedOut(cwd) {
  let dir = cwd;
  for (let i = 0; i < 6 && dir; i++) {
    if (existsSync(join(dir, ".jev-blindspot-off"))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function post(port, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request(
      { host: "127.0.0.1", port, path: "/event", method: "POST", timeout: POST_TIMEOUT_MS, headers: { "content-type": "application/json", "content-length": data.length } },
      (res) => {
        res.resume();
        resolve(res.statusCode === 202);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end(data);
  });
}

function health(port) {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/health", method: "GET", timeout: POST_TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

/** `/blindspot [status]`: answer from the hook itself, no model turn. The agent shows the
 *  block reason to the user and drops the prompt (Claude Code and Codex both honour
 *  `{"decision":"block","reason":...}` on UserPromptSubmit). */
async function handleCommand(sub) {
  const port = readPort();
  let h = await health(port);
  let started = false;
  if (!h) {
    const r = spawnDaemon();
    started = r === "spawned";
    for (let i = 0; i < 12 && !h; i++) {
      await new Promise((r) => setTimeout(r, 250));
      h = await health(port);
    }
  }
  const env = readEnvFile();
  const extra = (process.env.JEV_BIND_EXTRA ?? env.JEV_BIND_EXTRA ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const urls = [`http://127.0.0.1:${port}/`, ...extra.map((a) => `http://${a}:${port}/`)];
  const lines = [];
  if (!h) lines.push(`jev-blindspot: daemon is not running and could not be started (see ${join(stateDir, "daemon.log")})`);
  else if (sub === "status") {
    const st = h.stats || {};
    lines.push(`jev-blindspot: daemon pid ${h.pid}, up ${h.uptime_s}s, sessions ${h.sessions}, panels ${h.sse_clients}, gate key ${h.gate_key ? "set" : "missing"}${h.fake ? ", FAKE mode" : ""}`);
    lines.push(`events ${st.events ?? 0}, analyzed ${st.analyzed ?? 0}, brain ok ${st.brain_ok ?? 0} / failed ${st.brain_fail ?? 0}`);
  } else lines.push(`jev-blindspot panel${started ? " (daemon started)" : ""}`);
  for (const u of urls) lines.push(`  ${u}`);
  process.stdout.write(JSON.stringify({ decision: "block", reason: lines.join("\n") }) + "\n");
}

function spool(ev) {
  mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  const name = `${ev.ts}-${ev.event_id.slice(0, 8)}.json`;
  const tmp = join(spoolDir, name + ".tmp");
  writeFileSync(tmp, JSON.stringify(ev), { mode: 0o600 });
  renameSync(tmp, join(spoolDir, name));
}

// A spawn lock older than this is left over from a spawn that never came up
// (or a daemon that died before clearing it); the next hook takes it over.
const SPAWN_LOCK_STALE_MS = 15_000;

function spawnDaemon() {
  const lock = join(stateDir, "daemon.spawn.lock");
  // Only one concurrent hook spawns. The hook exits right after, so it cannot
  // clear the lock itself: the daemon removes it once it is listening, and a
  // stale one is taken over here.
  if (!takeLock(lock)) {
    let age = 0;
    try { age = Date.now() - statSync(lock).mtimeMs; } catch { age = Infinity; }
    if (age < SPAWN_LOCK_STALE_MS) return "lock-held";
    unlinkSafe(lock);
    if (!takeLock(lock)) return "lock-held";
  }
  if (!existsSync(daemonEntry)) {
    log(`daemon entry missing: ${daemonEntry} (run npm run build)`);
    unlinkSafe(lock);
    return "no-build";
  }
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: "ignore",
    cwd: home,
    env: { ...process.env, JEV_BLINDSPOT_DAEMON: "1" },
  });
  child.unref();
  return "spawned";
}

function takeLock(lock) {
  try {
    const fd = openSync(lock, "wx", 0o600);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function firstString(...xs) {
  for (const x of xs) if (typeof x === "string" && x) return x;
  return undefined;
}

function unlinkSafe(p) {
  try {
    unlinkSync(p);
  } catch {
    /* ignore */
  }
}

async function main() {
  if (process.env.JEV_BLINDSPOT_CHILD === "1" || process.env.CLAUDE_CODE_SAFE_MODE === "1" || process.env.JEV_BLINDSPOT_DISABLE === "1") return;
  const raw = await readStdin();
  if (!raw) return;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const prompt = typeof input.user_prompt === "string" ? input.user_prompt : typeof input.prompt === "string" ? input.prompt : "";
  // JEV_BLINDSPOT_DEBUG=1 logs the first 120 characters of the prompt (never on by default).
  if (process.env.JEV_BLINDSPOT_DEBUG === "1") log(`debug agent=${AGENT} keys=${Object.keys(input).join(",")} prompt=${JSON.stringify(prompt.slice(0, 120))}`);
  const cmd = prompt.trim().match(/^\/(?:prompts:)?blindspot(?:\s+([a-z]+))?\s*$/);
  if (cmd) return handleCommand(cmd[1]);
  if (!prompt.trim() || isSynthetic(prompt)) return;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  if (optedOut(cwd)) return;

  const ev = {
    v: PROTOCOL_VERSION,
    type: "prompt_submitted",
    event_id: firstString(input.prompt_id, input.turn_id) ?? randomUUID(),
    ts: Date.now(),
    session_id: typeof input.session_id === "string" ? input.session_id : "unknown",
    cwd,
    prompt,
    agent: AGENT,
    transcript_path: typeof input.transcript_path === "string" ? input.transcript_path : undefined,
    hook_event_name: input.hook_event_name,
    hook_version: HOOK_VERSION,
  };
  const port = readPort();
  if (await post(port, ev)) return;
  try {
    spool(ev);
  } catch (e) {
    log(`spool failed: ${e && e.message}`);
  }
  const r = spawnDaemon();
  log(`daemon down; spooled ${ev.event_id.slice(0, 8)}, spawn=${r}`);
}

main()
  .catch((e) => log(`hook error: ${e && (e.stack || e.message)}`))
  .finally(() => {
    // Keep the event loop from waiting on the detached child or stdin.
    setTimeout(() => process.exit(0), 0);
  });
