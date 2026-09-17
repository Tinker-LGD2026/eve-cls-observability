import type { Attributes } from "@opentelemetry/api";
import type { InstrumentationUsage } from "eve/instrumentation";
import { safeJsonAttribute, safeString } from "./content/safe-json.js";
import type { ClsMessage } from "./messages.js";

/** Backward-compatible wrapper around byte-safe, valid JSON serialization. */
export function cappedJson(value: unknown, maxLength: number): string | undefined {
  return safeJsonAttribute(value, maxLength)?.json;
}

export interface IdentityAttrs {
  readonly sessionId: string;
  readonly clsTurnId: string;
  readonly clsStepId?: string;
}

/** gen_ai identity chain present on every span (step/tool/chat add step.id). */
export function identityAttributes(identity: IdentityAttrs): Attributes {
  const attributes: Attributes = {
    "gen_ai.session.id": identity.sessionId,
    "gen_ai.turn.id": identity.clsTurnId,
  };
  if (identity.clsStepId !== undefined) {
    attributes["gen_ai.step.id"] = identity.clsStepId;
  }
  return attributes;
}

/** Token usage fields (chat span: per call; agent span: aggregated). */
export function usageAttributes(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): Attributes {
  const attributes: Attributes = {};
  if (usage.inputTokens !== undefined) {
    attributes["gen_ai.usage.input_tokens"] = usage.inputTokens;
  }
  if (usage.outputTokens !== undefined) {
    attributes["gen_ai.usage.output_tokens"] = usage.outputTokens;
  }
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    attributes["gen_ai.usage.total_tokens"] = usage.inputTokens + usage.outputTokens;
  }
  if (usage.cacheReadTokens !== undefined) {
    attributes["gen_ai.usage.cache_read.input_tokens"] = usage.cacheReadTokens;
  }
  if (usage.cacheWriteTokens !== undefined) {
    attributes["gen_ai.usage.cache_creation.input_tokens"] = usage.cacheWriteTokens;
  }
  return attributes;
}

export function usageFromEvent(usage: InstrumentationUsage): ReturnType<typeof usageAttributes> {
  return usageAttributes({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
  });
}

export interface ErrorInfo {
  readonly type: string;
  readonly message: string;
}

export function extractError(error: unknown): ErrorInfo {
  if (error instanceof Error) {
    return { type: error.name || "Error", message: error.message };
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as Record<string, unknown>;
    return {
      type: typeof candidate.name === "string" ? candidate.name : "Error",
      message: typeof candidate.message === "string" ? candidate.message : safeString(error),
    };
  }
  return { type: "Error", message: String(error) };
}

export function messagesAttribute(
  key: "gen_ai.input.messages" | "gen_ai.output.messages",
  messages: readonly ClsMessage[],
  maxLength: number,
): Attributes {
  const json = cappedJson(messages, maxLength);
  return json === undefined ? {} : { [key]: json };
}
