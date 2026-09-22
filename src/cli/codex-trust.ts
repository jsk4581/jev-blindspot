// Codex CLI runs a user hook only after its definition is trusted. Trust lives in
// ~/.codex/config.toml as
//   [hooks.state."<hooks.json path>:user_prompt_submit:<group>:<index>"]
//   trusted_hash = "sha256:..."
// and is normally recorded by `/hooks` inside Codex. The hash is Codex's own recipe
// (codex-rs/hooks/src/engine/discovery.rs `hook_hash` and
// codex-rs/config/src/fingerprint.rs `version_for_toml`): the normalized group
// `{event_name, matcher?, hooks:[{type, command, timeout, async, statusMessage?}]}`
// serialized as key-sorted compact JSON and hashed with SHA-256.
import { createHash } from "node:crypto";

export interface CodexHandler {
  type?: string;
  command: string;
  timeout?: number;
  async?: boolean;
  statusMessage?: string;
  commandWindows?: string;
}

export interface CodexGroup {
  matcher?: string;
  hooks: CodexHandler[];
}

const DEFAULT_TIMEOUT_SEC = 600;

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonical(o[k])]));
  }
  return v;
}

export function codexHookHash(eventLabel: string, group: CodexGroup, handler: CodexHandler): string {
  const h: Record<string, unknown> = {
    type: "command",
    command: handler.command,
    timeout: typeof handler.timeout === "number" && handler.timeout > 0 ? Math.floor(handler.timeout) : DEFAULT_TIMEOUT_SEC,
    async: Boolean(handler.async),
  };
  if (typeof handler.statusMessage === "string") h.statusMessage = handler.statusMessage;
  if (typeof handler.commandWindows === "string") h.commandWindows = handler.commandWindows;
  const identity: Record<string, unknown> = { event_name: eventLabel, hooks: [h] };
  if (typeof group.matcher === "string") identity.matcher = group.matcher;
  return "sha256:" + createHash("sha256").update(JSON.stringify(canonical(identity))).digest("hex");
}

export function codexStateKey(hooksJsonPath: string, eventLabel: string, groupIndex: number, handlerIndex: number): string {
  return `${hooksJsonPath}:${eventLabel}:${groupIndex}:${handlerIndex}`;
}

/** The TOML fragment `/hooks` would write. Appending it to config.toml is valid anywhere in the file. */
export function codexTrustToml(key: string, hash: string): string {
  return `\n[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "${hash}"\n`;
}
