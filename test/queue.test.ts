import { test } from "node:test";
import assert from "node:assert/strict";
import { BrainQueue } from "../src/daemon/queue.js";

test("BrainQueue runs up to its limit across sessions and one at a time per session", async () => {
  const q = new BrainQueue(3);
  const started: string[] = [];
  const release: Array<() => void> = [];
  const job = (session: string, id: string) => ({
    turn_id: id,
    session_id: session,
    run: () => new Promise<void>((done) => { started.push(id); release.push(done); }),
  });
  q.push(job("a", "a1"));
  q.push(job("a", "a2"));
  q.push(job("b", "b1"));
  q.push(job("c", "c1"));
  q.push(job("d", "d1"));
  assert.deepEqual(started, ["a1", "b1", "c1"]);
  release[0]();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(started, ["a1", "b1", "c1", "a2"]);
});
