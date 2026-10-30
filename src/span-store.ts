import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { createRequire } from "node:module";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import type {
  InstrumentationActionCompletedEvent,
  InstrumentationActionFailedEvent,
  InstrumentationActionStartedEvent,
  InstrumentationInputRequestedEvent,
  InstrumentationInputResolvedEvent,
  InstrumentationModelCallCompletedEvent,
  InstrumentationModelCallFailedEvent,
  InstrumentationModelCallStartedEvent,
  InstrumentationSessionFailedEvent,
  InstrumentationSessionSettledEvent,
  InstrumentationSessionStartedEvent,
  InstrumentationStepAttemptCompletedEvent,
  InstrumentationStepAttemptFailedEvent,
  InstrumentationStepAttemptMetadataEvent,
  InstrumentationStepAttemptStartedEvent,
  InstrumentationToolCallCompletedEvent,
  InstrumentationToolCallFailedEvent,
  InstrumentationToolCallStartedEvent,
  InstrumentationTurnFailedEvent,
  InstrumentationTurnSettledEvent,
  InstrumentationTurnStartedEvent,
} from "eve/instrumentation";
import {
  cappedJson,
  extractError,
  identityAttributes,
  messagesAttribute,
  usageAttributes,
  usageFromEvent,
  type ErrorInfo,
} from "./assembler.js";
import type { ResolvedConfig } from "./config.js";
import type { SpanPipeline } from "./exporter.js";
import { clsStepId, clsTurnId } from "./ids.js";
import { MessageCursorStore } from "./content/message-cursor.js";
import {
  clsInputMessages,
  clsOutputMessage,
  lastUserMessage,
  normalizeFinishReason,
  systemInstructionsText,
  type ClsMessage,
} from "./messages.js";

interface UsageAggregate {
  sum: number;
  observed: number;
  missing: number;
}

interface UsageTotals {
  readonly inputTokens: UsageAggregate;
  readonly outputTokens: UsageAggregate;
  readonly cacheReadTokens: UsageAggregate;
  readonly cacheWriteTokens: UsageAggregate;
}

interface TerminalError {
  readonly type: string;
  readonly message?: string;
}

type TurnOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly error?: ErrorInfo }
  | { readonly kind: "abandoned"; readonly error: TerminalError };

interface TurnState {
  /** Eve runtime session id used for map lookup. */
  readonly sessionId: string;
  /** CLS identity shared by every span in this trace tree. */
  readonly clsSessionId: string;
  readonly turnId: string;
  readonly clsTurnId: string;
  readonly entrySpan?: Span;
  readonly agentSpan: Span;
  readonly startMs: number;
  readonly sequence: number;
  updatedAtMs: number;
  inputBackfilled: boolean;
  messageCount: number;
  toolCallCount: number;
  costUsd: number;
  readonly usage: UsageTotals;
  /**
   * Synthesized `chain` span covering eve-internal durable orchestration
   * that no lifecycle event spans: turn init (turn.started → first step)
   * and inter-step work (step.completed → next step.started — persistence,
   * queue scheduling, state hydration). Bounds are real event times; the
   * content is inferred, marked via `agent.eve.span.origin`.
   */
  pendingChain?: Span;
}

interface StepState {
  readonly span: Span;
  readonly turnKey: string;
  lastFinishReason: string;
  readonly observations: unknown[];
}

interface ChildSpanState {
  readonly span: Span;
  readonly startMs: number;
  readonly attemptId?: string;
  readonly stepKey?: string;
  readonly turnKey: string;
  readonly name?: string;
  readonly callId?: string;
  readonly actionKey?: string;
}

/** JSON-safe correlation state persisted through eve provider ctx.state. */
export interface DurableChildSnapshot {
  readonly version: 1;
  readonly operation: "model" | "tool";
  readonly startMs: number;
  readonly traceId: string;
  readonly parentSpanId: string;
  readonly traceFlags: number;
  readonly name: string;
  readonly attributes: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  readonly stepKey: string;
  readonly turnKey: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly attemptId?: string;
  readonly toolName?: string;
  readonly callId?: string;
}

const EVE_FRAMEWORK_VERSION = ((): string | undefined => {
  try {
    const require = createRequire(import.meta.url);
    return (require("eve/package.json") as { version?: string }).version;
  } catch {
    return undefined;
  }
})();

const HOST_NAME = hostname();

interface SubagentInfo {
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly parentToolCallId: string;
  readonly subagentName?: string;
}

interface SessionInfo {
  updatedAtMs: number;
  readonly agentName?: string;
  readonly channelKind?: string;
  readonly channelType?: string;
  readonly channelAudience?: string;
  readonly scheduleId?: string;
  readonly title?: string;
  readonly subagent?: SubagentInfo;
}

function turnKeyOf(sessionId: string, turnId: string): string {
  return `${sessionId}|${turnId}`;
}

function stepKeyOf(sessionId: string, turnId: string, stepIndex: number): string {
  return `${sessionId}|${turnId}|${stepIndex}`;
}

function actionKeyOf(sessionId: string, turnId: string, callId: string): string {
  return `action:${sessionId}:${turnId}:${callId}`;
}

function modelCallSequence(idempotencyKey: string): number {
  const value = Number(idempotencyKey.split(":").at(-1));
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function modelTimeToFirstResponseMs(
  event: InstrumentationModelCallCompletedEvent,
): number | undefined {
  const value = (
    event as InstrumentationModelCallCompletedEvent & {
      readonly timeToFirstResponseMs?: unknown;
    }
  ).timeToFirstResponseMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Maps an eve channel kind onto the CLS entry-type vocabulary. */
function entryTypeOf(channelKind: string | undefined): string {
  if (channelKind === undefined) return "api";
  const kind = channelKind.toLowerCase();
  if (kind === "cli" || kind === "ide" || kind === "gateway" || kind === "api") return kind;
  return "api";
}

/** Reads USD cost strings from AI Gateway provider metadata. */
function readGatewayCosts(
  providerMetadata: Readonly<Record<string, unknown>>,
): { total?: number; input?: number; output?: number } {
  const gateway = providerMetadata.gateway;
  if (typeof gateway !== "object" || gateway === null) return {};
  const read = (value: unknown): number | undefined => {
    if (typeof value !== "string") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const record = gateway as Record<string, unknown>;
  const result: { total?: number; input?: number; output?: number } = {};
  const total = read(record.cost);
  const input = read(record.inputInferenceCost);
  const output = read(record.outputInferenceCost);
  if (total !== undefined) result.total = total;
  if (input !== undefined) result.input = input;
  if (output !== undefined) result.output = output;
  return result;
}

function usageAggregate(): UsageAggregate {
  return { sum: 0, observed: 0, missing: 0 };
}

function usageTotals(): UsageTotals {
  return {
    inputTokens: usageAggregate(),
    outputTokens: usageAggregate(),
    cacheReadTokens: usageAggregate(),
    cacheWriteTokens: usageAggregate(),
  };
}

function recordUsage(target: UsageAggregate, value: number | undefined): void {
  if (value === undefined) {
    target.missing += 1;
    return;
  }
  target.sum += value;
  target.observed += 1;
}

function observedUsage(target: UsageAggregate): number | undefined {
  return target.observed > 0 ? target.sum : undefined;
}

function hasPartialUsage(usage: UsageTotals): boolean {
  return Object.values(usage).some((field) => field.observed > 0 && field.missing > 0);
}

/**
 * Span state machine: consumes eve instrumentation lifecycle events and
 * maintains the CLS span tree (entry → agent → step → chat/tool).
 * Handlers only touch in-memory state; export happens on a background batch.
 */
export class ClsSpanStore {
  readonly #config: ResolvedConfig;
  readonly #pipeline: SpanPipeline;
  readonly #turns = new Map<string, TurnState>();
  readonly #steps = new Map<string, StepState>();
  readonly #chats = new Map<string, ChildSpanState>();
  readonly #tools = new Map<string, ChildSpanState>();
  readonly #toolByActionKey = new Map<string, string>();
  readonly #pendingActionAttributes = new Map<string, Attributes>();
  readonly #closedActionParents = new Map<
    string,
    {
      traceId: string;
      spanId: string;
      traceFlags: number;
      createdAtMs: number;
      sessionId: string;
      turnId: string;
      stepId: string;
      callId: string;
    }
  >();
  readonly #sessionTurns = new Map<string, Set<string>>();
  readonly #sessions = new Map<string, SessionInfo>();
  /** Content-free, TTL/LRU-bounded cursor for messages_delta. */
  readonly #promptCursors: MessageCursorStore;
  /**
   * Our own trace identity of every tool call, kept after the span closes:
   * subagent sessions attach their invoke_subagent span to OUR parent
   * trace (eve's forwarded trace context belongs to eve's internal tracing
   * and would detach the tree). Key: sessionId|turnId|callId.
   */
  readonly #toolSpanIndex = new Map<
    string,
    { traceId: string; spanId: string; traceFlags: number; createdAtMs: number }
  >();

  constructor(config: ResolvedConfig, pipeline: SpanPipeline) {
    this.#config = config;
    this.#pipeline = pipeline;
    this.#promptCursors = new MessageCursorStore({
      maxSessions: config.maxTrackedSessions,
      ttlMs: config.stateTtlMs,
    });
  }

  // ---------------------------------------------------------------- session

  onSessionStarted(event: InstrumentationSessionStartedEvent): void {
    // Per-turn trace model: sessions emit no span, but their channel and
    // identity context enriches every entry/agent span of their turns.
    this.#sessions.set(event.sessionId, {
      updatedAtMs: Date.now(),
      ...(event.agentName !== undefined ? { agentName: event.agentName } : {}),
      ...(event.channelKind !== undefined ? { channelKind: event.channelKind } : {}),
      ...(event.channelType !== undefined ? { channelType: event.channelType } : {}),
      ...(event.channelAudience !== undefined
        ? { channelAudience: event.channelAudience }
        : {}),
      ...(event.scheduleId !== undefined ? { scheduleId: event.scheduleId } : {}),
      ...(event.title !== undefined ? { title: event.title } : {}),
      ...(event.parentLineage !== undefined
        ? {
            subagent: {
              parentSessionId: event.parentLineage.sessionId,
              parentTurnId: event.parentLineage.turnId,
              parentToolCallId: event.parentLineage.callId,
              ...(event.parentLineage.subagentName !== undefined
                ? { subagentName: event.parentLineage.subagentName }
                : {}),
            },
          }
        : {}),
    });
    this.#evictStaleState();
  }

  onSessionSettled(event: InstrumentationSessionSettledEvent): PromiseLike<void> {
    return this.#closeSession(event.sessionId, { kind: "completed" });
  }

  onSessionWaiting(_event: InstrumentationSessionSettledEvent): void {
    // Waiting is durable suspension, not terminal. Preserve all session state;
    // the BatchSpanProcessor drains asynchronously without blocking resume.
  }

  onSessionFailed(event: InstrumentationSessionFailedEvent): PromiseLike<void> {
    const error = event.error !== undefined ? extractError(event.error) : undefined;
    return this.#closeSession(event.sessionId, { kind: "failed", error });
  }

  // ------------------------------------------------------------------- turn

  onTurnStarted(event: InstrumentationTurnStartedEvent): void {
    this.#evictStaleState();
    const key = turnKeyOf(event.sessionId, event.turnId);
    if (this.#turns.has(key)) return; // durable replay idempotency
    const now = Date.now();
    const session = this.#sessions.get(event.sessionId);
    // turn.started repeats the lineage/root identity, so cross-generation
    // recovery does not depend solely on the in-memory session map.
    const eventLineage = event.parentLineage;
    const subagent = session?.subagent ??
      (eventLineage !== undefined
        ? {
            parentSessionId: eventLineage.sessionId,
            parentTurnId: eventLineage.turnId,
            parentToolCallId: eventLineage.callId,
            ...(eventLineage.subagentName !== undefined
              ? { subagentName: eventLineage.subagentName }
              : {}),
          }
        : undefined);
    const rawUserId = event.currentPrincipal?.id ?? event.initiatorPrincipal?.id;
    const userId =
      this.#config.recordUserId && rawUserId !== undefined
        ? this.#config.hashUserId
          ? createHash("sha256").update(rawUserId).digest("hex")
          : rawUserId
        : undefined;

    // Subagent turns nest inside the PARENT turn's trace (spec §3.9): no
    // entry span; the agent span parents to the dispatching tool span via
    // the forwarded trace context, and the root session id groups the tree.
    const clsSessionId =
      subagent !== undefined ? (event.rootSessionId ?? event.sessionId) : event.sessionId;
    const clsTurn =
      subagent !== undefined
        ? `${clsSessionId}:sub:${event.sessionId}:t${event.sequence + 1}`
        : clsTurnId(clsSessionId, event.sequence + 1);
    const identity = identityAttributes({ sessionId: clsSessionId, clsTurnId: clsTurn });

    const eveExtension: Record<string, string | number> = {
      "agent.eve.turn.sequence": event.sequence + 1,
      "agent.eve.host.name": HOST_NAME,
    };
    if (EVE_FRAMEWORK_VERSION !== undefined) {
      eveExtension["agent.eve.framework.version"] = EVE_FRAMEWORK_VERSION;
    }
    if (subagent !== undefined) {
      eveExtension["agent.eve.session.id"] = event.sessionId;
      eveExtension["agent.eve.root_session.id"] = clsSessionId;
    }
    if (session?.channelKind !== undefined) {
      eveExtension["agent.eve.channel.kind"] = session.channelKind;
    }
    if (session?.channelType !== undefined) {
      eveExtension["agent.eve.channel.type"] = session.channelType;
    }
    if (session?.channelAudience !== undefined) {
      eveExtension["agent.eve.session.audience"] = session.channelAudience;
    }
    if (this.#config.recordSessionTitle && session?.title !== undefined) {
      eveExtension["agent.eve.session.title"] = session.title;
    }
    if (session?.scheduleId !== undefined) {
      eveExtension["agent.eve.schedule.id"] = session.scheduleId;
    }

    let entrySpan: Span | undefined;
    let agentParentContext;
    if (subagent === undefined) {
      entrySpan = this.#pipeline.tracer.startSpan(
        "enter_application",
        {
          kind: SpanKind.SERVER,
          startTime: now,
          attributes: {
            "gen_ai.span.kind": "entry",
            "gen_ai.operation.name": "enter_application",
            "gen_ai.entry.type": entryTypeOf(session?.channelKind),
            ...(userId !== undefined ? { "gen_ai.user.id": userId } : {}),
            ...identity,
            ...eveExtension,
          },
        },
        // Explicit root: a fresh per-turn trace starts here. Passing no
        // context would inherit whatever ambient context the worker has.
        ROOT_CONTEXT,
      );
      agentParentContext = this.#parentOf(entrySpan);
    } else {
      const parentRef = this.#toolSpanIndex.get(
        `${subagent.parentSessionId}|${subagent.parentTurnId}|${subagent.parentToolCallId}`,
      );
      if (parentRef !== undefined) {
        agentParentContext = trace.setSpanContext(ROOT_CONTEXT, {
          traceId: parentRef.traceId,
          spanId: parentRef.spanId,
          traceFlags: parentRef.traceFlags,
          isRemote: true,
        });
      } else {
        // Parent tool span not found (e.g. parent predates plugin start or
        // the child task resumed on another runtime generation): start a
        // standalone trace rather than attach to eve's internal one.
        eveExtension["agent.eve.subagent.orphan"] = 1;
        if (this.#config.debug) {
          const lookup = `${subagent.parentSessionId}|${subagent.parentTurnId}|${subagent.parentToolCallId}`;
          console.error(
            `[eve-cls-observability] subagent orphan: lookupHash=${createHash("sha256").update(lookup).digest("hex").slice(0, 12)} indexSize=${this.#toolSpanIndex.size}`,
          );
        }
        agentParentContext = ROOT_CONTEXT;
      }
    }

    const agentName =
      subagent?.subagentName ?? event.agentName ?? session?.agentName ?? "main";
    const agentSpan = this.#pipeline.tracer.startSpan(
      `invoke_agent ${agentName}`,
      {
        kind: SpanKind.INTERNAL,
        startTime: now,
        attributes: {
          "gen_ai.span.kind": "agent",
          "gen_ai.operation.name": subagent !== undefined ? "invoke_subagent" : "invoke_agent",
          "gen_ai.agent.type": this.#config.agentType,
          "gen_ai.agent.name": agentName,
          ...(subagent !== undefined
            ? {
                "gen_ai.agent.scope": "subagent",
                "gen_ai.subagent.parent_tool_call.id": subagent.parentToolCallId,
              }
            : {}),
          ...(userId !== undefined ? { "gen_ai.user.id": userId } : {}),
          ...identity,
          ...eveExtension,
        },
      },
      agentParentContext,
    );

    const state: TurnState = {
      sessionId: event.sessionId,
      clsSessionId,
      turnId: event.turnId,
      clsTurnId: clsTurn,
      ...(entrySpan !== undefined ? { entrySpan } : {}),
      agentSpan,
      startMs: now,
      sequence: event.sequence + 1,
      updatedAtMs: now,
      inputBackfilled: false,
      messageCount: 0,
      toolCallCount: 0,
      costUsd: 0,
      usage: usageTotals(),
    };
    state.pendingChain = this.#openChain(state, "session_init", now);
    this.#turns.set(key, state);
    this.#trackSessionTurn(event.sessionId, key);
  }

  onTurnSettled(event: InstrumentationTurnSettledEvent): void {
    this.#closeTurn(turnKeyOf(event.sessionId, event.turnId), {
      kind: event.type === "turn.cancelled" ? "cancelled" : "completed",
    });
  }

  onTurnFailed(event: InstrumentationTurnFailedEvent): void {
    const error = event.error !== undefined ? extractError(event.error) : undefined;
    this.#closeTurn(turnKeyOf(event.sessionId, event.turnId), { kind: "failed", error });
  }

  // ------------------------------------------------------------------- step

  onStepStarted(event: InstrumentationStepAttemptStartedEvent): void {
    this.#maintainActiveState(event.scope.sessionId, event.scope.turnId);
    const turn = this.#turns.get(turnKeyOf(event.scope.sessionId, event.scope.turnId));
    if (turn === undefined) return;
    this.#closeChain(turn); // orchestration window ends where real work resumes
    const key = stepKeyOf(event.scope.sessionId, event.scope.turnId, event.scope.stepIndex);
    const existing = this.#steps.get(key);
    if (existing !== undefined) {
      existing.span.setAttribute("agent.eve.step.attempt", event.scope.attemptIndex);
      existing.span.addEvent("step.attempt.started", {
        "agent.eve.step.attempt": event.scope.attemptIndex,
      });
      return;
    }
    const round = event.scope.stepIndex + 1;
    const span = this.#pipeline.tracer.startSpan(
      `react round_${round}`,
      {
        kind: SpanKind.INTERNAL,
        startTime: Date.now(),
        attributes: {
          "gen_ai.span.kind": "step",
          "gen_ai.operation.name": "react",
          "gen_ai.react.round": round,
          ...identityAttributes({
            sessionId: turn.clsSessionId,
            clsTurnId: turn.clsTurnId,
            clsStepId: clsStepId(turn.clsTurnId, round),
          }),
        },
      },
      this.#parentOf(turn.agentSpan),
    );
    this.#steps.set(key, {
      span,
      turnKey: turnKeyOf(turn.sessionId, turn.turnId),
      lastFinishReason: "stop",
      observations: [],
    });
  }

  onStepCompleted(event: InstrumentationStepAttemptCompletedEvent): void {
    this.#closeAttemptChildren(event.scope.attemptId, {
      type: "IncompleteCall",
      message: "step attempt completed before child call settled",
    });
    const closed = this.#closeStep(
      stepKeyOf(event.scope.sessionId, event.scope.turnId, event.scope.stepIndex),
      undefined,
    );
    const turn = this.#turns.get(turnKeyOf(event.scope.sessionId, event.scope.turnId));
    if (closed && turn !== undefined) {
      this.#closeChain(turn);
      turn.pendingChain = this.#openChain(turn, "durable_orchestration", Date.now());
    }
  }

  onActionStarted(event: InstrumentationActionStartedEvent): void {
    this.#maintainActiveState(event.scope.sessionId, event.scope.turnId);
    const attributes: Attributes = {
      "agent.eve.action.kind": event.kind,
      "agent.eve.action.workflow": event.isWorkflowTool === true,
    };
    const toolKey = this.#toolByActionKey.get(event.idempotencyKey);
    const tool = toolKey !== undefined ? this.#tools.get(toolKey) : undefined;
    if (tool !== undefined) {
      tool.span.addEvent("action.started", attributes);
    } else {
      this.#pendingActionAttributes.set(event.idempotencyKey, attributes);
    }
  }

  onActionCompleted(event: InstrumentationActionCompletedEvent): void {
    this.#maintainActiveState(event.scope.sessionId, event.scope.turnId);
    this.#annotateAction(
      event.scope.sessionId,
      event.scope.turnId,
      event.scope.stepIndex,
      event.idempotencyKey,
      {
        "agent.eve.action.outcome": event.outcome,
        ...(event.acceptedAtMs !== undefined
          ? { "agent.eve.action.accepted_at_ms": event.acceptedAtMs }
          : {}),
      },
    );
  }

  onActionFailed(event: InstrumentationActionFailedEvent): void {
    this.#maintainActiveState(event.scope.sessionId, event.scope.turnId);
    this.#annotateAction(
      event.scope.sessionId,
      event.scope.turnId,
      event.scope.stepIndex,
      event.idempotencyKey,
      {
        "agent.eve.action.outcome": event.outcome,
        ...(event.errorCode !== undefined
          ? { "agent.eve.action.error_code": event.errorCode }
          : {}),
        ...(event.acceptedAtMs !== undefined
          ? { "agent.eve.action.accepted_at_ms": event.acceptedAtMs }
          : {}),
      },
    );
  }

  onInputRequested(event: InstrumentationInputRequestedEvent): void {
    this.#maintainActiveState(event.scope.sessionId, event.scope.turnId);
    const step = this.#steps.get(
      stepKeyOf(event.scope.sessionId, event.scope.turnId, event.scope.stepIndex),
    );
    step?.span.addEvent("input.requested", {
      "agent.eve.input.kind": event.kind,
      "agent.eve.input.request_id": event.requestId,
    });
  }

  onInputResolved(event: InstrumentationInputResolvedEvent): void {
    this.#maintainActiveState(event.scope.sessionId, event.scope.turnId);
    const step = this.#steps.get(
      stepKeyOf(event.scope.sessionId, event.scope.turnId, event.scope.stepIndex),
    );
    step?.span.addEvent("input.resolved", {
      "agent.eve.input.kind": event.kind,
      "agent.eve.input.request_id": event.requestId,
      "agent.eve.input.outcome": event.outcome,
    });
  }

  onStepFailed(event: InstrumentationStepAttemptFailedEvent): void {
    this.#maintainActiveState(event.scope.sessionId, event.scope.turnId);
    const error = event.error !== undefined ? extractError(event.error) : undefined;
    this.#closeAttemptChildren(
      event.scope.attemptId,
      error ?? { type: "StepAttemptFailed", message: "step attempt failed" },
    );
    const step = this.#steps.get(
      stepKeyOf(event.scope.sessionId, event.scope.turnId, event.scope.stepIndex),
    );
    if (step === undefined) return;
    // Attempt failure is not logical-step terminal: eve may retry with the
    // same stepIndex. Preserve the step and record the failed attempt.
    step.span.addEvent("step.attempt.failed", {
      "agent.eve.step.attempt": event.scope.attemptIndex,
      ...(error !== undefined
        ? { "error.type": error.type, "exception.message": error.message }
        : {}),
    });
    step.lastFinishReason = "error";
  }

  onStepAttemptMetadata(event: InstrumentationStepAttemptMetadataEvent): void {
    this.#maintainActiveState(event.scope.sessionId, event.scope.turnId);
    // AI Gateway cost rides provider metadata; DeepSeek/direct providers
    // simply carry none. Costs aggregate onto the agent span at turn close.
    const costs = readGatewayCosts(event.providerMetadata);
    if (costs.total === undefined) return;
    const turn = this.#turns.get(turnKeyOf(event.scope.sessionId, event.scope.turnId));
    if (turn === undefined) return;
    turn.costUsd += costs.total;
    const step = this.#steps.get(
      stepKeyOf(event.scope.sessionId, event.scope.turnId, event.scope.stepIndex),
    );
    step?.span.setAttribute("agent.eve.step.cost_usd", costs.total);
  }

  // ------------------------------------------------------------------- chat

  onModelCallStarted(
    event: InstrumentationModelCallStartedEvent,
  ): DurableChildSnapshot | undefined {
    this.#maintainActiveState(event.scope.sessionId, event.scope.turnId);
    const existing = this.#chats.get(event.idempotencyKey);
    if (existing !== undefined) return undefined;
    const turn = this.#turns.get(turnKeyOf(event.scope.sessionId, event.scope.turnId));
    if (turn === undefined) return undefined;
    turn.updatedAtMs = Date.now();
    const stepKey = stepKeyOf(event.scope.sessionId, event.scope.turnId, event.scope.stepIndex);
    const step = this.#steps.get(stepKey);
    const round = event.scope.stepIndex + 1;
    const attributes: Record<string, unknown> = {
      "gen_ai.span.kind": "chat",
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": event.model.provider,
      "gen_ai.system": event.model.provider,
      "gen_ai.request.model": event.model.modelId,
      "gen_ai.react.round": round,
      ...identityAttributes({
        sessionId: turn.clsSessionId,
        clsTurnId: turn.clsTurnId,
        clsStepId: clsStepId(turn.clsTurnId, round),
      }),
    };

    if (event.input !== undefined && this.#config.recordInputs) {
      const instructions = systemInstructionsText(event.input.instructions);
      if (instructions !== undefined) {
        const json = cappedJson(
          [{ type: "text", content: instructions }],
          this.#config.maxContentLength,
        );
        if (json !== undefined) attributes["gen_ai.system_instructions"] = json;
      }
      const messages = clsInputMessages(event.input.messages, this.#config.recordReasoning);
      const cursorVersion =
        turn.sequence * 1_000_000_000 +
        event.scope.stepIndex * 1_000_000 +
        event.scope.attemptIndex * 1_000 +
        modelCallSequence(event.idempotencyKey);
      Object.assign(
        attributes,
        this.#inputMessagesAttribute(event.scope.sessionId, messages, cursorVersion),
      );
      if (!turn.inputBackfilled) {
        turn.inputBackfilled = true;
        const firstUser = lastUserMessage(event.input.messages);
        this.#backfillEntryMessages(turn, "gen_ai.input.messages", firstUser);
      }
    }

    if (event.scope.attemptIndex > 0) {
      attributes["agent.eve.step.attempt"] = event.scope.attemptIndex;
    }
    const parent = step !== undefined ? this.#parentOf(step.span) : this.#parentOf(turn.agentSpan);
    const parentContext = trace.getSpanContext(parent);
    const startMs = Date.now();
    const name = `chat ${event.model.modelId}`;
    const span = this.#pipeline.tracer.startSpan(
      name,
      { kind: SpanKind.CLIENT, startTime: startMs, attributes: attributes as never },
      parent,
    );
    const turnKey = turnKeyOf(turn.sessionId, turn.turnId);
    this.#chats.set(event.idempotencyKey, {
      span,
      startMs,
      attemptId: event.scope.attemptId,
      stepKey,
      turnKey,
    });
    const spanContext = span.spanContext();
    return {
      version: 1,
      operation: "model",
      startMs,
      traceId: spanContext.traceId,
      parentSpanId: parentContext?.spanId ?? "",
      traceFlags: spanContext.traceFlags,
      name,
      attributes: attributes as DurableChildSnapshot["attributes"],
      stepKey,
      turnKey,
      sessionId: event.scope.sessionId,
      turnId: event.scope.turnId,
      attemptId: event.scope.attemptId,
    };
  }

  onModelCallCompleted(
    event: InstrumentationModelCallCompletedEvent,
    durable?: DurableChildSnapshot,
  ): void {
    this.#maintainActiveState(event.scope.sessionId, event.scope.turnId);
    let state = this.#chats.get(event.idempotencyKey);
    if (state === undefined && durable?.operation === "model") {
      state = this.#recoverChild(event.idempotencyKey, durable, this.#chats);
    }
    if (state === undefined) return;
    this.#chats.delete(event.idempotencyKey);
    const turn = this.#turns.get(state.turnKey);
    const finishReason = normalizeFinishReason(event.finishReason);
    const timeToFirstResponseMs = modelTimeToFirstResponseMs(event);

    const attributes: Record<string, unknown> = {
      "gen_ai.response.finish_reasons": [finishReason],
      "gen_ai.chat.duration_ms": Date.now() - state.startMs,
      ...(timeToFirstResponseMs !== undefined
        ? { "gen_ai.response.time_to_first_token_ms": timeToFirstResponseMs }
        : {}),
      ...usageFromEvent(event.usage),
    };
    if (event.responseId !== undefined) attributes["gen_ai.response.id"] = event.responseId;
    if (event.content !== undefined && this.#config.recordOutputs) {
      const output = clsOutputMessage(
        event.content,
        event.finishReason,
        this.#config.recordReasoning,
      );
      Object.assign(
        attributes,
        messagesAttribute("gen_ai.output.messages", [output], this.#config.maxContentLength),
      );
      if (turn !== undefined) {
        this.#backfillEntryMessages(turn, "gen_ai.output.messages", [output]);
      }
      if (this.#config.recordReasoning) {
        const thought = event.content
          .filter((part) => part.type === "reasoning")
          .map((part) => part.text)
          .filter((text) => text.trim().length > 0)
          .join("\n");
        if (thought.length > 0) {
          const stepState = this.#steps.get(state.stepKey ?? "");
          stepState?.span.setAttribute(
            "gen_ai.react.thought",
            thought.length <= this.#config.maxContentLength
              ? thought
              : `${thought.slice(0, this.#config.maxContentLength)}… [truncated]`,
          );
        }
      }
    }
    state.span.setAttributes(attributes as never);
    state.span.setStatus(
      finishReason === "error"
        ? { code: SpanStatusCode.ERROR, message: "model finished with error" }
        : { code: SpanStatusCode.OK },
    );
    state.span.end();

    const step = this.#steps.get(state.stepKey ?? "");
    if (step !== undefined) step.lastFinishReason = finishReason;
    if (turn !== undefined) {
      turn.messageCount += 1;
      recordUsage(turn.usage.inputTokens, event.usage.inputTokens);
      recordUsage(turn.usage.outputTokens, event.usage.outputTokens);
      recordUsage(turn.usage.cacheReadTokens, event.usage.inputTokenDetails?.cacheReadTokens);
      recordUsage(turn.usage.cacheWriteTokens, event.usage.inputTokenDetails?.cacheWriteTokens);
    }
  }

  onModelCallFailed(
    event: InstrumentationModelCallFailedEvent,
    durable?: DurableChildSnapshot,
  ): void {
    this.#maintainActiveState(event.scope.sessionId, event.scope.turnId);
    let state = this.#chats.get(event.idempotencyKey);
    if (state === undefined && durable?.operation === "model") {
      state = this.#recoverChild(event.idempotencyKey, durable, this.#chats);
    }
    if (state === undefined) return;
    this.#chats.delete(event.idempotencyKey);
    const error = event.error !== undefined ? extractError(event.error) : undefined;
    state.span.setAttributes({
      "gen_ai.chat.duration_ms": Date.now() - state.startMs,
      "gen_ai.response.finish_reasons": ["error"],
      "error.type": error?.type ?? "ModelCallFailed",
    } as never);
    state.span.setStatus({
      code: SpanStatusCode.ERROR,
      ...(error !== undefined && this.#config.recordOutputs ? { message: error.message } : {}),
    });
    state.span.end();
    const step = this.#steps.get(state.stepKey ?? "");
    if (step !== undefined) step.lastFinishReason = "error";
  }

  // ------------------------------------------------------------------- tool

  onToolCallStarted(
    event: InstrumentationToolCallStartedEvent,
  ): DurableChildSnapshot | undefined {
    this.#maintainActiveState(event.scope.sessionId, event.scope.turnId);
    if (this.#tools.has(event.idempotencyKey)) return undefined;
    const turn = this.#turns.get(turnKeyOf(event.scope.sessionId, event.scope.turnId));
    if (turn === undefined) return undefined;
    turn.updatedAtMs = Date.now();
    const stepKey = stepKeyOf(event.scope.sessionId, event.scope.turnId, event.scope.stepIndex);
    const step = this.#steps.get(stepKey);
    const round = event.scope.stepIndex + 1;
    const attributes: Record<string, unknown> = {
      "gen_ai.span.kind": "tool",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": event.toolName,
      "gen_ai.tool.type": "function",
      "gen_ai.tool.call.id": event.callId,
      ...identityAttributes({
        sessionId: turn.clsSessionId,
        clsTurnId: turn.clsTurnId,
        clsStepId: clsStepId(turn.clsTurnId, round),
      }),
    };
    if (event.input !== undefined && this.#config.recordInputs) {
      const json = cappedJson(event.input, this.#config.maxContentLength);
      if (json !== undefined) attributes["gen_ai.tool.call.arguments"] = json;
    }
    const parent = step !== undefined ? this.#parentOf(step.span) : this.#parentOf(turn.agentSpan);
    const parentContext = trace.getSpanContext(parent);
    const startMs = Date.now();
    const name = `execute_tool ${event.toolName}`;
    const span = this.#pipeline.tracer.startSpan(
      name,
      { kind: SpanKind.CLIENT, startTime: startMs, attributes: attributes as never },
      parent,
    );
    const spanContext = span.spanContext();
    const actionKey = actionKeyOf(event.scope.sessionId, event.scope.turnId, event.callId);
    this.#toolSpanIndex.set(
      `${event.scope.sessionId}|${event.scope.turnId}|${event.callId}`,
      {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        traceFlags: spanContext.traceFlags,
        createdAtMs: Date.now(),
      },
    );
    this.#evictStaleState();
    const turnKey = turnKeyOf(turn.sessionId, turn.turnId);
    this.#tools.set(event.idempotencyKey, {
      span,
      startMs,
      attemptId: event.scope.attemptId,
      stepKey,
      turnKey,
      name: event.toolName,
      callId: event.callId,
      actionKey,
    });
    this.#toolByActionKey.set(actionKey, event.idempotencyKey);
    const pendingAction = this.#pendingActionAttributes.get(actionKey);
    if (pendingAction !== undefined) {
      span.addEvent("action.started", pendingAction);
      this.#pendingActionAttributes.delete(actionKey);
    }
    return {
      version: 1,
      operation: "tool",
      startMs,
      traceId: spanContext.traceId,
      parentSpanId: parentContext?.spanId ?? "",
      traceFlags: spanContext.traceFlags,
      name,
      attributes: attributes as DurableChildSnapshot["attributes"],
      stepKey,
      turnKey,
      attemptId: event.scope.attemptId,
      toolName: event.toolName,
      callId: event.callId,
    };
  }

  onToolCallCompleted(
    event: InstrumentationToolCallCompletedEvent,
    durable?: DurableChildSnapshot,
  ): void {
    this.#maintainActiveState(event.scope.sessionId, event.scope.turnId);
    let state = this.#tools.get(event.idempotencyKey);
    if (state === undefined && durable?.operation === "tool") {
      state = this.#recoverChild(event.idempotencyKey, durable, this.#tools);
    }
    if (state === undefined) return;
    this.#tools.delete(event.idempotencyKey);
    this.#releaseActionIndex(state);
    // eve reports in-band tool failures as a completed call whose output is
    // `{ type: "error", ... }` rather than firing tool.call.failed.
    const failed =
      typeof event.output === "object" &&
      event.output !== null &&
      (event.output as { type?: unknown }).type === "error";
    const errorDetail =
      failed && "error" in event.output && event.output.error !== undefined
        ? extractError(event.output.error)
        : undefined;
    const actualOutput = event.output.type === "result" ? event.output.output : undefined;
    let normalizedOutput: unknown;
    const attributes: Record<string, unknown> = {
      "gen_ai.tool.call.duration_ms": Date.now() - state.startMs,
    };
    if (this.#config.recordOutputs && actualOutput !== undefined) {
      const json = cappedJson(actualOutput, this.#config.maxContentLength);
      if (json !== undefined) {
        attributes["gen_ai.tool.call.result"] = json;
        normalizedOutput = JSON.parse(json) as unknown;
      }
    }
    if (failed) {
      attributes["gen_ai.tool.error.type"] = errorDetail?.type ?? "execution_error";
      if (errorDetail !== undefined) {
        attributes["gen_ai.tool.error.message"] = errorDetail.message;
        attributes["error.type"] = errorDetail.type;
      }
    }
    state.span.setAttributes(attributes as never);
    state.span.setStatus(
      failed
        ? {
            code: SpanStatusCode.ERROR,
            ...(errorDetail !== undefined ? { message: errorDetail.message } : {}),
          }
        : { code: SpanStatusCode.OK },
    );
    state.span.end();
    const step = this.#steps.get(state.stepKey ?? "");
    if (step !== undefined) {
      if (failed) {
        step.observations.push({ tool: state.name ?? "unknown", error: errorDetail ?? "execution_error" });
      } else if (normalizedOutput !== undefined) {
        step.observations.push({ tool: state.name ?? "unknown", output: normalizedOutput });
      }
    }
    const turn = this.#turns.get(state.turnKey);
    if (turn !== undefined) turn.toolCallCount += 1;
  }

  onToolCallFailed(
    event: InstrumentationToolCallFailedEvent,
    durable?: DurableChildSnapshot,
  ): void {
    this.#maintainActiveState(event.scope.sessionId, event.scope.turnId);
    let state = this.#tools.get(event.idempotencyKey);
    if (state === undefined && durable?.operation === "tool") {
      state = this.#recoverChild(event.idempotencyKey, durable, this.#tools);
    }
    if (state === undefined) return;
    this.#tools.delete(event.idempotencyKey);
    this.#releaseActionIndex(state);
    const error = event.error !== undefined ? extractError(event.error) : undefined;
    state.span.setAttributes({
      "gen_ai.tool.call.duration_ms": Date.now() - state.startMs,
      ...(error !== undefined && this.#config.recordOutputs
        ? {
            "gen_ai.tool.error.type": error.type,
            "gen_ai.tool.error.message": error.message,
            "error.type": error.type,
          }
        : {}),
    } as never);
    state.span.setStatus({
      code: SpanStatusCode.ERROR,
      ...(error !== undefined ? { message: error.message } : {}),
    });
    state.span.end();
    const failedStep = this.#steps.get(state.stepKey ?? "");
    if (failedStep !== undefined) {
      failedStep.observations.push({ tool: state.name ?? "unknown", error: error ?? "unknown" });
    }
    const turn = this.#turns.get(state.turnKey);
    if (turn !== undefined) turn.toolCallCount += 1;
  }

  // ----------------------------------------------------------------- closes

  async shutdown(): Promise<void> {
    const outcome: TurnOutcome = {
      kind: "abandoned",
      error: { type: "Abandoned", message: "provider shutdown before turn settled" },
    };
    for (const key of [...this.#turns.keys()]) this.#closeTurn(key, outcome);
    for (const sessionId of [...this.#sessions.keys()]) {
      this.#sessions.delete(sessionId);
      this.#promptCursors.delete(sessionId);
    }
    this.#toolSpanIndex.clear();
    let flushError: unknown;
    try {
      await this.#pipeline.flush();
    } catch (error) {
      flushError = error;
    } finally {
      await this.#pipeline.provider.shutdown().catch((error) => {
        if (flushError === undefined) flushError = error;
      });
    }
    if (flushError !== undefined) throw flushError;
  }

  #closeAttemptChildren(attemptId: string, error: TerminalError): void {
    for (const [chatKey, chat] of this.#chats) {
      if (chat.attemptId !== attemptId) continue;
      this.#chats.delete(chatKey);
      chat.span.setAttributes({
        "gen_ai.chat.duration_ms": Date.now() - chat.startMs,
        "gen_ai.response.finish_reasons": ["error"],
        "error.type": error.type,
      });
      chat.span.setStatus({
        code: SpanStatusCode.ERROR,
        ...(error.message !== undefined ? { message: error.message } : {}),
      });
      chat.span.end();
    }
    for (const [toolKey, tool] of this.#tools) {
      if (tool.attemptId !== attemptId) continue;
      this.#tools.delete(toolKey);
      this.#releaseActionIndex(tool);
      tool.span.setAttributes({
        "gen_ai.tool.call.duration_ms": Date.now() - tool.startMs,
        "gen_ai.tool.error.type": error.type,
        "error.type": error.type,
      });
      tool.span.setStatus({
        code: SpanStatusCode.ERROR,
        ...(error.message !== undefined ? { message: error.message } : {}),
      });
      tool.span.end();
    }
  }

  #closeStep(key: string, error: TerminalError | undefined, finishReason?: string): boolean {
    const step = this.#steps.get(key);
    if (step === undefined) return false;
    this.#steps.delete(key);
    step.span.setAttribute(
      "gen_ai.react.finish_reason",
      finishReason ?? (error !== undefined ? "error" : step.lastFinishReason),
    );
    if (step.observations.length > 0 && this.#config.recordOutputs) {
      const json = cappedJson(step.observations, this.#config.maxContentLength);
      if (json !== undefined) step.span.setAttribute("gen_ai.react.observation", json);
    }
    if (error !== undefined) {
      step.span.setStatus({
        code: SpanStatusCode.ERROR,
        ...(error.message !== undefined ? { message: error.message } : {}),
      });
    } else {
      step.span.setStatus({ code: SpanStatusCode.OK });
    }
    step.span.end();
    return true;
  }

  #closeTurn(key: string, outcome: TurnOutcome): void {
    const turn = this.#turns.get(key);
    if (turn === undefined) return;

    const terminalError: TerminalError | undefined =
      outcome.kind === "failed"
        ? (outcome.error ?? { type: "TurnFailed" })
        : outcome.kind === "abandoned"
          ? outcome.error
          : undefined;

    // Force-close anything still open under this turn (orphans on failure paths).
    // Children must end before their parent step to preserve temporal validity.
    for (const [chatKey, chat] of this.#chats) {
      if (chat.turnKey === key) {
        this.#chats.delete(chatKey);
        if (outcome.kind === "cancelled") {
          chat.span.setAttributes({
            "gen_ai.chat.duration_ms": Date.now() - chat.startMs,
            "gen_ai.response.finish_reasons": ["cancelled"],
          });
          chat.span.setStatus({ code: SpanStatusCode.UNSET });
        } else {
          chat.span.setStatus({
            code: SpanStatusCode.ERROR,
            message: "turn ended before model call settled",
          });
        }
        chat.span.end();
      }
    }
    for (const [toolKey, tool] of this.#tools) {
      if (tool.turnKey === key) {
        this.#tools.delete(toolKey);
        this.#releaseActionIndex(tool);
        if (outcome.kind === "cancelled") {
          tool.span.setAttributes({
            "gen_ai.tool.call.duration_ms": Date.now() - tool.startMs,
            "agent.eve.action.outcome": "cancelled",
          });
          tool.span.setStatus({ code: SpanStatusCode.UNSET });
        } else {
          tool.span.setStatus({
            code: SpanStatusCode.ERROR,
            message: "turn ended before tool call settled",
          });
        }
        tool.span.end();
      }
    }
    for (const [stepKey, step] of this.#steps) {
      if (step.turnKey === key) {
        this.#closeStep(
          stepKey,
          terminalError,
          outcome.kind === "cancelled" ? "cancelled" : undefined,
        );
      }
    }

    const usage = {
      inputTokens: observedUsage(turn.usage.inputTokens),
      outputTokens: observedUsage(turn.usage.outputTokens),
      cacheReadTokens: observedUsage(turn.usage.cacheReadTokens),
      cacheWriteTokens: observedUsage(turn.usage.cacheWriteTokens),
    };
    turn.agentSpan.setAttributes({
      "gen_ai.agent.message_count": turn.messageCount,
      "gen_ai.agent.tool_call_count": turn.toolCallCount,
      "agent.eve.turn.outcome": outcome.kind,
      ...(turn.costUsd > 0 ? { "gen_ai.usage.total_cost": turn.costUsd } : {}),
      ...(hasPartialUsage(turn.usage) ? { "agent.eve.usage.partial": true } : {}),
      ...usageAttributes(usage),
    } as never);

    if (terminalError !== undefined) {
      const status = {
        code: SpanStatusCode.ERROR,
        ...(terminalError.message !== undefined ? { message: terminalError.message } : {}),
      };
      turn.agentSpan.setStatus(status);
      turn.entrySpan?.setStatus(status);
      turn.agentSpan.setAttribute("error.type", terminalError.type);
      turn.entrySpan?.setAttribute("error.type", terminalError.type);
    } else {
      turn.agentSpan.setStatus({ code: SpanStatusCode.OK });
      turn.entrySpan?.setStatus({ code: SpanStatusCode.OK });
    }
    this.#closeChain(turn);
    turn.agentSpan.end();
    turn.entrySpan?.end();
    this.#turns.delete(key);
    this.#untrackSessionTurn(turn.sessionId, key);
  }

  async #closeSession(sessionId: string, outcome: TurnOutcome): Promise<void> {
    const turnKeys = this.#sessionTurns.get(sessionId);
    if (turnKeys !== undefined) {
      for (const key of [...turnKeys]) this.#closeTurn(key, outcome);
    }
    this.#sessionTurns.delete(sessionId);
    this.#sessions.delete(sessionId);
    this.#promptCursors.delete(sessionId);
    for (const key of [...this.#toolSpanIndex.keys()]) {
      if (key.startsWith(`${sessionId}|`)) this.#toolSpanIndex.delete(key);
    }
    await this.#pipeline.flush();
  }

  // ----------------------------------------------------------------- helpers

  /**
   * Emits full input messages on the session's first chat, then
   * delta+hash while the prompt grows by strict prefix extension.
   * Hash is md5 of the full serialized prompt (32-hex, per CLS spec).
   */
  #inputMessagesAttribute(
    sessionId: string,
    messages: readonly ClsMessage[],
    version: number,
  ): Record<string, string> {
    const advance = this.#promptCursors.advance(sessionId, messages, version);
    const result: Record<string, string> = {
      "gen_ai.input.messages.hash": advance.hash,
    };
    if (advance.kind === "stale") return result;
    if (this.#config.messageDelta && advance.kind === "delta") {
      const delta = cappedJson(
        [{ type: "append", messages: advance.messages }],
        this.#config.maxContentLength,
      );
      if (delta !== undefined) result["gen_ai.input.messages_delta"] = delta;
    } else {
      const full = cappedJson(advance.messages, this.#config.maxContentLength);
      if (full !== undefined) result["gen_ai.input.messages"] = full;
    }
    return result;
  }

  #backfillEntryMessages(
    turn: TurnState,
    key: "gen_ai.input.messages" | "gen_ai.output.messages",
    messages: readonly ClsMessage[],
  ): void {
    const attrs = messagesAttribute(key, messages, this.#config.maxContentLength);
    turn.entrySpan?.setAttributes(attrs as never);
    turn.agentSpan.setAttributes(attrs as never);
  }

  #releaseActionIndex(tool: ChildSpanState): void {
    if (tool.actionKey === undefined) return;
    this.#toolByActionKey.delete(tool.actionKey);
    const context = tool.span.spanContext();
    const turn = this.#turns.get(tool.turnKey);
    const clsSessionId = turn?.clsSessionId ?? tool.turnKey.split("|")[0] ?? "unknown";
    const clsTurnId = turn?.clsTurnId ?? tool.turnKey.replace("|", ":");
    const stepIndex = Number(tool.stepKey?.split("|").at(-1) ?? 0);
    this.#closedActionParents.set(tool.actionKey, {
      traceId: context.traceId,
      spanId: context.spanId,
      traceFlags: context.traceFlags,
      createdAtMs: Date.now(),
      sessionId: clsSessionId,
      turnId: clsTurnId,
      stepId: clsStepId(clsTurnId, Number.isSafeInteger(stepIndex) ? stepIndex + 1 : 1),
      callId: tool.callId ?? tool.actionKey.split(":").at(-1) ?? "unknown",
    });
    this.#pendingActionAttributes.delete(tool.actionKey);
    while (this.#closedActionParents.size > this.#config.maxTrackedSessions * 16) {
      const oldest = this.#closedActionParents.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#closedActionParents.delete(oldest);
    }
  }

  #annotateAction(
    sessionId: string,
    turnId: string,
    stepIndex: number,
    idempotencyKey: string,
    attributes: Attributes,
  ): void {
    const toolKey = this.#toolByActionKey.get(idempotencyKey);
    const tool = toolKey !== undefined ? this.#tools.get(toolKey) : undefined;
    if (tool !== undefined) {
      tool.span.setAttributes(attributes);
      tool.span.addEvent("action.terminal", attributes);
      return;
    }
    const closedParent = this.#closedActionParents.get(idempotencyKey);
    if (closedParent !== undefined) {
      this.#closedActionParents.delete(idempotencyKey);
      const parent = trace.setSpanContext(ROOT_CONTEXT, {
        traceId: closedParent.traceId,
        spanId: closedParent.spanId,
        traceFlags: closedParent.traceFlags,
        isRemote: true,
      });
      const outcome = attributes["agent.eve.action.outcome"];
      const actionOutcome = typeof outcome === "string" ? outcome : "terminal";
      const span = this.#pipeline.tracer.startSpan(
        `chain eve.action.${actionOutcome}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            // `chain` is a CLS compatibility classification, not an OTel
            // GenAI well-known operation. Use a namespaced custom operation.
            "gen_ai.span.kind": "chain",
            "gen_ai.operation.name": "eve.action",
            "gen_ai.chain.name": `eve.action.${actionOutcome}`,
            "gen_ai.tool.call.id": closedParent.callId,
            "agent.eve.span.origin": "synthesized",
            ...identityAttributes({
              sessionId: closedParent.sessionId,
              clsTurnId: closedParent.turnId,
              clsStepId: closedParent.stepId,
            }),
            ...attributes,
          },
        },
        parent,
      );
      span.setStatus(
        outcome === "failed" || outcome === "abandoned" || outcome === "rejected"
          ? { code: SpanStatusCode.ERROR }
          : { code: SpanStatusCode.OK },
      );
      span.end();
      return;
    }
    const pending = this.#pendingActionAttributes.get(idempotencyKey);
    this.#pendingActionAttributes.set(idempotencyKey, { ...pending, ...attributes });
    while (this.#pendingActionAttributes.size > this.#config.maxTrackedSessions * 16) {
      const oldest = this.#pendingActionAttributes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#pendingActionAttributes.delete(oldest);
    }
  }

  #recoverChild(
    idempotencyKey: string,
    durable: DurableChildSnapshot,
    destination: Map<string, ChildSpanState>,
  ): ChildSpanState {
    const previousContext = {
      traceId: durable.traceId,
      spanId: durable.parentSpanId,
      traceFlags: durable.traceFlags,
      isRemote: true,
    };
    const currentStep = this.#steps.get(durable.stepKey);
    const currentTurn = this.#turns.get(durable.turnKey);
    const currentParent =
      currentStep !== undefined
        ? this.#parentOf(currentStep.span)
        : currentTurn !== undefined
          ? this.#parentOf(currentTurn.agentSpan)
          : ROOT_CONTEXT;
    const hasCurrentParent = currentStep !== undefined || currentTurn !== undefined;
    const span = this.#pipeline.tracer.startSpan(
      durable.name,
      {
        kind: SpanKind.CLIENT,
        startTime: durable.startMs,
        links: [{ context: previousContext }],
        attributes: {
          ...durable.attributes,
          "agent.eve.resumed": true,
          ...(!hasCurrentParent ? { "agent.eve.resumed.orphan": true } : {}),
        } as Attributes,
      },
      currentParent,
    );
    const actionKey =
      durable.operation === "tool" &&
      durable.callId !== undefined &&
      durable.sessionId !== undefined &&
      durable.turnId !== undefined
        ? actionKeyOf(durable.sessionId, durable.turnId, durable.callId)
        : undefined;
    const state: ChildSpanState = {
      span,
      startMs: durable.startMs,
      ...(durable.attemptId !== undefined ? { attemptId: durable.attemptId } : {}),
      stepKey: durable.stepKey,
      turnKey: durable.turnKey,
      ...(durable.toolName !== undefined ? { name: durable.toolName } : {}),
      ...(durable.callId !== undefined ? { callId: durable.callId } : {}),
      ...(actionKey !== undefined ? { actionKey } : {}),
    };
    destination.set(idempotencyKey, state);
    if (destination === this.#tools && actionKey !== undefined) {
      this.#toolByActionKey.set(actionKey, idempotencyKey);
      const context = span.spanContext();
      this.#toolSpanIndex.set(
        `${durable.sessionId}|${durable.turnId}|${durable.callId}`,
        {
          traceId: context.traceId,
          spanId: context.spanId,
          traceFlags: context.traceFlags,
          createdAtMs: Date.now(),
        },
      );
    }
    return state;
  }

  #parentOf(parent: Span) {
    return trace.setSpanContext(ROOT_CONTEXT, parent.spanContext());
  }

  /**
   * Synthesized chain span for eve-internal orchestration windows. Bounds
   * are real event times; content is inferred durable bookkeeping, marked
   * with `agent.eve.span.origin=synthesized` for honesty.
   */
  #openChain(turn: TurnState, phase: "session_init" | "durable_orchestration", startMs: number): Span {
    return this.#pipeline.tracer.startSpan(
      `chain ${phase}`,
      {
        kind: SpanKind.INTERNAL,
        startTime: startMs,
        attributes: {
          // CLS uses `chain` to render framework orchestration. OTel GenAI
          // has no well-known `chain` operation, so this stays namespaced.
          "gen_ai.span.kind": "chain",
          "gen_ai.operation.name": "eve.orchestration",
          "gen_ai.chain.name": `eve.${phase}`,
          "agent.eve.span.origin": "synthesized",
          "agent.eve.phase": phase,
          ...identityAttributes({ sessionId: turn.clsSessionId, clsTurnId: turn.clsTurnId }),
        },
      },
      this.#parentOf(turn.agentSpan),
    );
  }

  #closeChain(turn: TurnState): void {
    if (turn.pendingChain === undefined) return;
    turn.pendingChain.setStatus({ code: SpanStatusCode.OK });
    turn.pendingChain.end();
    turn.pendingChain = undefined;
  }

  #maintainActiveState(sessionId: string, turnId: string): void {
    const now = Date.now();
    const turn = this.#turns.get(turnKeyOf(sessionId, turnId));
    if (turn !== undefined) turn.updatedAtMs = now;
    const session = this.#sessions.get(sessionId);
    if (session !== undefined) session.updatedAtMs = now;
    this.#evictStaleState();
  }

  #evictStaleState(): void {
    const cutoff = Date.now() - this.#config.stateTtlMs;
    const abandoned = {
      kind: "abandoned",
      error: { type: "StateExpired", message: "instrumentation state exceeded its idle TTL" },
    } as const;
    for (const [key, turn] of [...this.#turns]) {
      if (turn.updatedAtMs < cutoff) this.#closeTurn(key, abandoned);
    }
    for (const [key, value] of this.#toolSpanIndex) {
      if (value.createdAtMs < cutoff) this.#toolSpanIndex.delete(key);
    }
    for (const [key, value] of this.#closedActionParents) {
      if (value.createdAtMs < cutoff) this.#closedActionParents.delete(key);
    }
    while (this.#pendingActionAttributes.size > this.#config.maxTrackedSessions * 16) {
      const oldest = this.#pendingActionAttributes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#pendingActionAttributes.delete(oldest);
    }
    for (const [sessionId, session] of [...this.#sessions]) {
      if (session.updatedAtMs < cutoff && !this.#sessionTurns.has(sessionId)) {
        this.#sessions.delete(sessionId);
        this.#promptCursors.delete(sessionId);
      }
    }
    while (this.#toolSpanIndex.size > this.#config.maxTrackedSessions * 16) {
      const oldest = this.#toolSpanIndex.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#toolSpanIndex.delete(oldest);
    }
    while (this.#sessions.size > this.#config.maxTrackedSessions) {
      const oldest = this.#sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const turnKeys = this.#sessionTurns.get(oldest);
      if (turnKeys !== undefined) {
        for (const key of [...turnKeys]) this.#closeTurn(key, abandoned);
      }
      this.#sessions.delete(oldest);
      this.#promptCursors.delete(oldest);
    }
    this.#promptCursors.evictExpired();
  }

  #trackSessionTurn(sessionId: string, turnKey: string): void {
    const set = this.#sessionTurns.get(sessionId) ?? new Set<string>();
    set.add(turnKey);
    this.#sessionTurns.set(sessionId, set);
  }

  #untrackSessionTurn(sessionId: string, turnKey: string): void {
    const turns = this.#sessionTurns.get(sessionId);
    turns?.delete(turnKey);
    if (turns?.size === 0) this.#sessionTurns.delete(sessionId);
  }
}
