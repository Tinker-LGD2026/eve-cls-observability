export interface SafeJsonResult {
  readonly json: string;
  readonly truncated: boolean;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low);
}

interface NormalizeState {
  readonly seen: WeakSet<object>;
  readonly maxNodes: number;
  nodes: number;
  remainingBytes: number;
  truncated: boolean;
}

const MAX_DEPTH = 64;
const TRUNCATED = "[Truncated]";
const STRING_MARKER = "… [truncated]";

function boundedString(value: string, state: NormalizeState): string {
  const bytes = byteLength(value);
  if (bytes <= state.remainingBytes) {
    state.remainingBytes -= bytes;
    return value;
  }
  state.truncated = true;
  const markerBytes = byteLength(STRING_MARKER);
  const result = `${utf8Prefix(value, Math.max(0, state.remainingBytes - markerBytes))}${STRING_MARKER}`;
  state.remainingBytes = Math.max(0, state.remainingBytes - byteLength(result));
  return result;
}

function normalize(value: unknown, state: NormalizeState, depth = 0): unknown {
  if (state.nodes >= state.maxNodes || state.remainingBytes <= 0) {
    state.truncated = true;
    return TRUNCATED;
  }
  state.nodes += 1;

  if (typeof value === "string") return boundedString(value, state);
  if (typeof value === "bigint") return boundedString(value.toString(), state);
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) {
    state.truncated = true;
    return "[Unsupported]";
  }
  if (typeof value !== "object" || value === null) {
    state.remainingBytes = Math.max(0, state.remainingBytes - 8);
    return value;
  }
  if (value instanceof Error) {
    return {
      name: boundedString(value.name, state),
      message: boundedString(value.message, state),
    };
  }
  if (state.seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) {
    state.truncated = true;
    return TRUNCATED;
  }

  state.seen.add(value);
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (state.nodes >= state.maxNodes || state.remainingBytes <= 0) {
        output.push(TRUNCATED);
        state.truncated = true;
        break;
      }
      try {
        output.push(normalize(value[index], state, depth + 1));
      } catch {
        output.push("[Unserializable]");
        state.truncated = true;
      }
    }
    return output;
  }

  const output: Record<string, unknown> = {};
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      state.truncated = true;
      return "[UnsupportedObject]";
    }
    for (const key in value) {
      if (state.nodes >= state.maxNodes || state.remainingBytes <= 0) {
        output.__truncated__ = true;
        state.truncated = true;
        break;
      }
      state.nodes += 1;
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      state.remainingBytes = Math.max(0, state.remainingBytes - byteLength(key));
      try {
        output[key] = normalize((value as Record<string, unknown>)[key], state, depth + 1);
      } catch {
        output[key] = "[Unserializable]";
        state.truncated = true;
      }
    }
  } catch {
    state.truncated = true;
    return "[Unserializable]";
  }
  return output;
}

/**
 * Serializes arbitrary input as valid JSON within a UTF-8 byte ceiling.
 * Traversal is bounded by depth, visited value count and an approximate byte
 * budget before stringification, preventing oversized values from monopolizing
 * the event loop or overflowing the stack.
 */
export function safeJsonAttribute(value: unknown, maxBytes: number): SafeJsonResult | undefined {
  if (value === undefined) return undefined;
  const state: NormalizeState = {
    seen: new WeakSet(),
    maxNodes: Math.max(64, Math.min(2_048, Math.floor(maxBytes / 8))),
    nodes: 0,
    remainingBytes: Math.max(64, maxBytes * 2),
    truncated: false,
  };
  const normalized = normalize(value, state);
  const json = JSON.stringify(normalized);
  if (json === undefined || json.length === 0) return undefined;
  if (byteLength(json) <= maxBytes) return { json, truncated: state.truncated };

  const envelopeOverhead = byteLength(JSON.stringify({ truncated: true, preview: "" }));
  let preview = utf8Prefix(json, Math.max(0, maxBytes - envelopeOverhead));
  let result = JSON.stringify({ truncated: true, preview });
  while (byteLength(result) > maxBytes && preview.length > 0) {
    preview = utf8Prefix(preview, Math.max(0, byteLength(preview) - 16));
    result = JSON.stringify({ truncated: true, preview });
  }
  return {
    json: byteLength(result) <= maxBytes ? result : "null",
    truncated: true,
  };
}

export function safeString(value: unknown): string {
  return safeJsonAttribute(value, 64 * 1024)?.json ?? String(value);
}
