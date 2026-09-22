// Recent exchanges of the session (user prompt + the assistant's reply text),
// read from the agent's transcript JSONL. Only the tail of the file is read;
// tool calls, tool results, thinking, sidechains and slash-command noise are
// skipped. Two formats are sniffed per line:
//   Claude Code: {type:"user", message:{content:"<string>"}} and
//                {type:"assistant", message:{content:[{type:"text", text}]}}
//   Codex:       {type:"event_msg", payload:{type:"user_message"|"agent_message", message}}
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const TAIL_BYTES = 1024 * 1024;
/** Head of a previous prompt kept for context. */
export const USER_MAX = 500;
/** Tail of an assistant reply kept for context: the end holds the conclusion. */
export const ASSISTANT_MAX = 1500;
const SKIP_PREFIXES = [
  "<command-name>",
  "<local-command",
  "Caveat:",
  "[Request interrupted",
  "<system-reminder",
  "<agent-message",
  "<task-notification",
  "[SYSTEM NOTIFICATION",
  "[Subagent hand-back]",
  "This session is being continued from a previous conversation",
];

/** One turn of the conversation before the current prompt. `assistant` is "" when the reply had no text. */
export interface Exchange {
  user: string;
  assistant: string;
}

type Line = { role: "user"; text: string } | { role: "assistant"; text: string };

/** Classify one transcript record, or undefined when it carries no conversation text. */
function classify(rec: any): Line | undefined {
  if (!rec || typeof rec !== "object") return undefined;
  if (rec.isSidechain === true) return undefined;
  if (rec.type === "user") {
    if (rec.isCompactSummary === true) return undefined;
    const c = rec.message?.content;
    return typeof c === "string" ? { role: "user", text: c } : undefined;
  }
  if (rec.type === "assistant") {
    const c = rec.message?.content;
    if (!Array.isArray(c)) return undefined;
    const text = c
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
    return text.trim() ? { role: "assistant", text } : undefined;
  }
  if (rec.type === "event_msg") {
    const p = rec.payload;
    if (p?.type === "user_message") {
      const m = p.message;
      if (typeof m !== "string") return undefined;
      const els: any[] = Array.isArray(p.text_elements) ? p.text_elements : [];
      if (els.some((e) => typeof e?.placeholder === "string" && e.placeholder.startsWith("/") && e.byte_range?.start === 0)) return undefined;
      if (/^\/[a-z][\w-]*(\s|$)/i.test(m)) return undefined;
      return { role: "user", text: m };
    }
    if (p?.type === "agent_message" && typeof p.message === "string") return { role: "assistant", text: p.message };
  }
  return undefined;
}

export function readRecentExchanges(path: string | undefined, n: number, currentPrompt: string): Exchange[] {
  if (!path || n <= 0) return [];
  let text: string;
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  return extractExchanges(text, n, currentPrompt);
}

/** Pure: oldest-first list of up to n exchanges before the current prompt. */
export function extractExchanges(text: string, n: number, currentPrompt: string): Exchange[] {
  const lines = text.split("\n");
  const out: Exchange[] = [];
  const cur = currentPrompt.trim();
  let replies: string[] = []; // assistant text after the user prompt we have not reached yet, newest first
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // truncated last line or noise
    }
    const l = classify(rec);
    if (!l) continue;
    const s = l.text.trim();
    if (!s) continue;
    if (l.role === "assistant") {
      replies.push(s);
      continue;
    }
    if (s === cur) {
      replies = []; // the current prompt is already in the file; anything after it is not a reply to an earlier one
      continue;
    }
    if (SKIP_PREFIXES.some((p) => s.startsWith(p))) continue;
    const assistant = replies.reverse().join("\n\n");
    out.push({
      user: s.length > USER_MAX ? s.slice(0, USER_MAX) : s,
      assistant: assistant.length > ASSISTANT_MAX ? assistant.slice(-ASSISTANT_MAX) : assistant,
    });
    replies = [];
  }
  return out.reverse();
}
