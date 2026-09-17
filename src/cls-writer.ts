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

function encodeLogGroupList(entries: readonly ClsLogEntry[]): Buffer {
  const groupParts: Buffer[] = entries.map((entry) => messageField(1, encodeLog(entry)));
  groupParts.push(stringField(3, "eve-cls-observability.log"));
  groupParts.push(stringField(4, "eve-cls-observability"));
  return messageField(1, Buffer.concat(groupParts));
}

function tc3Authorization(input: {
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
  readonly onError?: (error: unknown) => void;
}

export interface ClsWriterStats {
  readonly uploadedSpans: number;
  readonly failedBatches: number;
  readonly retryAttempts: number;
  readonly lastSuccessAtMs?: number;
  readonly lastFailureAtMs?: number;
}

interface MutableStats {
  uploadedSpans: number;
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

function partitionEntries(entries: readonly ClsLogEntry[], maxBytes: number): ClsLogEntry[][] {
  const batches: ClsLogEntry[][] = [];
  let current: ClsLogEntry[] = [];
  for (const entry of entries) {
    const candidate = [...current, entry];
    if (encodeLogGroupList(candidate).length <= maxBytes) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      throw new Error(`CLS log entry exceeds maxBatchBytes=${maxBytes}`);
    }
    batches.push(current);
    current = [entry];
    if (encodeLogGroupList(current).length > maxBytes) {
      throw new Error(`CLS log entry exceeds maxBatchBytes=${maxBytes}`);
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
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
  readonly #onError: (error: unknown) => void;
  readonly #stats: MutableStats = { uploadedSpans: 0, failedBatches: 0, retryAttempts: 0 };

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
    this.#onError =
      options.onError ??
      ((error) => console.warn("eve-cls-observability: UploadLog failed", error));
  }

  getStats(): ClsWriterStats {
    return { ...this.#stats };
  }

  async putLogs(entries: readonly ClsLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const batches = partitionEntries(entries, this.#maxBatchBytes);
    for (const batch of batches) await this.#uploadBatch(batch);
  }

  async #uploadBatch(entries: readonly ClsLogEntry[]): Promise<void> {
    const payload = encodeLogGroupList(entries);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      try {
        await this.#attempt(payload);
        this.#stats.uploadedSpans += entries.length;
        this.#stats.lastSuccessAtMs = Date.now();
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= this.#maxRetries || !(error instanceof ClsUploadError) || !error.retryable) {
          break;
        }
        this.#stats.retryAttempts += 1;
        const delay = error.retryAfterMs ?? Math.round(500 * 2 ** attempt * (0.8 + Math.random() * 0.4));
        await sleep(delay);
      }
    }
    this.#stats.failedBatches += 1;
    this.#stats.lastFailureAtMs = Date.now();
    this.#onError(lastError);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async #attempt(payload: Buffer): Promise<void> {
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
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timeout|abort/i.test(message)) {
        throw new ClsUploadError(
          `CLS UploadLog request timeout after ${this.#requestTimeoutMs}ms`,
          true,
        );
      }
      throw new ClsUploadError(`CLS UploadLog network error: ${message}`, true);
    }

    const body = (await response.text()).slice(0, 64 * 1024);
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
        `CLS UploadLog ${code}: ${apiError.Message ?? "unknown error"}`,
        isRetryableApiCode(code),
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
