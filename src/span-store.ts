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

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

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
  readonly stepKey?: string;
  readonly turnKey: string;
  readonly name?: string;
  readonly callId?: string;
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
  readonly toolName?: string;
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
  }

  onSessionSettled(event: InstrumentationSessionSettledEvent): PromiseLike<void> {
    return this.#closeSession(event.sessionId, undefined);
  }

  onSessionWaiting(_event: InstrumentationSessionSettledEvent): void {
    // Waiting is durable suspension, not terminal. Preserve all session state;
    // the BatchSpanProcessor drains asynchronously without blocking resume.
  }

  onSessionFailed(event: InstrumentationSessionFailedEvent): PromiseLike<void> {
    const error = event.error !== undefined ? extractError(event.error) : undefined;
    return this.#closeSession(event.sessionId, error);
  }

  // ------------------------------------------------------------------- turn

  onTurnStarted(event: InstrumentationTurnStartedEvent): void {
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
      inputBackfilled: false,
      messageCount: 0,
      toolCallCount: 0,
      costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    state.pendingChain = this.#openChain(state, "session_init", now);
    this.#turns.set(key, state);
    this.#trackSessionTurn(event.sessionId, key);
  }

  onTurnSettled(event: InstrumentationTurnSettledEvent): void {
    this.#closeTurn(turnKeyOf(event.sessionId, event.turnId), undefined);
  }

  onTurnFailed(event: InstrumentationTurnFailedEvent): void {
    const error = event.error !== undefined ? extractError(event.error) : undefined;
    this.#closeTurn(turnKeyOf(event.sessionId, event.turnId), error);
  }

  // ------------------------------------------------------------------- step

  onStepStarted(event: InstrumentationStepAttemptStartedEvent): void {
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
    this.#closeStep(
      stepKeyOf(event.scope.sessionId, event.scope.turnId, event.scope.stepIndex),
      undefined,
    );
    const turn = this.#turns.get(turnKeyOf(event.scope.sessionId, event.scope.turnId));
    if (turn !== undefined) {
      turn.pendingChain = this.#openChain(turn, "durable_orchestration", Date.now());
    }
  }

  onActionStarted(event: InstrumentationActionStartedEvent): void {
    const tool = this.#tools.get(`tool:${event.scope.sessionId}:${event.scope.turnId}:${event.callId}`);
    tool?.span.addEvent("action.started", {
      "agent.eve.action.kind": event.kind,
      "agent.eve.action.workflow": event.isWorkflowTool === true,
    });
  }

  onActionCompleted(event: InstrumentationActionCompletedEvent): void {
    this.#annotateAction(event.scope.sessionId, event.scope.turnId, event.idempotencyKey, {
      "agent.eve.action.outcome": event.outcome,
      ...(event.acceptedAtMs !== undefined
        ? { "agent.eve.action.accepted_at_ms": event.acceptedAtMs }
        : {}),
    });
  }

  onActionFailed(event: InstrumentationActionFailedEvent): void {
    this.#annotateAction(event.scope.sessionId, event.scope.turnId, event.idempotencyKey, {
      "agent.eve.action.outcome": event.outcome,
      ...(event.errorCode !== undefined ? { "agent.eve.action.error_code": event.errorCode } : {}),
      ...(event.acceptedAtMs !== undefined
        ? { "agent.eve.action.accepted_at_ms": event.acceptedAtMs }
        : {}),
    });
  }

  onInputRequested(event: InstrumentationInputRequestedEvent): void {
    const step = this.#steps.get(
      stepKeyOf(event.scope.sessionId, event.scope.turnId, event.scope.stepIndex),
    );
    step?.span.addEvent("input.requested", {
      "agent.eve.input.kind": event.kind,
      "agent.eve.input.request_id": event.requestId,
    });
  }

  onInputResolved(event: InstrumentationInputResolvedEvent): void {
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
    const error = event.error !== undefined ? extractError(event.error) : undefined;
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
    const existing = this.#chats.get(event.idempotencyKey);
    if (existing !== undefined) return undefined;
    const turn = this.#turns.get(turnKeyOf(event.scope.sessionId, event.scope.turnId));
    if (turn === undefined) return undefined;
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
        turn.sequence * 1_000_000 + event.scope.stepIndex * 100 + event.scope.attemptIndex;
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
    };
  }

  onModelCallCompleted(
    event: InstrumentationModelCallCompletedEvent,
    durable?: DurableChildSnapshot,
  ): void {
    let state = this.#chats.get(event.idempotencyKey);
    if (state === undefined && durable?.operation === "model") {
      state = this.#recoverChild(event.idempotencyKey, durable, this.#chats);
    }
    if (state === undefined) return;
    this.#chats.delete(event.idempotencyKey);
    const turn = this.#turns.get(state.turnKey);
    const finishReason = normalizeFinishReason(event.finishReason);

    const attributes: Record<string, unknown> = {
      "gen_ai.response.finish_reasons": [finishReason],
      "gen_ai.chat.duration_ms": Date.now() - state.startMs,
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
      turn.usage.inputTokens += event.usage.inputTokens ?? 0;
      turn.usage.outputTokens += event.usage.outputTokens ?? 0;
      turn.usage.cacheReadTokens += event.usage.inputTokenDetails?.cacheReadTokens ?? 0;
      turn.usage.cacheWriteTokens += event.usage.inputTokenDetails?.cacheWriteTokens ?? 0;
    }
  }

  onModelCallFailed(
    event: InstrumentationModelCallFailedEvent,
    durable?: DurableChildSnapshot,
  ): void {
    let state = this.#chats.get(event.idempotencyKey);
    if (state === undefined && durable?.operation === "model") {
      state = this.#recoverChild(event.idempotencyKey, durable, this.#chats);
    }
    if (state === undefined) return;
    this.#chats.delete(event.idempotencyKey);
    const error = event.error !== undefined ? extractError(event.error) : undefined;
    if (error !== undefined && this.#config.recordOutputs) {
      state.span.setAttributes({
        "error.type": error.type,
        "gen_ai.response.finish_reasons": ["error"],
      } as never);
      state.span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    } else {
      state.span.setStatus({ code: SpanStatusCode.ERROR });
    }
    state.span.end();
    const step = this.#steps.get(state.stepKey ?? "");
    if (step !== undefined) step.lastFinishReason = "error";
  }

  // ------------------------------------------------------------------- tool

  onToolCallStarted(
    event: InstrumentationToolCallStartedEvent,
  ): DurableChildSnapshot | undefined {
    if (this.#tools.has(event.idempotencyKey)) return undefined;
    const turn = this.#turns.get(turnKeyOf(event.scope.sessionId, event.scope.turnId));
    if (turn === undefined) return undefined;
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
    this.#toolSpanIndex.set(
      `${event.scope.sessionId}|${event.scope.turnId}|${event.callId}`,
      {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        traceFlags: spanContext.traceFlags,
        createdAtMs: Date.now(),
      },
    );
    const turnKey = turnKeyOf(turn.sessionId, turn.turnId);
    this.#tools.set(event.idempotencyKey, {
      span,
      startMs,
      stepKey,
      turnKey,
      name: event.toolName,
      callId: event.callId,
    });
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
      toolName: event.toolName,
    };
  }

  onToolCallCompleted(
    event: InstrumentationToolCallCompletedEvent,
    durable?: DurableChildSnapshot,
  ): void {
    let state = this.#tools.get(event.idempotencyKey);
    if (state === undefined && durable?.operation === "tool") {
      state = this.#recoverChild(event.idempotencyKey, durable, this.#tools);
    }
    if (state === undefined) return;
    this.#tools.delete(event.idempotencyKey);
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
    const attributes: Record<string, unknown> = {
      "gen_ai.tool.call.duration_ms": Date.now() - state.startMs,
    };
    if (this.#config.recordOutputs && actualOutput !== undefined) {
      const json = cappedJson(actualOutput, this.#config.maxContentLength);
      if (json !== undefined) attributes["gen_ai.tool.call.result"] = json;
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
      step.observations.push(
        failed
          ? { tool: state.name ?? "unknown", error: errorDetail ?? "execution_error" }
          : { tool: state.name ?? "unknown", output: actualOutput },
      );
    }
    const turn = this.#turns.get(state.turnKey);
    if (turn !== undefined) turn.toolCallCount += 1;
  }

  onToolCallFailed(
    event: InstrumentationToolCallFailedEvent,
    durable?: DurableChildSnapshot,
  ): void {
    let state = this.#tools.get(event.idempotencyKey);
    if (state === undefined && durable?.operation === "tool") {
      state = this.#recoverChild(event.idempotencyKey, durable, this.#tools);
    }
    if (state === undefined) return;
    this.#tools.delete(event.idempotencyKey);
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
    const abandoned = { type: "Abandoned", message: "provider shutdown before turn settled" };
    for (const key of [...this.#turns.keys()]) this.#closeTurn(key, abandoned);
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

  #closeStep(key: string, error: { type: string; message: string } | undefined): void {
    const step = this.#steps.get(key);
    if (step === undefined) return;
    this.#steps.delete(key);
    step.span.setAttribute("gen_ai.react.finish_reason", error !== undefined ? "error" : step.lastFinishReason);
    if (step.observations.length > 0 && this.#config.recordOutputs) {
      const json = cappedJson(step.observations, this.#config.maxContentLength);
      if (json !== undefined) step.span.setAttribute("gen_ai.react.observation", json);
    }
    if (error !== undefined) {
      step.span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    } else {
      step.span.setStatus({ code: SpanStatusCode.OK });
    }
    step.span.end();
  }

  #closeTurn(key: string, error: { type: string; message: string } | undefined): void {
    const turn = this.#turns.get(key);
    if (turn === undefined) return;
    this.#turns.delete(key);
    this.#untrackSessionTurn(turn.sessionId, key);

    // Force-close anything still open under this turn (orphans on failure paths).
    // Children must end before their parent step to preserve temporal validity.
    for (const [chatKey, chat] of this.#chats) {
      if (chat.turnKey === key) {
        this.#chats.delete(chatKey);
        chat.span.setStatus({ code: SpanStatusCode.ERROR, message: "turn ended before model call settled" });
        chat.span.end();
      }
    }
    for (const [toolKey, tool] of this.#tools) {
      if (tool.turnKey === key) {
        this.#tools.delete(toolKey);
        tool.span.setStatus({ code: SpanStatusCode.ERROR, message: "turn ended before tool call settled" });
        tool.span.end();
      }
    }
    for (const [stepKey, step] of this.#steps) {
      if (step.turnKey === key) this.#closeStep(stepKey, error);
    }

    turn.agentSpan.setAttributes({
      "gen_ai.agent.message_count": turn.messageCount,
      "gen_ai.agent.tool_call_count": turn.toolCallCount,
      ...(turn.costUsd > 0 ? { "gen_ai.usage.total_cost": turn.costUsd } : {}),
      ...usageAttributes({
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        cacheReadTokens: turn.usage.cacheReadTokens,
        cacheWriteTokens: turn.usage.cacheWriteTokens,
      }),
    } as never);

    if (error !== undefined) {
      turn.agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      turn.entrySpan?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      turn.agentSpan.setAttribute("error.type", error.type);
      turn.entrySpan?.setAttribute("error.type", error.type);
    } else {
      turn.agentSpan.setStatus({ code: SpanStatusCode.OK });
      turn.entrySpan?.setStatus({ code: SpanStatusCode.OK });
    }
    this.#closeChain(turn);
    turn.agentSpan.end();
    turn.entrySpan?.end();
  }

  async #closeSession(
    sessionId: string,
    error: { type: string; message: string } | undefined,
  ): Promise<void> {
    const turnKeys = this.#sessionTurns.get(sessionId);
    if (turnKeys !== undefined) {
      for (const key of [...turnKeys]) await this.#closeTurn(key, error);
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

  #annotateAction(
    sessionId: string,
    turnId: string,
    idempotencyKey: string,
    attributes: Attributes,
  ): void {
    const callId = idempotencyKey.split(":").pop();
    if (callId === undefined) return;
    for (const tool of this.#tools.values()) {
      if (
        tool.turnKey === turnKeyOf(sessionId, turnId) &&
        (tool.callId === callId || idempotencyKey.endsWith(`:${tool.callId ?? ""}`))
      ) {
        tool.span.setAttributes(attributes);
        tool.span.addEvent("action.terminal", attributes);
        return;
      }
    }
  }

  #recoverChild(
    idempotencyKey: string,
    durable: DurableChildSnapshot,
    destination: Map<string, ChildSpanState>,
  ): ChildSpanState {
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: durable.traceId,
      spanId: durable.parentSpanId,
      traceFlags: durable.traceFlags,
      isRemote: true,
    });
    const span = this.#pipeline.tracer.startSpan(
      durable.name,
      {
        kind: SpanKind.CLIENT,
        startTime: durable.startMs,
        attributes: {
          ...durable.attributes,
          "agent.eve.resumed": true,
        } as Attributes,
      },
      parent,
    );
    const state: ChildSpanState = {
      span,
      startMs: durable.startMs,
      stepKey: durable.stepKey,
      turnKey: durable.turnKey,
      ...(durable.toolName !== undefined ? { name: durable.toolName } : {}),
    };
    destination.set(idempotencyKey, state);
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
          "gen_ai.span.kind": "chain",
          "gen_ai.operation.name": "chain",
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

  #evictStaleState(): void {
    const cutoff = Date.now() - this.#config.stateTtlMs;
    for (const [key, value] of this.#toolSpanIndex) {
      if (value.createdAtMs < cutoff) this.#toolSpanIndex.delete(key);
    }
    while (this.#toolSpanIndex.size > this.#config.maxTrackedSessions * 16) {
      const oldest = this.#toolSpanIndex.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#toolSpanIndex.delete(oldest);
    }
    while (this.#sessions.size > this.#config.maxTrackedSessions) {
      const oldest = this.#sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
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
    this.#sessionTurns.get(sessionId)?.delete(turnKey);
  }
}
