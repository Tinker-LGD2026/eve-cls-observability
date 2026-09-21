import assert from "node:assert/strict";
import test from "node:test";
import { MessageCursorStore } from "../dist/content/message-cursor.js";

const messages = (...texts) => texts.map((content, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  parts: [{ type: "text", content }],
}));

test("first prompt is full and cursor stores hashes instead of message content", () => {
  const store = new MessageCursorStore({ maxSessions: 10, ttlMs: 60_000 });
  const result = store.advance("session-1", messages("secret prompt"), 1);
  assert.equal(result.kind, "full");
  assert.equal(result.hash.length, 32);
  assert.equal(JSON.stringify(store.snapshot()).includes("secret prompt"), false);
});

test("strict prefix extension produces append delta", () => {
  const store = new MessageCursorStore({ maxSessions: 10, ttlMs: 60_000 });
  store.advance("session-1", messages("one"), 1);
  const result = store.advance("session-1", messages("one", "two"), 2);
  assert.equal(result.kind, "delta");
  assert.deepEqual(result.messages, messages("one", "two").slice(1));
});

test("prefix change falls back to full", () => {
  const store = new MessageCursorStore({ maxSessions: 10, ttlMs: 60_000 });
  store.advance("session-1", messages("one"), 1);
  const result = store.advance("session-1", messages("changed", "two"), 2);
  assert.equal(result.kind, "full");
});

test("stale version does not overwrite or re-emit an older prompt", () => {
  const store = new MessageCursorStore({ maxSessions: 10, ttlMs: 60_000 });
  store.advance("session-1", messages("one", "two"), 2);
  const result = store.advance("session-1", messages("old"), 1);
  assert.equal(result.kind, "stale");
  assert.deepEqual(result.messages, []);
  assert.equal(store.snapshot()["session-1"].version, 2);
});

test("message hashes include content beyond the JSON preview node budget", () => {
  const store = new MessageCursorStore({ maxSessions: 10, ttlMs: 60_000 });
  const first = { role: "user", parts: Array.from({ length: 3_000 }, (_, index) => ({ index })) };
  const changed = { role: "user", parts: [...first.parts] };
  changed.parts[2_999] = { index: "changed" };
  const initial = store.advance("session-1", [first], 1);
  const updated = store.advance("session-1", [changed, { role: "assistant", parts: [] }], 2);
  assert.notEqual(updated.hash, initial.hash);
  assert.equal(updated.kind, "full");
});

test("unserializable messages force full fallback instead of a false delta", () => {
  const store = new MessageCursorStore({ maxSessions: 10, ttlMs: 60_000 });
  const first = { role: "user", value: 1, toJSON() {} };
  store.advance("session-1", [first], 1);
  const changed = { role: "user", value: 2, toJSON() {} };
  const result = store.advance("session-1", [changed, { role: "assistant" }], 2);
  assert.equal(result.kind, "full");
});

test("evicts expired and over-capacity cursors", () => {
  let now = 1_000;
  const store = new MessageCursorStore({ maxSessions: 1, ttlMs: 100, now: () => now });
  store.advance("a", messages("a"), 1);
  store.advance("b", messages("b"), 1);
  assert.deepEqual(Object.keys(store.snapshot()), ["b"]);
  now += 101;
  store.evictExpired();
  assert.deepEqual(store.snapshot(), {});
});
