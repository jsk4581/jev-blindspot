import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrainOutput, normalise } from "../src/brain/schema.js";

const payload = { language: "ko", domains: ["보안", "UX"], items: [
  { title: "t1", why: "w1", domain: "보안", severity: "note", confidence: 0.4 },
  { title: "t2", why: "w2", domain: "UX", severity: "likely-costly", confidence: 0.9, suggestion: "s" },
] };

test("parses the CLI json envelope with structured_output", () => {
  const r = parseBrainOutput(JSON.stringify({ type: "result", is_error: false, structured_output: payload, model: "claude-sonnet-5" }));
  assert.ok(r.ok);
  assert.equal(r.result.items[0].severity, "likely-costly"); // sorted most severe first
  assert.equal(r.result.items[1].suggestion, undefined);
});

test("parses result as a fenced JSON string", () => {
  const r = parseBrainOutput(JSON.stringify({ result: "```json\n" + JSON.stringify(payload) + "\n```" }));
  assert.ok(r.ok);
  assert.equal(r.result.domains.length, 2);
});

test("reports is_error", () => {
  const r = parseBrainOutput(JSON.stringify({ is_error: true, result: "boom" }));
  assert.ok(!r.ok);
  assert.match(r.message, /boom/);
});

test("recovers a JSON object embedded in noise", () => {
  const r = parseBrainOutput("warning: something\n" + JSON.stringify({ structured_output: payload }) + "\ntrailing");
  assert.ok(r.ok);
});

test("normalise truncates and defaults", () => {
  const r = normalise({ items: Array.from({ length: 7 }, (_, i) => ({ title: "t".repeat(100), why: "w", severity: "bogus", confidence: 5, domain: "" })) });
  assert.equal(r.items.length, 5);
  assert.equal(r.items[0].title.length, 60);
  assert.equal(r.items[0].severity, "note");
  assert.equal(r.items[0].confidence, 1);
  assert.equal(r.items[0].domain, "general");
  assert.equal(r.language, "en");
});
