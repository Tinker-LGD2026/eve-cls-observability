import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../dist/config.js";

const base = {
  topicId: "00000000-0000-4000-8000-000000000000",
  region: "ap-shanghai",
  secretId: "test-id",
  secretKey: "test-key",
};

test("content collection is disabled by default", () => {
  const config = resolveConfig(base);
  assert.equal(config.recordInputs, false);
  assert.equal(config.recordOutputs, false);
  assert.equal(config.recordReasoning, false);
  assert.equal(config.recordSessionTitle, false);
  assert.equal(config.recordUserId, false);
});

test("rejects invalid numeric limits", () => {
  assert.throws(() => resolveConfig({ ...base, maxContentLength: -1 }), /maxContentLength/);
  assert.throws(() => resolveConfig({ ...base, scheduledDelayMillis: Number.NaN }), /scheduledDelayMillis/);
});

test("rejects custom API hosts even when legacy opt-in is enabled", () => {
  for (const apiHost of ["127.0.0.1:8080", "10.0.0.1", "example.com"]) {
    assert.throws(
      () => resolveConfig({ ...base, apiHost, allowCustomEndpoint: true }),
      /custom apiHost is not supported/,
    );
  }
});

test("rejects custom OTLP mirror endpoints even when legacy opt-in is enabled", () => {
  assert.throws(
    () => resolveConfig({
      ...base,
      otlpMirrors: [{
        topicId: "eed5bd51-a7c0-4305-a5b5-8070d7e7abfe",
        endpoint: "https://127.0.0.1:8443/v1/traces",
        allowCustomEndpoint: true,
      }],
    }),
    /custom OTLP endpoint is not supported/,
  );
});

test("OTLP mirror headers cannot override reserved transport headers", () => {
  assert.throws(
    () => resolveConfig({
      ...base,
      otlpMirrors: [{
        topicId: "eed5bd51-a7c0-4305-a5b5-8070d7e7abfe",
        headers: { topic_id: "00000000-0000-4000-8000-000000000000" },
      }],
    }),
    /reserved header/i,
  );
});

test("OTLP mirror rejects inherited global OTLP credentials", () => {
  const previous = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=secret";
  try {
    assert.throws(
      () => resolveConfig({
        ...base,
        otlpMirrors: [{ topicId: "eed5bd51-a7c0-4305-a5b5-8070d7e7abfe" }],
      }),
      /global OTLP headers/i,
    );
  } finally {
    if (previous === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = previous;
  }
});

test("OTLP mirror never inherits the main CLS credential", () => {
  const previousHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  const previousTraceHeaders = process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
  try {
    const config = resolveConfig({
      ...base,
      otlpMirrors: [{
        topicId: "eed5bd51-a7c0-4305-a5b5-8070d7e7abfe",
        endpoint: "https://ap-shanghai.cls.tencentcs.com/v1/traces",
      }],
    });
    assert.deepEqual(config.otlpMirrors[0].headers, {
      topic_id: "eed5bd51-a7c0-4305-a5b5-8070d7e7abfe",
    });
  } finally {
    if (previousHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = previousHeaders;
    if (previousTraceHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = previousTraceHeaders;
  }
});
