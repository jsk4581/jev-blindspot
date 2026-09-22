// node:http server: static panel, SSE, JSON API. Two listeners (loopback +
// tailscale) share one handler. Mutating routes are loopback-only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { editableConfig, updateConfig, type Config } from "../shared/config.js";
import type { FileLogger } from "../shared/log.js";
import { PROTOCOL_VERSION, isPromptSubmittedEvent } from "../shared/protocol.js";
import { runGate } from "../gate/client.js";
import type { Exchange } from "../context/transcript.js";
import { buildGateState } from "../gate/state.js";
import { decideGate, hashPrompt } from "../gate/thresholds.js";
import type { Pipeline } from "./pipeline.js";
import type { SessionStore } from "./store.js";
import type { SseHub } from "./sse.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const BODY_MAX = 1024 * 1024;

export interface ServerDeps {
  cfg: Config;
  store: SessionStore;
  hub: SseHub;
  pipeline: Pipeline;
  log: FileLogger;
  webDir: string;
  version: string;
  startedAt: number;
  onShutdown: () => void;
}

export function createHandler(d: ServerDeps) {
  const allowedHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]", ...d.cfg.bindExtra, ...d.cfg.allowedHosts]);

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const host = hostName(req.headers.host);
    if (!allowedHosts.has(host)) return sendJson(res, 403, { error: "host not allowed" });
    if (d.cfg.token && !tokenOk(req, url, d.cfg.token)) return sendJson(res, 401, { error: "unauthorized" });
    const loopback = isLoopback(req.socket.remoteAddress);
    const method = req.method ?? "GET";
    d.pipeline.touch();

    try {
      if (method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          uptime_s: Math.round((Date.now() - d.startedAt) / 1000),
          version: d.version,
          protocol: PROTOCOL_VERSION,
          sessions: d.store.sessions().length,
          sse_clients: d.hub.size,
          brain_running: d.pipeline.activeBrains,
          fake: d.cfg.fake,
          gate_key: d.cfg.hasTypesafeKey,
          stats: summarizeStats(d.pipeline.stats),
        });
      }
      if (method === "GET" && url.pathname === "/events") {
        d.hub.attach(res);
        const sessions = d.store.sessions();
        const turns = sessions.slice(0, 5).flatMap((s) => d.store.turnsOf(s.session_id, 20));
        d.hub.send(res, "snapshot", { v: PROTOCOL_VERSION, sessions, turns });
        return;
      }
      if (method === "GET" && url.pathname === "/api/sessions") return sendJson(res, 200, d.store.sessions());
      const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (method === "GET" && m) {
        const limit = Math.min(50, Number(url.searchParams.get("limit")) || 20);
        return sendJson(res, 200, d.store.turnsOf(decodeURIComponent(m[1]), limit));
      }
      if (method === "POST" && url.pathname === "/event") {
        if (!loopback) return sendJson(res, 403, { error: "loopback only" });
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { error: "bad json" });
        if (!isPromptSubmittedEvent(body)) return sendJson(res, 400, { error: "bad event" });
        if (body.v !== PROTOCOL_VERSION) return sendJson(res, 409, { error: "protocol mismatch", expected: PROTOCOL_VERSION });
        const accepted = d.pipeline.accept(body);
        return sendJson(res, 202, { ok: true, event_id: body.event_id, duplicate: !accepted });
      }
      if (method === "POST" && url.pathname === "/api/gate") {
        if (!loopback) return sendJson(res, 403, { error: "loopback only" });
        const body = (await readJson(req)) as { prompt?: string; cwd?: string; history?: Exchange[] } | undefined;
        if (!body || typeof body.prompt !== "string") return sendJson(res, 400, { error: "prompt required" });
        const history = Array.isArray(body.history) ? body.history.filter((x) => x && typeof x.user === "string").map((x) => ({ user: x.user, assistant: typeof x.assistant === "string" ? x.assistant : "" })) : undefined;
        const state = buildGateState({ prompt: body.prompt, cwd: body.cwd || process.cwd(), history });
        const out = await runGate(state, d.cfg);
        const decision = out.ok
          ? decideGate(out.answers, d.cfg.thresholds, { recentPrompts: [] }, Date.now(), hashPrompt(body.prompt))
          : undefined;
        return sendJson(res, 200, { state, gate: out, decision });
      }
      if (method === "GET" && url.pathname === "/api/config") {
        return sendJson(res, 200, { config: editableConfig(d.cfg), codex_models: codexModels(), gate_key: d.cfg.hasTypesafeKey, fake: d.cfg.fake });
      }
      // Settings may be changed from any allowed host: whoever can read the panel
      // already sees every prompt, and these keys only pick models.
      if (method === "POST" && url.pathname === "/api/config") {
        const body = (await readJson(req)) as Record<string, unknown> | undefined;
        if (!body || typeof body !== "object") return sendJson(res, 400, { error: "bad json" });
        const patch: Record<string, string> = {};
        for (const [k, v] of Object.entries(body)) if (typeof v === "string") patch[k] = v;
        const r = updateConfig(patch);
        d.log.info("config updated", { applied: Object.keys(r.applied), rejected: r.rejected, remote: req.socket.remoteAddress });
        const payload = { config: editableConfig(d.cfg), applied: r.applied, rejected: r.rejected };
        d.hub.broadcast("config", payload.config);
        return sendJson(res, r.rejected.length && !Object.keys(r.applied).length ? 400 : 200, payload);
      }
      if (method === "POST" && url.pathname === "/api/shutdown") {
        if (!loopback) return sendJson(res, 403, { error: "loopback only" });
        sendJson(res, 200, { ok: true });
        setTimeout(() => d.onShutdown(), 50);
        return;
      }
      if (method === "GET") return serveStatic(res, d.webDir, url.pathname);
      sendJson(res, 404, { error: "not found" });
    } catch (e: any) {
      d.log.error("request failed", { path: url.pathname, e: String(e?.message ?? e) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
    }
  };
}

/** Model slugs Codex has cached for this account (best effort, for the settings dropdown). */
function codexModels(): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".codex", "models_cache.json"), "utf8"));
    const list: any[] = Array.isArray(raw?.models) ? raw.models : Array.isArray(raw) ? raw : [];
    return list
      .filter((m) => m && typeof m.slug === "string" && (m.visibility === undefined || m.visibility === "list"))
      .map((m) => m.slug as string);
  } catch {
    return [];
  }
}

export function listenAll(handler: ReturnType<typeof createHandler>, cfg: Config, log: FileLogger): Promise<Server[]> {
  const hosts = ["127.0.0.1", ...cfg.bindExtra];
  return Promise.all(
    hosts.map(
      (host) =>
        new Promise<Server | undefined>((resolve, reject) => {
          const srv = createServer(handler);
          srv.keepAliveTimeout = 65_000;
          srv.on("error", (e: NodeJS.ErrnoException) => {
            if (host === "127.0.0.1") return reject(e);
            log.warn(`could not bind ${host}:${cfg.port}`, { code: e.code });
            resolve(undefined);
          });
          srv.listen(cfg.port, host, () => {
            log.info(`listening http://${host}:${cfg.port}/`);
            resolve(srv);
          });
        }),
    ),
  ).then((list) => list.filter((s): s is Server => Boolean(s)));
}

// ── helpers ─────────────────────────────────────────────────────────────
function hostName(h: string | undefined): string {
  if (!h) return "";
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  const i = h.lastIndexOf(":");
  return i > 0 ? h.slice(0, i) : h;
}

function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function tokenOk(req: IncomingMessage, url: URL, token: string): boolean {
  const auth = req.headers.authorization;
  if (auth === `Bearer ${token}`) return true;
  if (url.searchParams.get("t") === token) return true;
  const cookie = req.headers.cookie ?? "";
  return cookie.split(";").some((c) => c.trim() === `jev_token=${token}`);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": buf.length, "cache-control": "no-store" });
  res.end(buf);
}

function readJson(req: IncomingMessage): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_MAX) {
        req.destroy();
        resolve(undefined);
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

async function serveStatic(res: ServerResponse, webDir: string, pathname: string): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = normalize(join(webDir, rel));
  if (!full.startsWith(webDir + sep) && full !== join(webDir, "index.html")) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await readFile(full);
    res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream", "content-length": data.length, "cache-control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

function summarizeStats(s: Pipeline["stats"]) {
  const pct = (arr: number[], p: number) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);
  return {
    events: s.events,
    gate_ok: s.gate_ok,
    gate_fail: s.gate_fail,
    analyzed: s.analyzed,
    brain_ok: s.brain_ok,
    brain_fail: s.brain_fail,
    gate_p50_ms: pct(s.gate_ms, 0.5),
    gate_p95_ms: pct(s.gate_ms, 0.95),
    brain_p50_ms: pct(s.brain_ms, 0.5),
    brain_p95_ms: pct(s.brain_ms, 0.95),
  };
}
