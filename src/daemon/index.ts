// Daemon entry: singleton -> rebuild store -> drain spool -> listen -> idle timer.
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../shared/config.js";
import { FileLogger } from "../shared/log.js";
import { PATHS, ensureDir } from "../shared/paths.js";
import { isPromptSubmittedEvent } from "../shared/protocol.js";
import { Pipeline } from "./pipeline.js";
import { createHandler, listenAll } from "./server.js";
import { acquire } from "./singleton.js";
import { SessionStore } from "./store.js";
import { SseHub } from "./sse.js";

const VERSION = "0.1.0";
const KEEPALIVE_MS = 15_000;
const IDLE_CHECK_MS = 30_000;
const SPOOL_MAX_AGE_MS = 60_000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  ensureDir(PATHS.stateDir);
  ensureDir(PATHS.spoolDir);
  const log = new FileLogger(PATHS.daemonLog, cfg.logLevel);

  if (!(await acquire(cfg.port))) {
    log.debug("another daemon owns the port; exiting");
    return;
  }
  log.info("starting", { pid: process.pid, version: VERSION, port: cfg.port, fake: cfg.fake, gate_key: cfg.hasTypesafeKey });

  const store = new SessionStore();
  const rebuilt = store.rebuild();
  store.markInterrupted();
  if (rebuilt) log.info("rebuilt store", { records: rebuilt });
  store.prune(30);

  const hub = new SseHub();
  const pipeline = new Pipeline(cfg, store, hub, log);
  const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "web");

  let shuttingDown = false;
  const shutdown = (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { why });
    pipeline.shutdown();
    hub.closeAll();
    for (const s of servers) s.close();
    setTimeout(() => process.exit(0), 200).unref();
  };

  const handler = createHandler({ cfg, store, hub, pipeline, log, webDir, version: VERSION, startedAt: Date.now(), onShutdown: () => shutdown("api") });
  const servers = await listenAll(handler, cfg, log);

  // The hook that spawned us exits at once, so it cannot clear its spawn lock itself.
  try {
    unlinkSync(PATHS.spawnLock);
  } catch {
    /* not held */
  }

  drainSpool(pipeline, log);

  const ka = setInterval(() => hub.ping(), KEEPALIVE_MS);
  const idle = setInterval(() => {
    const idleMs = Date.now() - pipeline.lastActivityTs;
    if (idleMs > cfg.idleMinutes * 60_000 && hub.size === 0 && pipeline.activeBrains === 0) shutdown("idle");
  }, IDLE_CHECK_MS);
  ka.unref();
  idle.unref();

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (e) => log.error("uncaught", { e: String(e?.stack ?? e) }));
  process.on("unhandledRejection", (e) => log.error("unhandled rejection", { e: String(e) }));
}

function drainSpool(pipeline: Pipeline, log: FileLogger): void {
  let files: string[] = [];
  try {
    files = readdirSync(PATHS.spoolDir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return;
  }
  let n = 0;
  for (const f of files) {
    const p = join(PATHS.spoolDir, f);
    try {
      const age = Date.now() - statSync(p).mtimeMs;
      if (age <= SPOOL_MAX_AGE_MS) {
        const ev = JSON.parse(readFileSync(p, "utf8"));
        if (isPromptSubmittedEvent(ev) && pipeline.accept(ev)) n++;
      }
    } catch {
      /* skip */
    }
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  if (n) log.info("drained spool", { events: n });
}

main().catch((e) => {
  try {
    new FileLogger(PATHS.daemonLog).error("fatal", { e: String(e?.stack ?? e) });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
