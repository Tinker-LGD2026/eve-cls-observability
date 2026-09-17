import type { InstrumentationContentPart } from "eve/instrumentation";

export interface ClsMessagePart {
  readonly type: string;
  readonly content?: unknown;
  readonly id?: string | null;
  readonly name?: string;
  readonly arguments?: unknown;
  readonly response?: unknown;
}

export interface ClsMessage {
  readonly role: string;
  readonly parts: readonly ClsMessagePart[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentPartFromPrompt(
  part: unknown,
  recordReasoning: boolean,
): ClsMessagePart | undefined {
  if (!isRecord(part)) return undefined;
  if (part.type === "text" && typeof part.text === "string") {
    return { type: "text", content: part.text };
  }
  if (
    recordReasoning &&
    part.type === "reasoning" &&
    typeof part.text === "string"
  ) {
    return { type: "reasoning", content: part.text };
  }
  if (part.type === "tool-call") {
    return {
      type: "tool_call",
      id: typeof part.toolCallId === "string" ? part.toolCallId : null,
      name: typeof part.toolName === "string" ? part.toolName : undefined,
      arguments: part.input,
    };
  }
  if (part.type === "tool-result") {
    const output = isRecord(part.output) ? (part.output.value ?? part.output) : part.output;
    return {
      type: "tool_call_response",
      id: typeof part.toolCallId === "string" ? part.toolCallId : null,
      response: output,
    };
  }
  if (part.type === "file") {
    return { type: "file", content: "[file omitted]" };
  }
  return undefined;
}

/**
 * Serializes AI SDK prompt messages into the CLS message schema:
 * `[{role, parts:[{type, content, ...}]}]`. System messages are skipped
 * (they travel in `gen_ai.system_instructions`).
 */
export function clsInputMessages(
  messages: readonly unknown[],
  recordReasoning = false,
): ClsMessage[] {
  const out: ClsMessage[] = [];
  for (const message of messages) {
    if (!isRecord(message) || typeof message.role !== "string" || message.role === "system") {
      continue;
    }
    const content = message.content;
    const parts: ClsMessagePart[] = [];
    if (typeof content === "string") {
      if (content.length > 0) parts.push({ type: "text", content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const serialized = contentPartFromPrompt(part, recordReasoning);
        if (serialized !== undefined) parts.push(serialized);
      }
    }
    if (parts.length > 0) out.push({ role: message.role, parts });
  }
  return out;
}

/** Serializes model response parts into one CLS assistant message. */
export function clsOutputMessage(
  content: readonly InstrumentationContentPart[],
  finishReason: string,
  recordReasoning = false,
): ClsMessage & { readonly finish_reason: string } {
  const parts: ClsMessagePart[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text.trim().length > 0) {
      parts.push({ type: "text", content: part.text });
    } else if (
      recordReasoning &&
      part.type === "reasoning" &&
      part.text.trim().length > 0
    ) {
      parts.push({ type: "reasoning", content: part.text });
    } else if (part.type === "tool-call") {
      parts.push({
        type: "tool_call",
        id: part.callId,
        name: part.toolName,
        arguments: part.input,
      });
    } else if (part.type === "tool-result") {
      parts.push({
        type: "tool_call_response",
        id: part.callId,
        name: part.toolName,
        response: part.output,
      });
    } else if (part.type === "tool-error") {
      parts.push({
        type: "tool_call_response",
        id: part.callId,
        name: part.toolName,
        response: { error: part.error },
      });
    }
  }
  return { role: "assistant", parts, finish_reason: normalizeFinishReason(finishReason) };
}

/** CLS spec finish_reasons vocabulary. */
export function normalizeFinishReason(reason: string): string {
  switch (reason) {
    case "tool-calls":
    case "tool_call":
      return "tool_calls";
    case "stop":
    case "end_turn":
      return "stop";
    case "length":
      return "length";
    case "cancelled":
      return "cancelled";
    case "content-filter":
    case "content_filter":
      return "content_filter";
    case "error":
      return "error";
    default:
      return reason;
  }
}

/** Extracts a system-prompt string from the instrumentation instructions value. */
export function systemInstructionsText(instructions: unknown): string | undefined {
  if (typeof instructions === "string") return instructions;
  if (isRecord(instructions) && typeof instructions.content === "string") {
    return instructions.content;
  }
  return undefined;
}

/** The last user message in a prompt, used to backfill entry/agent input. */
export function lastUserMessage(messages: readonly unknown[]): ClsMessage[] {
  const all = clsInputMessages(messages);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].role === "user") return [all[i]];
  }
  return all.slice(0, 1);
}
