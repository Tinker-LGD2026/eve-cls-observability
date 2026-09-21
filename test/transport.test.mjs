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

test("drops only an oversized entry and uploads the valid entries", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ Response: { RequestId: String(calls) } }), { status: 200 });
  };
  try {
    const writer = new ClsWriter({ ...options, maxBatchBytes: 512 });
    await writer.putLogs([entry(8), entry(2_000), entry(8)]);
    assert.ok(calls >= 1);
    assert.equal(writer.getStats().uploadedSpans, 2);
    assert.equal(writer.getStats().droppedOversizedSpans, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("shares one retry deadline across all split payloads", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "0.02" } });
    return new Response(JSON.stringify({ Response: { RequestId: String(calls) } }), { status: 200 });
  };
  try {
    const writer = new ClsWriter({
      ...options,
      maxRetries: 1,
      maxBatchBytes: 512,
      maxRetryDelayMs: 20,
      requestTimeoutMs: 10,
    });
    const started = Date.now();
    await writer.putLogs(Array.from({ length: 8 }, () => entry(200))).catch(() => undefined);
    assert.ok(Date.now() - started < 150, "each split payload received a fresh retry budget");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("caps Retry-After by the configured retry delay budget", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("", { status: 429, headers: { "retry-after": "0.2" } });
    }
    return new Response(JSON.stringify({ Response: { RequestId: "request-2" } }), { status: 200 });
  };
  try {
    const writer = new ClsWriter({ ...options, maxRetries: 1, maxRetryDelayMs: 5 });
    const started = Date.now();
    await writer.putLogs([entry()]);
    assert.ok(Date.now() - started < 100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries when reading the response body fails", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.error(new Error("socket reset"));
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ Response: { RequestId: "request-2" } }), { status: 200 });
  };
  try {
    const writer = new ClsWriter({ ...options, maxRetries: 1, maxRetryDelayMs: 1 });
    await writer.putLogs([entry()]);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries a server error even when its business code is unknown", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ Response: { Error: { Code: "UnexpectedFailure", Message: "failed" } } }),
        { status: 500 },
      );
    }
    return new Response(JSON.stringify({ Response: { RequestId: "request-2" } }), { status: 200 });
  };
  try {
    const writer = new ClsWriter({ ...options, maxRetries: 1, maxRetryDelayMs: 1 });
    await writer.putLogs([entry()]);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("disables HTTP redirects for signed CLS requests", async () => {
  const originalFetch = globalThis.fetch;
  let redirect;
  globalThis.fetch = async (_url, init) => {
    redirect = init.redirect;
    return new Response(JSON.stringify({ Response: { RequestId: "request-1" } }), { status: 200 });
  };
  try {
    const writer = new ClsWriter(options);
    await writer.putLogs([entry()]);
    assert.equal(redirect, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
