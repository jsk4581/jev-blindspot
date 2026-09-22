// Append-only file logger with a single 5 MB rotation. Never logs secrets:
// callers must not pass keys or full prompts at info level.
import { appendFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir } from "./paths.js";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_BYTES = 5 * 1024 * 1024;

export class FileLogger {
  constructor(private file: string, private level: Level = "info") {
    ensureDir(dirname(file));
  }
  private write(level: Level, msg: string, extra?: unknown) {
    if (ORDER[level] < ORDER[this.level]) return;
    const line =
      `${new Date().toISOString()} ${level.toUpperCase()} ${msg}` +
      (extra === undefined ? "" : " " + safeJson(extra)) +
      "\n";
    try {
      try {
        if (statSync(this.file).size > MAX_BYTES) renameSync(this.file, this.file + ".1");
      } catch {
        /* no file yet */
      }
      appendFileSync(this.file, line, { mode: 0o600 });
    } catch {
      /* logging must never throw */
    }
  }
  debug(msg: string, extra?: unknown) { this.write("debug", msg, extra); }
  info(msg: string, extra?: unknown) { this.write("info", msg, extra); }
  warn(msg: string, extra?: unknown) { this.write("warn", msg, extra); }
  error(msg: string, extra?: unknown) { this.write("error", msg, extra); }
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}
