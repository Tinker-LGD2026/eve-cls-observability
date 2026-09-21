import assert from "node:assert/strict";
import test from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resolveConfig } from "../dist/config.js";
import { clsObservability } from "../dist/index.js";
import { ClsSpanStore } from "../dist/span-store.js";

const baseConfig = {
  topicId: "00000000-0000-4000-8000-000000000000",
  region: "ap-shanghai",
  secretId: "test-id",
  secretKey: "test-key",
};

const scope = {
  attemptId: "attempt-1",
  attemptIndex: 0,
  sessionId: "session-1",
  stepIndex: 0,
  turnId: "turn-1",
};

const turnStarted = (turnId = "turn-1", sequence = 0) => ({
  type: "turn.started",
  idempotencyKey: `turn:session-1:${turnId}`,
  rootSessionId: "session-1",
  sequence,
  sessionId: "session-1",
  turnId,
});

const turnTerminal = (type, turnId = "turn-1") => ({
  type,
  idempotencyKey: `turn:session-1:${turnId}`,
  sessionId: "session-1",
  turnId,
});

const stepStarted = {
  type: "step.attempt.started",
  idempotencyKey: "attempt-1",
  operation: {
    modelId: "test-model",
    operationId: "operation-1",
    provider: "test-provider",
  },
  scope,
};

const stepCompleted = {
  type: "step.attempt.completed",
  idempotencyKey: "attempt-1",
  scope,
};

const modelStarted = {
  type: "model.call.started",
  idempotencyKey: "model-call-1",
  model: { modelId: "test-model", provider: "test-provider" },
  scope,
};

function createHarness(options = {}) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const pipeline = {
    tracer: provider.getTracer("span-store-test"),
    provider,
    flush: () => provider.forceFlush(),
  };
  const store = new ClsSpanStore(resolveConfig({ ...baseConfig, ...options }), pipeline);
  return { store, exporter, provider };
}

function findSpan(exporter, kind, predicate = () => true) {
  return exporter
    .getFinishedSpans()
    .find((span) => span.attributes["gen_ai.span.kind"] === kind && predicate(span));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

test("failed turn remains an error when error content is not captured", async () => {
  const { store, exporter, provider } = createHarness();
  store.onTurnStarted(turnStarted());
  store.onTurnFailed({ ...turnTerminal("turn.failed"), error: undefined });
  await provider.forceFlush();

  const entry = findSpan(exporter, "entry");
  const agent = findSpan(exporter, "agent");
  assert.ok(entry);
  assert.ok(agent);
  assert.equal(entry.status.code, SpanStatusCode.ERROR);
  assert.equal(agent.status.code, SpanStatusCode.ERROR);
  assert.equal(entry.attributes["error.type"], "TurnFailed");
  assert.equal(agent.attributes["error.type"], "TurnFailed");
  assert.equal(entry.status.message, undefined);
  assert.equal(agent.status.message, undefined);
  await provider.shutdown();
});

test("completed and cancelled turns expose distinct outcomes", async () => {
  const { store, exporter, provider } = createHarness();
  store.onTurnStarted(turnStarted("turn-completed", 0));
  store.onTurnSettled(turnTerminal("turn.completed", "turn-completed"));
  store.onTurnStarted(turnStarted("turn-cancelled", 1));
  store.onTurnSettled(turnTerminal("turn.cancelled", "turn-cancelled"));
  await provider.forceFlush();

  const completed = findSpan(
    exporter,
    "agent",
    (span) => span.attributes["gen_ai.turn.id"] === "session-1:t1",
  );
  const cancelled = findSpan(
    exporter,
    "agent",
    (span) => span.attributes["gen_ai.turn.id"] === "session-1:t2",
  );
  assert.ok(completed);
  assert.ok(cancelled);
  assert.equal(completed.status.code, SpanStatusCode.OK);
  assert.equal(cancelled.status.code, SpanStatusCode.OK);
  assert.equal(completed.attributes["agent.eve.turn.outcome"], "completed");
  assert.equal(cancelled.attributes["agent.eve.turn.outcome"], "cancelled");
  await provider.shutdown();
});

test("recordReasoning false excludes reasoning from chat and step spans", async () => {
  const { store, exporter, provider } = createHarness({
    recordOutputs: true,
    recordReasoning: false,
  });
  store.onTurnStarted(turnStarted());
  store.onStepStarted(stepStarted);
  store.onModelCallStarted(modelStarted);
  store.onModelCallCompleted({
    type: "model.call.completed",
    idempotencyKey: "model-call-1",
    finishReason: "stop",
    scope,
    usage: {},
    content: [
      { type: "reasoning", text: "private chain of thought" },
      { type: "text", text: "visible answer" },
    ],
  });
  store.onStepCompleted(stepCompleted);
  store.onTurnSettled(turnTerminal("turn.completed"));
  await provider.forceFlush();

  const chat = findSpan(exporter, "chat");
  const step = findSpan(exporter, "step");
  assert.ok(chat);
  assert.ok(step);
  const output = chat.attributes["gen_ai.output.messages"];
  assert.equal(typeof output, "string");
  assert.match(output, /visible answer/);
  assert.doesNotMatch(output, /private chain of thought/);
  assert.equal(hasOwn(step.attributes, "gen_ai.react.thought"), false);
  await provider.shutdown();
});

test("unknown model usage is not reported as zero on the agent span", async () => {
  const { store, exporter, provider } = createHarness();
  store.onTurnStarted(turnStarted());
  store.onStepStarted(stepStarted);
  store.onModelCallStarted(modelStarted);
  store.onModelCallCompleted({
    type: "model.call.completed",
    idempotencyKey: "model-call-1",
    finishReason: "stop",
    scope,
    usage: {},
  });
  store.onStepCompleted(stepCompleted);
  store.onTurnSettled(turnTerminal("turn.completed"));
  await provider.forceFlush();

  const agent = findSpan(exporter, "agent");
  assert.ok(agent);
  for (const key of [
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.total_tokens",
    "gen_ai.usage.cache_read.input_tokens",
    "gen_ai.usage.cache_creation.input_tokens",
  ]) {
    assert.equal(hasOwn(agent.attributes, key), false, `${key} must remain unknown`);
  }
  await provider.shutdown();
});

test("step completion closes an unterminated model span before its parent", async () => {
  const { store, exporter, provider } = createHarness();
  store.onTurnStarted(turnStarted());
  store.onStepStarted(stepStarted);
  store.onModelCallStarted(modelStarted);
  store.onStepCompleted(stepCompleted);
  await provider.forceFlush();

  const chat = findSpan(exporter, "chat");
  const step = findSpan(exporter, "step");
  assert.ok(chat, "attempt terminal must release the live model span");
  assert.ok(step);
  assert.equal(chat.status.code, SpanStatusCode.ERROR);
  assert.ok(chat.endTime[0] < step.endTime[0] ||
    (chat.endTime[0] === step.endTime[0] && chat.endTime[1] <= step.endTime[1]));

  store.onTurnSettled(turnTerminal("turn.completed"));
  await provider.shutdown();
});

test("session metadata is bounded by maxTrackedSessions", async () => {
  const { store, exporter, provider } = createHarness({ maxTrackedSessions: 2 });
  for (const [sessionId, agentName] of [["session-1", "oldest"], ["session-2", "middle"], ["session-3", "newest"]]) {
    store.onSessionStarted({
      type: "session.started",
      idempotencyKey: `session:${sessionId}`,
      sessionId,
      agentName,
    });
  }
  store.onTurnStarted({ ...turnStarted(), sessionId: "session-1", rootSessionId: "session-1" });
  store.onTurnSettled({ ...turnTerminal("turn.completed"), sessionId: "session-1" });
  await provider.forceFlush();

  const agent = findSpan(exporter, "agent");
  assert.ok(agent);
  assert.equal(agent.attributes["gen_ai.agent.name"], "main");
  await provider.shutdown();
});

test("tool parent index remains bounded during one long-lived session", async () => {
  const { store, exporter, provider } = createHarness({ maxTrackedSessions: 1 });
  store.onTurnStarted(turnStarted());
  for (let index = 0; index < 17; index += 1) {
    const callId = `call-${index}`;
    const idempotencyKey = `tool:attempt-1:${callId}:0`;
    store.onToolCallStarted({
      type: "tool.call.started",
      idempotencyKey,
      callId,
      toolName: "lookup",
      scope,
    });
    store.onToolCallCompleted({
      type: "tool.call.completed",
      idempotencyKey,
      output: { type: "result", output: "done" },
      scope,
    });
  }
  store.onSessionStarted({
    type: "session.started",
    idempotencyKey: "session:child",
    sessionId: "child",
    parentLineage: {
      sessionId: "session-1",
      turnId: "turn-1",
      callId: "call-0",
      subagentName: "child",
    },
  });
  store.onTurnStarted({
    ...turnStarted("child-turn", 0),
    sessionId: "child",
    rootSessionId: "session-1",
    parentLineage: {
      sessionId: "session-1",
      turnId: "turn-1",
      callId: "call-0",
      subagentName: "child",
    },
  });
  store.onTurnSettled({
    ...turnTerminal("turn.completed", "child-turn"),
    sessionId: "child",
  });
  store.onTurnSettled(turnTerminal("turn.completed"));
  await provider.forceFlush();
  const child = findSpan(
    exporter,
    "agent",
    (span) => span.attributes["gen_ai.agent.name"] === "child",
  );
  assert.ok(child);
  assert.equal(child.attributes["agent.eve.subagent.orphan"], 1);
  await provider.shutdown();
});

test("a new turn triggers TTL maintenance within the same session", async () => {
  const originalNow = Date.now;
  let now = 100_000;
  Date.now = () => now;
  const { store, exporter, provider } = createHarness({ stateTtlMs: 1_000 });
  try {
    store.onTurnStarted(turnStarted("stale-turn", 0));
    now += 1_001;
    store.onTurnStarted(turnStarted("fresh-turn", 1));
    await provider.forceFlush();
    const stale = findSpan(
      exporter,
      "agent",
      (span) => span.attributes["gen_ai.turn.id"] === "session-1:t1",
    );
    assert.ok(stale, "the second turn must evict the stale first turn");
    assert.equal(stale.attributes["agent.eve.turn.outcome"], "abandoned");
    store.onTurnSettled(turnTerminal("turn.completed", "fresh-turn"));
  } finally {
    Date.now = originalNow;
    await provider.shutdown();
  }
});

test("stale active turns are abandoned when state maintenance runs", async () => {
  const originalNow = Date.now;
  let now = 100_000;
  Date.now = () => now;
  const { store, exporter, provider } = createHarness({ stateTtlMs: 1_000 });
  try {
    store.onTurnStarted(turnStarted());
    now += 1_001;
    store.onSessionStarted({
      type: "session.started",
      idempotencyKey: "session:session-2",
      sessionId: "session-2",
      agentName: "second",
    });
    await provider.forceFlush();
    const agent = findSpan(exporter, "agent");
    assert.ok(agent, "stale active turn must be closed, not retained forever");
    assert.equal(agent.status.code, SpanStatusCode.ERROR);
    assert.equal(agent.attributes["agent.eve.turn.outcome"], "abandoned");
  } finally {
    Date.now = originalNow;
    await provider.shutdown();
  }
});

test("tool output is normalized once before being retained as a step observation", async () => {
  const { store, provider } = createHarness({ recordOutputs: true });
  let reads = 0;
  const output = {};
  Object.defineProperty(output, "value", {
    enumerable: true,
    get() {
      reads += 1;
      return "large tool output";
    },
  });
  store.onTurnStarted(turnStarted());
  store.onStepStarted(stepStarted);
  store.onToolCallStarted({
    type: "tool.call.started",
    idempotencyKey: "tool-call-1",
    callId: "call-1",
    toolName: "lookup",
    scope,
  });
  store.onToolCallCompleted({
    type: "tool.call.completed",
    idempotencyKey: "tool-call-1",
    callId: "call-1",
    toolName: "lookup",
    output: { type: "result", output },
    scope,
  });
  store.onStepCompleted(stepCompleted);
  store.onTurnSettled(turnTerminal("turn.completed"));
  assert.equal(reads, 1, "raw tool output must not be retained and serialized a second time");
  await provider.shutdown();
});

test("default-content model failure keeps structural error fields", async () => {
  const { store, exporter, provider } = createHarness();
  store.onTurnStarted(turnStarted());
  store.onStepStarted(stepStarted);
  store.onModelCallStarted(modelStarted);
  store.onModelCallFailed({
    type: "model.call.failed",
    idempotencyKey: "model-call-1",
    scope,
  });
  store.onStepCompleted(stepCompleted);
  store.onTurnSettled(turnTerminal("turn.completed"));
  await provider.forceFlush();
  const chat = findSpan(exporter, "chat");
  assert.ok(chat);
  assert.equal(chat.status.code, SpanStatusCode.ERROR);
  assert.deepEqual(chat.attributes["gen_ai.response.finish_reasons"], ["error"]);
  assert.equal(chat.attributes["error.type"], "ModelCallFailed");
  assert.equal(typeof chat.attributes["gen_ai.chat.duration_ms"], "number");
  await provider.shutdown();
});

test("cancelled turn marks unterminated model call as cancelled, not failed", async () => {
  const { store, exporter, provider } = createHarness();
  store.onTurnStarted(turnStarted());
  store.onStepStarted(stepStarted);
  store.onModelCallStarted(modelStarted);
  store.onTurnSettled(turnTerminal("turn.cancelled"));
  await provider.forceFlush();
  const chat = findSpan(exporter, "chat");
  assert.ok(chat);
  assert.notEqual(chat.status.code, SpanStatusCode.ERROR);
  assert.deepEqual(chat.attributes["gen_ai.response.finish_reasons"], ["cancelled"]);
  await provider.shutdown();
});

test("action events correlate to the active tool by exact call id", async () => {
  const { store, exporter, provider } = createHarness();
  store.onTurnStarted(turnStarted());
  store.onStepStarted(stepStarted);
  store.onToolCallStarted({
    type: "tool.call.started",
    idempotencyKey: "tool:attempt-1:call-1:0",
    callId: "call-1",
    toolName: "lookup",
    scope,
  });
  store.onActionStarted({
    type: "action.started",
    idempotencyKey: "action:session-1:turn-1:call-1",
    callId: "call-1",
    kind: "tool-call",
    name: "lookup",
    scope,
  });
  store.onActionCompleted({
    type: "action.completed",
    idempotencyKey: "action:session-1:turn-1:call-1",
    outcome: "completed",
    output: { type: "result", output: "done" },
    scope,
  });
  store.onToolCallCompleted({
    type: "tool.call.completed",
    idempotencyKey: "tool:attempt-1:call-1:0",
    output: { type: "result", output: "done" },
    scope,
  });
  store.onStepCompleted(stepCompleted);
  store.onTurnSettled(turnTerminal("turn.completed"));
  await provider.forceFlush();

  const tool = findSpan(exporter, "tool");
  assert.ok(tool);
  assert.equal(tool.attributes["agent.eve.action.outcome"], "completed");
  assert.ok(tool.events.some((event) => event.name === "action.started"));
  await provider.shutdown();
});

test("late action terminal remains observable after the tool span closes", async () => {
  const { store, exporter, provider } = createHarness();
  store.onTurnStarted(turnStarted());
  store.onStepStarted(stepStarted);
  store.onToolCallStarted({
    type: "tool.call.started",
    idempotencyKey: "tool:attempt-1:call-late:0",
    callId: "call-late",
    toolName: "background",
    scope,
  });
  store.onToolCallCompleted({
    type: "tool.call.completed",
    idempotencyKey: "tool:attempt-1:call-late:0",
    output: { type: "result", output: "accepted" },
    scope,
  });
  store.onStepCompleted(stepCompleted);
  store.onTurnSettled(turnTerminal("turn.completed"));
  store.onActionFailed({
    type: "action.failed",
    idempotencyKey: "action:session-1:turn-1:call-late",
    outcome: "rejected",
    errorCode: "DENIED",
    scope,
  });
  await provider.forceFlush();
  const action = exporter.getFinishedSpans().find(
    (span) => span.attributes["gen_ai.chain.name"] === "eve.action.rejected",
  );
  assert.ok(action);
  assert.equal(action.attributes["gen_ai.span.kind"], "chain");
  assert.equal(action.attributes["gen_ai.operation.name"], "eve.action");
  assert.equal(action.attributes["agent.eve.action.outcome"], "rejected");
  assert.equal(action.status.code, SpanStatusCode.ERROR);
  assert.equal(action.attributes["gen_ai.session.id"], "session-1");
  assert.equal(action.attributes["gen_ai.turn.id"], "session-1:t1");
  assert.equal(action.attributes["gen_ai.step.id"], "session-1:t1:s1");
  assert.equal(action.attributes["gen_ai.tool.call.id"], "call-late");
  await provider.shutdown();
});

test("forced tool close preserves CLS identity for a later action terminal", async () => {
  const { store, exporter, provider } = createHarness();
  store.onTurnStarted(turnStarted());
  store.onStepStarted(stepStarted);
  store.onToolCallStarted({
    type: "tool.call.started",
    idempotencyKey: "tool:attempt-1:call-forced:0",
    callId: "call-forced",
    toolName: "background",
    scope,
  });
  store.onTurnSettled(turnTerminal("turn.completed"));
  store.onActionFailed({
    type: "action.failed",
    idempotencyKey: "action:session-1:turn-1:call-forced",
    outcome: "rejected",
    scope,
  });
  await provider.forceFlush();
  const action = exporter.getFinishedSpans().find(
    (span) => span.attributes["gen_ai.chain.name"] === "eve.action.rejected",
  );
  assert.ok(action);
  assert.equal(action.attributes["gen_ai.session.id"], "session-1");
  assert.equal(action.attributes["gen_ai.turn.id"], "session-1:t1");
  assert.equal(action.attributes["gen_ai.step.id"], "session-1:t1:s1");
  assert.equal(action.attributes["gen_ai.tool.call.id"], "call-forced");
  await provider.shutdown();
});

test("durable recovery never points at a missing parent span", async () => {
  const { store, exporter, provider } = createHarness();
  store.onTurnStarted(turnStarted());
  store.onStepStarted(stepStarted);
  store.onModelCallCompleted({
    type: "model.call.completed",
    idempotencyKey: "model-call-resumed",
    finishReason: "stop",
    scope,
    usage: {},
  }, {
    version: 1,
    operation: "model",
    startMs: Date.now() - 10,
    traceId: "a".repeat(32),
    parentSpanId: "b".repeat(16),
    traceFlags: 1,
    name: "chat test-model",
    attributes: {
      "gen_ai.span.kind": "chat",
      "gen_ai.operation.name": "chat",
    },
    stepKey: "session-1|turn-1|0",
    turnKey: "session-1|turn-1",
    attemptId: "attempt-1",
  });
  store.onStepCompleted(stepCompleted);
  store.onTurnSettled(turnTerminal("turn.completed"));
  await provider.forceFlush();

  const chat = findSpan(exporter, "chat");
  const step = findSpan(exporter, "step");
  assert.ok(chat);
  assert.ok(step);
  assert.equal(chat.spanContext().traceId, step.spanContext().traceId);
  assert.equal(chat.parentSpanContext?.spanId, step.spanContext().spanId);
  assert.equal(chat.attributes["agent.eve.resumed"], true);
  await provider.shutdown();
});

test("content capture is restricted to public or development conversations", async () => {
  const provider = clsObservability({
    ...baseConfig,
    recordInputs: true,
    recordOutputs: true,
  });
  assert.ok(provider.tracePolicy);
  const context = {
    agentName: "main",
    audience: "private",
    channel: { kind: "api" },
    environment: "production",
    mode: "conversation",
    principalType: "user",
  };
  assert.deepEqual(provider.tracePolicy(context), {
    emit: true,
    recordInputs: false,
    recordOutputs: false,
  });
  assert.deepEqual(provider.tracePolicy({ ...context, audience: "public" }), {
    emit: true,
    recordInputs: true,
    recordOutputs: true,
  });
  assert.deepEqual(provider.tracePolicy({ ...context, environment: "development" }), {
    emit: true,
    recordInputs: true,
    recordOutputs: true,
  });
  await provider.shutdown();
});
