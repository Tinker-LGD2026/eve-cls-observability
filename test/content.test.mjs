import assert from "node:assert/strict";
import test from "node:test";
import { cappedJson, extractError } from "../dist/assembler.js";

test("cappedJson returns valid JSON within a UTF-8 byte limit", () => {
  const json = cappedJson([{ role: "user", parts: [{ type: "text", content: "你".repeat(100) }] }], 96);
  assert.ok(json);
  assert.ok(Buffer.byteLength(json, "utf8") <= 96);
  assert.doesNotThrow(() => JSON.parse(json));
});

test("cappedJson safely serializes BigInt and circular objects", () => {
  const value = { count: 3n };
  value.self = value;
  const json = cappedJson(value, 1024);
  assert.ok(json);
  assert.deepEqual(JSON.parse(json), { count: "3", self: "[Circular]" });
});

test("extractError never throws for circular objects", () => {
  const error = {};
  error.self = error;
  assert.doesNotThrow(() => extractError(error));
  assert.equal(extractError(error).type, "Error");
});
