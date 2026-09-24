import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const home = homedir();
const xdg = (envKey: string, fallback: string) =>
  process.env[envKey] && process.env[envKey]!.length > 0 ? process.env[envKey]! : join(home, fallback);

export const PATHS = {
  configDir: join(xdg("XDG_CONFIG_HOME", ".config"), "jev-blindspot"),
  configFile: join(xdg("XDG_CONFIG_HOME", ".config"), "jev-blindspot", "env"),
  stateDir: join(xdg("XDG_STATE_HOME", ".local/state"), "jev-blindspot"),
  dataDir: join(xdg("XDG_DATA_HOME", ".local/share"), "jev-blindspot"),
  get sessionsDir() {
    return join(this.dataDir, "sessions");
  },
  get spoolDir() {
    return join(this.stateDir, "spool");
  },
  get pidFile() {
    return join(this.stateDir, "daemon.pid");
  },
  get lockFile() {
    return join(this.stateDir, "daemon.lock");
  },
  /** taken by the hook that spawns the daemon; the daemon removes it once it is up */
  get spawnLock() {
    return join(this.stateDir, "daemon.spawn.lock");
  },
  get daemonLog() {
    return join(this.stateDir, "daemon.log");
  },
  get hookLog() {
    return join(this.stateDir, "hook.log");
  },
};

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
