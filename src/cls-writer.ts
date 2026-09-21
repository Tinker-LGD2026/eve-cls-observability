import { createHash, createHmac } from "node:crypto";

const SERVICE = "cls";
const API_VERSION = "2020-10-16";
const ALGORITHM = "TC3-HMAC-SHA256";
const CONTENT_TYPE = "application/octet-stream";

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function varint(value: bigint): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7fn) {
    bytes.push(Number(remaining & 0x7fn) | 0x80);
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));
  return Buffer.from(bytes);
}

function fieldKey(fieldNumber: number, wireType: 0 | 2): Buffer {
  return varint(BigInt((fieldNumber << 3) | wireType));
}

function stringField(fieldNumber: number, value: string): Buffer {
  const data = Buffer.from(value, "utf8");
  return Buffer.concat([fieldKey(fieldNumber, 2), varint(BigInt(data.length)), data]);
}

function int64Field(fieldNumber: number, value: bigint): Buffer {
  return Buffer.concat([fieldKey(fieldNumber, 0), varint(value)]);
}

function messageField(fieldNumber: number, message: Buffer): Buffer {
  return Buffer.concat([fieldKey(fieldNumber, 2), varint(BigInt(message.length)), message]);
}

function encodeContent(key: string, value: string): Buffer {
  return Buffer.concat([stringField(1, key), stringField(2, value)]);
}

function encodeLog(entry: ClsLogEntry): Buffer {
  const parts = [int64Field(1, BigInt(entry.timeMillis))];
  for (const [key, value] of Object.entries(entry.fields)) {
    parts.push(messageField(2, encodeContent(key, value)));
  }
  return Buffer.concat(parts);
}

const LOG_GROUP_SUFFIX = Buffer.concat([
  stringField(3, "eve-cls-observability.log"),
  stringField(4, "eve-cls-observability"),
]);

function encodeLogGroupFromParts(logParts: readonly Buffer[]): Buffer {
  return messageField(1, Buffer.concat([...logParts, LOG_GROUP_SUFFIX]));
}

export function encodeLogGroupList(entries: readonly ClsLogEntry[]): Buffer {
  return encodeLogGroupFromParts(entries.map((entry) => messageField(1, encodeLog(entry))));
}

export function tc3Authorization(input: {
  readonly secretId: string;
  readonly secretKey: string;
  readonly host: string;
  readonly payload: Buffer;
  readonly timestampSeconds: number;
  readonly action: string;
  readonly region: string;
  readonly topicId: string;
}): string {
  const date = new Date(input.timestampSeconds * 1000).toISOString().slice(0, 10);
  const canonicalHeaders =
    `content-type:${CONTENT_TYPE}\n` +
    `host:${input.host}\n` +
    `x-cls-topicid:${input.topicId}\n` +
    `x-tc-action:${input.action.toLowerCase()}\n` +
    `x-tc-region:${input.region}\n` +
    `x-tc-version:${API_VERSION}\n`;
  const signedHeaders = "content-type;host;x-cls-topicid;x-tc-action;x-tc-region;x-tc-version";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.payload),
  ].join("\n");
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    ALGORITHM,
    String(input.timestampSeconds),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmacSha256(`TC3${input.secretKey}`, date);
  const kService = hmacSha256(kDate, SERVICE);
  const kSigning = hmacSha256(kService, "tc3_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return `${ALGORITHM} Credential=${input.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export interface ClsLogEntry {
  readonly timeMillis: number;
  readonly fields: Readonly<Record<string, string>>;
}

export interface ClsWriterOptions {
  readonly secretId: string;
  readonly secretKey: string;
  readonly token?: string;
  readonly region: string;
  readonly topicId: string;
  readonly apiHost?: string;
  readonly maxRetries?: number;
  readonly requestTimeoutMs?: number;
  readonly maxBatchBytes?: number;
  /** Maximum delay between retry attempts. Default 30000 ms. */
  readonly maxRetryDelayMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface ClsWriterStats {
  readonly uploadedSpans: number;
  readonly droppedOversizedSpans: number;
  readonly failedBatches: number;
  readonly retryAttempts: number;
  readonly lastSuccessAtMs?: number;
  readonly lastFailureAtMs?: number;
}

interface MutableStats {
  uploadedSpans: number;
  droppedOversizedSpans: number;
  failedBatches: number;
  retryAttempts: number;
  lastSuccessAtMs?: number;
  lastFailureAtMs?: number;
}

class ClsUploadError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.name = "ClsUploadError";
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function readResponseText(response: Response, maxBytes = 64 * 1024): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      const remaining = maxBytes - total;
      chunks.push(chunk.subarray(0, remaining));
      total += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) break;
    }
  } finally {
    if (total >= maxBytes) await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

interface PartitionedEntries {
  readonly payloads: readonly Buffer[];
  readonly spanCounts: readonly number[];
  readonly droppedOversizedSpans: number;
}

function encodedListLength(groupLength: number): number {
  return fieldKey(1, 2).length + varint(BigInt(groupLength)).length + groupLength;
}

function partitionEntries(entries: readonly ClsLogEntry[], maxBytes: number): PartitionedEntries {
  const payloads: Buffer[] = [];
  const spanCounts: number[] = [];
  let current: Buffer[] = [];
  let currentLength = LOG_GROUP_SUFFIX.length;
  let droppedOversizedSpans = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    payloads.push(encodeLogGroupFromParts(current));
    spanCounts.push(current.length);
    current = [];
    currentLength = LOG_GROUP_SUFFIX.length;
  };

  for (const entry of entries) {
    const encoded = messageField(1, encodeLog(entry));
    const singleLength = encodedListLength(LOG_GROUP_SUFFIX.length + encoded.length);
    if (singleLength > maxBytes) {
      flush();
      droppedOversizedSpans += 1;
      continue;
    }
    if (encodedListLength(currentLength + encoded.length) > maxBytes) flush();
    current.push(encoded);
    currentLength += encoded.length;
  }
  flush();
  return { payloads, spanCounts, droppedOversizedSpans };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isRetryableApiCode(code: string): boolean {
  return /(?:Timeout|Limit|InternalError|WriteQpsLimit|WriteTrafficLimit)/i.test(code);
}

export class ClsWriter {
  readonly #secretId: string;
  readonly #secretKey: string;
  readonly #token?: string;
  readonly #region: string;
  readonly #topicId: string;
  readonly #apiHost: string;
  readonly #maxRetries: number;
  readonly #requestTimeoutMs: number;
  readonly #maxBatchBytes: number;
  readonly #maxRetryDelayMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #stats: MutableStats = {
    uploadedSpans: 0,
    droppedOversizedSpans: 0,
    failedBatches: 0,
    retryAttempts: 0,
  };
  #queue: Promise<void> = Promise.resolve();
  #closing = false;

  constructor(options: ClsWriterOptions) {
    this.#secretId = options.secretId;
    this.#secretKey = options.secretKey;
    this.#token = options.token;
    this.#region = options.region;
    this.#topicId = options.topicId;
    this.#apiHost = options.apiHost ?? `cls.${options.region}.tencentcloudapi.com`;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#maxBatchBytes = options.maxBatchBytes ?? Math.floor(4.5 * 1024 * 1024);
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.#onError = options.onError ?? (() => undefined);
  }

  getStats(): ClsWriterStats {
    return { ...this.#stats };
  }

  putLogs(entries: readonly ClsLogEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    if (this.#closing) return Promise.reject(new Error("CLS writer is shutting down"));
    const operation = this.#queue.then(() => this.#putLogsNow(entries));
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.#queue;
  }

  async shutdown(): Promise<void> {
    this.#closing = true;
    await this.#queue;
  }

  async #putLogsNow(entries: readonly ClsLogEntry[]): Promise<void> {
    const partitioned = partitionEntries(entries, this.#maxBatchBytes);
    if (partitioned.droppedOversizedSpans > 0) {
      this.#stats.droppedOversizedSpans += partitioned.droppedOversizedSpans;
      this.#onError(
        new Error(`CLS dropped ${partitioned.droppedOversizedSpans} oversized span(s)`),
      );
    }
    const retryBudget = Math.min(
      30_000,
      this.#maxRetryDelayMs * Math.max(1, this.#maxRetries),
    );
    const deadline = Date.now() + this.#requestTimeoutMs * (this.#maxRetries + 1) + retryBudget;
    for (let index = 0; index < partitioned.payloads.length; index += 1) {
      await this.#uploadBatch(
        partitioned.payloads[index]!,
        partitioned.spanCounts[index]!,
        deadline,
      );
    }
  }

  async #uploadBatch(payload: Buffer, spanCount: number, deadline: number): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      try {
        const remainingMs = Math.max(1, deadline - Date.now());
        await this.#attempt(payload, Math.min(this.#requestTimeoutMs, remainingMs));
        this.#stats.uploadedSpans += spanCount;
        this.#stats.lastSuccessAtMs = Date.now();
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= this.#maxRetries || !(error instanceof ClsUploadError) || !error.retryable) {
          break;
        }
        this.#stats.retryAttempts += 1;
        const requestedDelay =
          error.retryAfterMs ?? Math.round(500 * 2 ** attempt * (0.8 + Math.random() * 0.4));
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await sleep(Math.min(requestedDelay, this.#maxRetryDelayMs, remainingMs));
      }
    }
    this.#stats.failedBatches += 1;
    this.#stats.lastFailureAtMs = Date.now();
    this.#onError(lastError);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async #attempt(payload: Buffer, timeoutMs: number): Promise<void> {
    const timestampSeconds = Math.floor(Date.now() / 1_000);
    const headers: Record<string, string> = {
      "Content-Type": CONTENT_TYPE,
      Host: this.#apiHost,
      "X-TC-Action": "UploadLog",
      "X-TC-Version": API_VERSION,
      "X-TC-Timestamp": String(timestampSeconds),
      "X-TC-Region": this.#region,
      "X-CLS-TopicId": this.#topicId,
      Authorization: tc3Authorization({
        secretId: this.#secretId,
        secretKey: this.#secretKey,
        host: this.#apiHost,
        payload,
        timestampSeconds,
        action: "UploadLog",
        region: this.#region,
        topicId: this.#topicId,
      }),
    };
    if (this.#token !== undefined) headers["X-TC-Token"] = this.#token;

    let response: Response;
    try {
      response = await fetch(`https://${this.#apiHost}/`, {
        method: "POST",
        headers,
        body: payload,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timeout|abort/i.test(message)) {
        throw new ClsUploadError(
          `CLS UploadLog request timeout after ${timeoutMs}ms`,
          true,
        );
      }
      throw new ClsUploadError(`CLS UploadLog network error: ${message}`, true);
    }

    let body: string;
    try {
      body = await readResponseText(response);
    } catch {
      throw new ClsUploadError("CLS UploadLog response stream failed", true);
    }
    let apiError: { Code?: string; Message?: string } | undefined;
    if (body.trim().length > 0) {
      try {
        const parsed = JSON.parse(body) as { Response?: { Error?: { Code?: string; Message?: string } } };
        apiError = parsed.Response?.Error;
      } catch {
        throw new ClsUploadError(
          `CLS UploadLog returned non-JSON response (HTTP ${response.status})`,
          isRetryableStatus(response.status),
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }
    }
    if (apiError !== undefined) {
      const code = apiError.Code ?? "UnknownError";
      throw new ClsUploadError(
        `CLS UploadLog ${code} (HTTP ${response.status})`,
        isRetryableStatus(response.status) || isRetryableApiCode(code),
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    if (!response.ok) {
      throw new ClsUploadError(
        `CLS UploadLog HTTP ${response.status}`,
        isRetryableStatus(response.status),
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
  }
}
