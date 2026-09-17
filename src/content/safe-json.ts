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

function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => normalize(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = normalize(item, seen);
  }
  return output;
}

function truncateStrings(value: unknown, maxStringBytes: number): unknown {
  if (typeof value === "string" && byteLength(value) > maxStringBytes) {
    const marker = "… [truncated]";
    return `${utf8Prefix(value, Math.max(0, maxStringBytes - byteLength(marker)))}${marker}`;
  }
  if (Array.isArray(value)) return value.map((item) => truncateStrings(item, maxStringBytes));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, truncateStrings(item, maxStringBytes)]),
    );
  }
  return value;
}

/**
 * Serializes arbitrary input as valid JSON within a UTF-8 byte ceiling.
 * Circular references, BigInt and Error objects are safe. If deep string
 * truncation is insufficient, arrays retain a valid prefix plus a marker;
 * other values become a valid preview envelope.
 */
export function safeJsonAttribute(value: unknown, maxBytes: number): SafeJsonResult | undefined {
  if (value === undefined) return undefined;
  const normalized = normalize(value, new WeakSet());
  let json = JSON.stringify(normalized);
  if (json === undefined || json.length === 0) return undefined;
  if (byteLength(json) <= maxBytes) return { json, truncated: false };

  let stringLimit = Math.max(32, Math.floor(maxBytes / 2));
  let candidate: unknown = normalized;
  while (stringLimit >= 32) {
    candidate = truncateStrings(normalized, stringLimit);
    json = JSON.stringify(candidate);
    if (byteLength(json) <= maxBytes) return { json, truncated: true };
    stringLimit = Math.floor(stringLimit / 2);
  }

  if (Array.isArray(candidate)) {
    const marker = { type: "truncated" };
    const kept: unknown[] = [];
    for (const item of candidate) {
      const attempt = JSON.stringify([...kept, item, marker]);
      if (byteLength(attempt) > maxBytes) break;
      kept.push(item);
    }
    json = JSON.stringify([...kept, marker]);
    if (byteLength(json) <= maxBytes) return { json, truncated: true };
  }

  const prefixBudget = Math.max(0, maxBytes - 36);
  let preview = utf8Prefix(JSON.stringify(normalized), prefixBudget);
  json = JSON.stringify({ truncated: true, preview });
  while (byteLength(json) > maxBytes && preview.length > 0) {
    preview = utf8Prefix(preview, Math.max(0, byteLength(preview) - 16));
    json = JSON.stringify({ truncated: true, preview });
  }
  return { json, truncated: true };
}

export function safeString(value: unknown): string {
  return safeJsonAttribute(value, 64 * 1024)?.json ?? String(value);
}
