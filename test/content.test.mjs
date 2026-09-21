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

test("cappedJson never executes customer toJSON methods", () => {
  const value = {
    secret: "safe",
    toJSON() {
      throw new Error("must not execute");
    },
  };
  let json;
  assert.doesNotThrow(() => {
    json = cappedJson(value, 1024);
  });
  assert.ok(json);
  assert.equal(JSON.parse(json).secret, "safe");
});

test("extractError never throws for circular objects", () => {
  const error = {};
  error.self = error;
  assert.doesNotThrow(() => extractError(error));
  assert.equal(extractError(error).type, "Error");
});

test("cappedJson stops traversing a very wide array after its node budget", () => {
  let reads = 0;
  const values = new Proxy(new Array(1_000_000), {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const json = cappedJson(values, 1024);
  assert.ok(json);
  assert.ok(reads < 10_000, `visited ${reads} array elements`);
  assert.ok(Buffer.byteLength(json, "utf8") <= 1024);
});

test("cappedJson stops scanning inherited properties after its node budget", () => {
  const prototype = {};
  for (let index = 0; index < 100_000; index += 1) prototype[`inherited-${index}`] = index;
  let checks = 0;
  const original = Object.prototype.hasOwnProperty;
  Object.prototype.hasOwnProperty = function (...args) {
    checks += 1;
    return Reflect.apply(original, this, args);
  };
  try {
    const json = cappedJson(Object.create(prototype), 1024);
    assert.ok(json);
    assert.ok(checks < 10_000, `checked ${checks} inherited properties`);
  } finally {
    Object.prototype.hasOwnProperty = original;
  }
});

test("cappedJson handles deeply nested input without overflowing the stack", () => {
  let value = "leaf";
  for (let index = 0; index < 10_000; index += 1) value = { child: value };
  let json;
  assert.doesNotThrow(() => {
    json = cappedJson(value, 1024);
  });
  assert.ok(json);
  assert.ok(Buffer.byteLength(json, "utf8") <= 1024);
  assert.doesNotThrow(() => JSON.parse(json));
});
