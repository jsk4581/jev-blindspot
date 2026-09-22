// One daemon per user: pidfile + O_EXCL lock. A stale pidfile (dead pid or
// health check failing) is removed and ownership taken.
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { PATHS, ensureDir } from "../shared/paths.js";

export function readPid(): number | undefined {
  try {
    const n = Number(readFileSync(PATHS.pidFile, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function healthy(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/health", method: "GET", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Returns true when this process now owns the daemon role. */
export async function acquire(port: number): Promise<boolean> {
  ensureDir(PATHS.stateDir);
  const pid = readPid();
  if (pid && pidAlive(pid) && (await healthy(port))) return false;
  try {
    unlinkSync(PATHS.pidFile);
  } catch {
    /* none */
  }
  try {
    unlinkSync(PATHS.lockFile);
  } catch {
    /* none */
  }
  try {
    const fd = openSync(PATHS.lockFile, "wx", 0o600);
    closeSync(fd);
  } catch {
    // Someone else grabbed the lock between our checks; let them win.
    return false;
  }
  writeFileSync(PATHS.pidFile, String(process.pid) + "\n", { mode: 0o600 });
  const release = () => {
    try {
      if (readPid() === process.pid) unlinkSync(PATHS.pidFile);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(PATHS.lockFile);
    } catch {
      /* ignore */
    }
  };
  process.on("exit", release);
  return true;
}
