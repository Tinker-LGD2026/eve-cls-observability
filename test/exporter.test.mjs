import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../dist/config.js";
import {
  calculateExportTimeoutMillis,
  createSpanPipeline,
  redactReadableSpan,
  SDK_VERSION,
  spanToClsLogEntry,
} from "../dist/exporter.js";

const config = (overrides = {}) => resolveConfig({
  topicId: "00000000-0000-4000-8000-000000000000",
  region: "ap-shanghai",
  secretId: "test-id",
  secretKey: "test-key",
  scheduledDelayMillis: 100,
  maxRetries: 0,
  ...overrides,
});

test("telemetry SDK version resolves from the installed package", () => {
  assert.equal(SDK_VERSION, "0.2.0");
});

test("processor timeout covers the writer request and retry budget", () => {
  assert.equal(calculateExportTimeoutMillis(100, 1), 35_200);
  assert.equal(calculateExportTimeoutMillis(10_000, 2), 65_000);
});

test("pipeline flush waits for a batch already being exported", async () => {
  const originalFetch = globalThis.fetch;
  let releaseFetch;
  const fetchStarted = new Promise((resolve) => {
    globalThis.fetch = async () => {
      resolve();
      return new Promise((release) => {
        releaseFetch = () => release(
          new Response(JSON.stringify({ Response: { RequestId: "request-1" } }), { status: 200 }),
        );
      });
    };
  });
  const pipeline = createSpanPipeline(config());
  try {
    pipeline.tracer.startSpan("test-span").end();
    await fetchStarted;
    let settled = false;
    const flushing = pipeline.flush().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "flush returned before the in-flight request finished");
    releaseFetch();
    await flushing;
  } finally {
    releaseFetch?.();
    await pipeline.provider.shutdown();
    globalThis.fetch = originalFetch;
  }
});

test("optional OTLP mirror failure does not fail the primary CLS flush", async () => {
  const originalFetch = globalThis.fetch;
  const previousHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  const previousTraceHeaders = process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/v1/traces")) return new Response("mirror failed", { status: 500 });
    return new Response(JSON.stringify({ Response: { RequestId: "request-1" } }), { status: 200 });
  };
  const pipeline = createSpanPipeline(config({
    otlpMirrors: [{ topicId: "eed5bd51-a7c0-4305-a5b5-8070d7e7abfe" }],
  }));
  try {
    pipeline.tracer.startSpan("test-span").end();
    await assert.doesNotReject(() => pipeline.flush());
  } finally {
    await pipeline.provider.shutdown().catch(() => undefined);
    globalThis.fetch = originalFetch;
    if (previousHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = previousHeaders;
    if (previousTraceHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = previousTraceHeaders;
  }
});

test("OTLP mirror span clone applies the customer redactor", () => {
  const readable = {
    spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }),
    startTime: [1, 0], endTime: [1, 1], duration: [0, 1], ended: true,
    parentSpanContext: undefined, name: "test", kind: 0, status: { code: 1 },
    links: [], events: [], resource: { attributes: {} },
    instrumentationScope: { name: "test" },
    droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
    attributes: { secret: "remove", safe: "keep" },
  };
  const redacted = redactReadableSpan(
    readable,
    (key, value) => key === "secret" ? undefined : value,
  );
  assert.deepEqual(redacted.attributes, { safe: "keep" });
});

test("redactor covers span, event, link and resource attributes", () => {
  const context = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 };
  const readable = {
    spanContext: () => context,
    startTime: [1, 0], endTime: [1, 1], duration: [0, 1], ended: true,
    parentSpanContext: undefined, name: "test", kind: 0, status: { code: 1 },
    attributes: { secret: "span", safe: "keep" },
    links: [{ context, attributes: { secret: "link", safe: "keep" } }],
    events: [{ name: "event", time: [1, 0], attributes: { secret: "event", safe: "keep" } }],
    resource: { attributes: { secret: "resource", safe: "keep" } },
    instrumentationScope: { name: "test" },
    droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
  };
  const redact = (key, value) => key === "secret" ? undefined : value;
  const cls = spanToClsLogEntry(readable, { redact });
  assert.deepEqual(JSON.parse(cls.fields.attribute), { safe: "keep" });
  assert.deepEqual(JSON.parse(cls.fields.links)[0].attributes, { safe: "keep" });
  assert.deepEqual(JSON.parse(cls.fields.logs)[0].attributes, { safe: "keep" });
  assert.deepEqual(JSON.parse(cls.fields.resource), { safe: "keep" });

  const mirror = redactReadableSpan(readable, redact);
  assert.deepEqual(mirror.attributes, { safe: "keep" });
  assert.deepEqual(mirror.links[0].attributes, { safe: "keep" });
  assert.deepEqual(mirror.events[0].attributes, { safe: "keep" });
  assert.deepEqual(mirror.resource.attributes, { safe: "keep" });
});

test("redactor output cannot break CLS span serialization", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const readable = {
    spanContext: () => ({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: 1,
    }),
    startTime: [1, 0],
    endTime: [1, 1],
    parentSpanContext: undefined,
    name: "test-span",
    kind: 0,
    status: { code: 1 },
    links: [],
    events: [],
    resource: { attributes: {} },
    attributes: { safe: "value" },
  };
  assert.doesNotThrow(() => spanToClsLogEntry(readable, { redact: () => cyclic }));
});
