import { test } from "node:test";
import assert from "node:assert/strict";
import { extractExchanges, ASSISTANT_MAX, USER_MAX } from "../src/context/transcript.js";

const line = (o: unknown) => JSON.stringify(o);
const user = (content: unknown, extra: Record<string, unknown> = {}) => line({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (blocks: unknown[], extra: Record<string, unknown> = {}) => line({ type: "assistant", message: { role: "assistant", content: blocks }, ...extra });
const text = (t: string) => ({ type: "text", text: t });

test("pairs each earlier prompt with the reply text that followed it, oldest first", () => {
  const t = [
    user("first"),
    assistant([text("reply one")]),
    user("second"),
    assistant([{ type: "thinking", thinking: "hidden" }, text("I will look.")]),
    assistant([{ type: "tool_use", id: "t1", name: "Read", input: {} }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "file body" }]),
    assistant([text("Done: two files changed.")]),
    user("third"),
  ].join("\n");
  assert.deepEqual(extractExchanges(t, 2, "current"), [
    { user: "second", assistant: "I will look.\n\nDone: two files changed." },
    { user: "third", assistant: "" },
  ]);
});

test("skips sidechains, compact summaries, the current prompt, and command noise", () => {
  const t = [
    user("real one"),
    assistant([text("side reply")], { isSidechain: true }),
    assistant([text("real reply")]),
    user("side", { isSidechain: true }),
    user("<command-name>/foo</command-name>"),
    user("Caveat: generated"),
    user('<agent-message from="abc">report</agent-message>'),
    user("<task-notification><task-id>x</task-id></task-notification>"),
    user("[SYSTEM NOTIFICATION - NOT USER INPUT] ..."),
    user("This session is being continued from a previous conversation that ran out of context.", { isCompactSummary: true }),
    user("current"),
    assistant([text("after current")]),
  ].join("\n");
  assert.deepEqual(extractExchanges(t, 3, "current"), [{ user: "real one", assistant: "real reply" }]);
});

const codex = (message: string, extra: Record<string, unknown> = {}) =>
  line({ timestamp: "t", type: "event_msg", payload: { type: "user_message", message, images: [], ...extra } });
const codexReply = (message: string, phase = "final_answer") => line({ timestamp: "t", type: "event_msg", payload: { type: "agent_message", message, phase } });

test("reads Codex rollout user_message and agent_message lines, skipping slash commands and other events", () => {
  const t = [
    codex("first codex prompt"),
    codexReply("looking at it", "commentary"),
    codexReply("first answer"),
    codex("/model gpt-5", { text_elements: [{ byte_range: { start: 0, end: 6 }, placeholder: "/model" }] }),
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>" }] } }),
    line({ type: "event_msg", payload: { type: "task_complete" } }),
    codex("second codex prompt"),
    codexReply("second answer"),
    codex("current"),
  ].join("\n");
  assert.deepEqual(extractExchanges(t, 3, "current"), [
    { user: "first codex prompt", assistant: "looking at it\n\nfirst answer" },
    { user: "second codex prompt", assistant: "second answer" },
  ]);
});

test("tolerates a truncated last line; cuts prompts at the head and replies at the tail", () => {
  const longPrompt = "p".repeat(900);
  const longReply = "a".repeat(2000) + "END";
  const t = [user(longPrompt), assistant([text(longReply)]), '{"type":"user","message":{"role":"user","content":"cut'].join("\n");
  const out = extractExchanges(t, 2, "");
  assert.equal(out.length, 1);
  assert.equal(out[0].user.length, USER_MAX);
  assert.equal(out[0].assistant.length, ASSISTANT_MAX);
  assert.ok(out[0].assistant.endsWith("END"));
});
