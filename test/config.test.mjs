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

test("rejects unsafe custom API hosts unless explicitly allowed", () => {
  assert.throws(
    () => resolveConfig({ ...base, apiHost: "127.0.0.1:8080" }),
    /allowCustomEndpoint/,
  );
});

test("OTLP mirror never inherits the main CLS credential", () => {
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
});
