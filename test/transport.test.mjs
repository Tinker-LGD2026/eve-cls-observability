import assert from "node:assert/strict";
import test from "node:test";
import { ClsWriter } from "../dist/cls-writer.js";

const options = {
  secretId: "test-id",
  secretKey: "test-key",
  region: "ap-shanghai",
  topicId: "00000000-0000-4000-8000-000000000000",
  maxRetries: 0,
  requestTimeoutMs: 50,
  onError: () => undefined,
};

const entry = (size = 8) => ({
  timeMillis: Date.now(),
  fields: { traceID: "a".repeat(32), attribute: "x".repeat(size) },
});

test("rejects when CLS returns HTTP 200 with a business error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ Response: { Error: { Code: "FailedOperation" } } }), { status: 200 });
  try {
    const writer = new ClsWriter(options);
    await assert.rejects(() => writer.putLogs([entry()]), /FailedOperation/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a hung request after requestTimeoutMs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });
  try {
    const writer = new ClsWriter(options);
    await assert.rejects(() => writer.putLogs([entry()]), /timeout|aborted/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("splits encoded requests before maxBatchBytes", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ Response: { RequestId: String(calls) } }), { status: 200 });
  };
  try {
    const writer = new ClsWriter({ ...options, maxBatchBytes: 512 });
    await writer.putLogs(Array.from({ length: 8 }, () => entry(200)));
    assert.ok(calls > 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
