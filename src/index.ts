import { defineInstrumentation, type JsonValue } from "eve/instrumentation";
import { resolveConfig, type ClsObservabilityOptions } from "./config.js";
import { createSpanPipeline } from "./exporter.js";
import { ClsSpanStore, type DurableChildSnapshot } from "./span-store.js";

export type { ClsObservabilityOptions } from "./config.js";

function readDurableChild(value: unknown): DurableChildSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<DurableChildSnapshot>;
  return candidate.version === 1 &&
    (candidate.operation === "model" || candidate.operation === "tool") &&
    typeof candidate.startMs === "number" &&
    typeof candidate.traceId === "string" &&
    typeof candidate.parentSpanId === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.stepKey === "string" &&
    typeof candidate.turnKey === "string"
    ? (candidate as DurableChildSnapshot)
    : undefined;
}

/**
 * CLS Agent observability provider for eve.
 *
 * Usage — `agent/instrumentation.ts`:
 * ```ts
 * import { clsObservability } from "eve-cls-observability";
 * export default clsObservability(); // config via CLS_* env vars or options
 * ```
 *
 * Emits CLS Agent Trace spec spans (entry → agent → step → chat/tool) through
 * the native CLS UploadLog protobuf API. Content capture additionally depends on eve's
 * audience/environment gate: record content requires a `public` session
 * audience or a development environment.
 */
export function clsObservability(options: ClsObservabilityOptions = {}) {
  const config = resolveConfig(options);
  const pipeline = createSpanPipeline(config);
  const store = new ClsSpanStore(config, pipeline);
  if (config.debug) {
    console.error(
      `[eve-cls-observability] provider registered: topic=${config.topicId} region=${config.region}`,
    );
  }

  return defineInstrumentation({
    tracePolicy: (traceContext) => {
      const contentAllowed =
        traceContext.audience === "public" || traceContext.environment === "development";
      return {
        emit: true,
        recordInputs: config.recordInputs && contentAllowed,
        recordOutputs: config.recordOutputs && contentAllowed,
      };
    },
    flush: () => pipeline.flush(),
    shutdown: () => store.shutdown(),
    events: {
      "session.started": (event) => store.onSessionStarted(event),
      "session.completed": (event) => store.onSessionSettled(event),
      "session.waiting": (event) => store.onSessionWaiting(event),
      "session.failed": (event) => store.onSessionFailed(event),
      "turn.started": (event) => store.onTurnStarted(event),
      "turn.completed": (event) => store.onTurnSettled(event),
      "turn.cancelled": (event) => store.onTurnSettled(event),
      "turn.failed": (event) => store.onTurnFailed(event),
      "step.attempt.started": (event) => store.onStepStarted(event),
      "step.attempt.completed": (event) => store.onStepCompleted(event),
      "step.attempt.failed": (event) => store.onStepFailed(event),
      "step.attempt.metadata": (event) => store.onStepAttemptMetadata(event),
      "action.started": (event) => store.onActionStarted(event),
      "action.completed": (event) => store.onActionCompleted(event),
      "action.failed": (event) => store.onActionFailed(event),
      "input.requested": (event) => store.onInputRequested(event),
      "input.resolved": (event) => store.onInputResolved(event),
      "model.call.started": (event, ctx) => {
        if (ctx.state.get() !== undefined) return;
        const snapshot = store.onModelCallStarted(event);
        if (snapshot !== undefined) ctx.state.set(snapshot as unknown as JsonValue);
      },
      "model.call.completed": (event, ctx) => {
        store.onModelCallCompleted(event, readDurableChild(ctx.state.get()));
        ctx.state.set(undefined);
      },
      "model.call.failed": (event, ctx) => {
        store.onModelCallFailed(event, readDurableChild(ctx.state.get()));
        ctx.state.set(undefined);
      },
      "tool.call.started": (event, ctx) => {
        if (ctx.state.get() !== undefined) return;
        const snapshot = store.onToolCallStarted(event);
        if (snapshot !== undefined) ctx.state.set(snapshot as unknown as JsonValue);
      },
      "tool.call.completed": (event, ctx) => {
        store.onToolCallCompleted(event, readDurableChild(ctx.state.get()));
        ctx.state.set(undefined);
      },
      "tool.call.failed": (event, ctx) => {
        store.onToolCallFailed(event, readDurableChild(ctx.state.get()));
        ctx.state.set(undefined);
      },
    },
  });
}
