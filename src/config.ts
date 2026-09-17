export type AttributeRedactor = (
  key: string,
  value: unknown,
) => unknown | undefined;

export interface OtlpMirrorOptions {
  readonly topicId: string;
  readonly region?: string;
  readonly endpoint?: string;
  /** Mirror-specific headers. Main CLS credentials are never inherited. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Required for non-Tencent endpoints after the SSRF implications are reviewed. */
  readonly allowCustomEndpoint?: boolean;
}

/** Configuration for the CLS observability provider. */
export interface ClsObservabilityOptions {
  readonly topicId?: string;
  readonly region?: string;
  readonly secretId?: string;
  readonly secretKey?: string;
  /** Optional STS session token. Falls back to `CLS_TOKEN`. */
  readonly token?: string;
  readonly apiHost?: string;
  /** Required when apiHost is not the official regional CLS OpenAPI host. */
  readonly allowCustomEndpoint?: boolean;
  readonly agentType?: string;
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  readonly environment?: string;
  /** Content is opt-in in production-safe defaults. */
  readonly recordInputs?: boolean;
  readonly recordOutputs?: boolean;
  readonly recordReasoning?: boolean;
  readonly recordSessionTitle?: boolean;
  readonly recordUserId?: boolean;
  readonly hashUserId?: boolean;
  readonly messageDelta?: boolean;
  /** Called after built-in content gates; return undefined to omit an attribute. */
  readonly redact?: AttributeRedactor;
  /** UTF-8 bytes, 1 KiB–1 MiB. Default 32768. */
  readonly maxContentLength?: number;
  /** Encoded protobuf bytes, 1 KiB–5 MiB. Default 4.5 MiB. */
  readonly maxBatchBytes?: number;
  /** Per-request timeout, 100–60000 ms. Default 10000. */
  readonly requestTimeoutMs?: number;
  /** Additional attempts after the first, 0–10. Default 2. */
  readonly maxRetries?: number;
  readonly scheduledDelayMillis?: number;
  /** Maximum in-memory session cursors/tool links. Default 1000. */
  readonly maxTrackedSessions?: number;
  /** Idle session state TTL. Default 30 minutes. */
  readonly stateTtlMs?: number;
  readonly debug?: boolean;
  readonly otlpMirrors?: readonly OtlpMirrorOptions[];
}

export interface ResolvedOtlpMirror {
  readonly topicId: string;
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ResolvedConfig {
  readonly topicId: string;
  readonly region: string;
  readonly secretId: string;
  readonly secretKey: string;
  readonly token?: string;
  readonly apiHost?: string;
  readonly agentType: string;
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly environment?: string;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly recordReasoning: boolean;
  readonly recordSessionTitle: boolean;
  readonly recordUserId: boolean;
  readonly hashUserId: boolean;
  readonly messageDelta: boolean;
  readonly redact?: AttributeRedactor;
  readonly maxContentLength: number;
  readonly maxBatchBytes: number;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  readonly scheduledDelayMillis: number;
  readonly maxTrackedSessions: number;
  readonly stateTtlMs: number;
  readonly debug: boolean;
  readonly otlpMirrors: readonly ResolvedOtlpMirror[];
}

function pick(value: string | undefined, envValue: string | undefined): string | undefined {
  const candidate = value ?? envValue;
  return candidate !== undefined && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

function integerInRange(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`eve-cls-observability: ${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function validateTopicId(topicId: string): void {
  if (!/^[0-9a-fA-F-]{16,64}$/.test(topicId)) {
    throw new Error("eve-cls-observability: topicId has an invalid format");
  }
}

function validateRegion(region: string): void {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(region)) {
    throw new Error("eve-cls-observability: region has an invalid format");
  }
}

function officialApiHost(region: string): string {
  return `cls.${region}.tencentcloudapi.com`;
}

function isPrivateAddress(host: string): boolean {
  return /^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?)$/i.test(host);
}

function validateApiHost(host: string, region: string, allowCustom: boolean): void {
  if (/^https?:\/\//i.test(host) || host.includes("/") || host.includes("@")) {
    throw new Error("eve-cls-observability: apiHost must be a hostname without scheme or path");
  }
  if (isPrivateAddress(host)) {
    throw new Error("eve-cls-observability: apiHost must not target local or private networks");
  }
  if (host !== officialApiHost(region) && !allowCustom) {
    throw new Error(
      "eve-cls-observability: custom apiHost requires allowCustomEndpoint=true after SSRF review",
    );
  }
}

function resolveMirror(mirror: OtlpMirrorOptions, defaultRegion: string): ResolvedOtlpMirror {
  const topicId = mirror.topicId.trim();
  validateTopicId(topicId);
  const region = mirror.region?.trim() || defaultRegion;
  validateRegion(region);
  const endpoint = mirror.endpoint ?? `https://${region}.cls.tencentcs.com/v1/traces`;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("eve-cls-observability: OTLP mirror endpoint must be a valid HTTPS URL");
  }
  const official = url.protocol === "https:" && /^([a-z0-9-]+\.)?cls\.tencentcs\.com$/i.test(url.hostname);
  if (url.protocol !== "https:") {
    throw new Error("eve-cls-observability: OTLP mirror endpoint must use HTTPS");
  }
  if ((!official || url.pathname !== "/v1/traces") && mirror.allowCustomEndpoint !== true) {
    throw new Error(
      "eve-cls-observability: custom OTLP endpoint requires allowCustomEndpoint=true and independent auth",
    );
  }
  return {
    topicId,
    endpoint: url.toString(),
    headers: { topic_id: topicId, ...(mirror.headers ?? {}) },
  };
}

export function resolveConfig(options: ClsObservabilityOptions = {}): ResolvedConfig {
  const topicId = pick(options.topicId, process.env.CLS_TOPIC_ID);
  const region = pick(options.region, process.env.CLS_REGION);
  const secretId = pick(options.secretId, process.env.CLS_SECRET_ID);
  const secretKey = pick(options.secretKey, process.env.CLS_SECRET_KEY);

  const missing: string[] = [];
  if (topicId === undefined) missing.push("topicId (or CLS_TOPIC_ID)");
  if (region === undefined) missing.push("region (or CLS_REGION)");
  if (secretId === undefined) missing.push("secretId (or CLS_SECRET_ID)");
  if (secretKey === undefined) missing.push("secretKey (or CLS_SECRET_KEY)");
  if (missing.length > 0) {
    throw new Error(`eve-cls-observability: missing required configuration: ${missing.join(", ")}`);
  }

  validateTopicId(topicId!);
  validateRegion(region!);
  const apiHost = pick(options.apiHost, process.env.CLS_API_HOST);
  if (apiHost !== undefined) {
    validateApiHost(apiHost, region!, options.allowCustomEndpoint === true);
  }

  const maxContentLength = integerInRange(
    "maxContentLength",
    options.maxContentLength ?? 32 * 1024,
    1024,
    1024 * 1024,
  );
  const maxBatchBytes = integerInRange(
    "maxBatchBytes",
    options.maxBatchBytes ?? Math.floor(4.5 * 1024 * 1024),
    1024,
    5 * 1024 * 1024 - 1,
  );
  const requestTimeoutMs = integerInRange(
    "requestTimeoutMs",
    options.requestTimeoutMs ?? 10_000,
    100,
    60_000,
  );
  const maxRetries = integerInRange("maxRetries", options.maxRetries ?? 2, 0, 10);
  const scheduledDelayMillis = integerInRange(
    "scheduledDelayMillis",
    options.scheduledDelayMillis ?? 2_000,
    100,
    60_000,
  );
  const maxTrackedSessions = integerInRange(
    "maxTrackedSessions",
    options.maxTrackedSessions ?? 1_000,
    1,
    100_000,
  );
  const stateTtlMs = integerInRange(
    "stateTtlMs",
    options.stateTtlMs ?? 30 * 60_000,
    1_000,
    7 * 24 * 60 * 60_000,
  );

  return {
    topicId: topicId!,
    region: region!,
    secretId: secretId!,
    secretKey: secretKey!,
    token: pick(options.token, process.env.CLS_TOKEN),
    apiHost,
    agentType: options.agentType ?? "eve",
    serviceName:
      pick(options.serviceName, process.env.CLS_SERVICE_NAME) ?? options.agentType ?? "eve",
    serviceVersion: options.serviceVersion,
    environment: options.environment,
    recordInputs: options.recordInputs ?? false,
    recordOutputs: options.recordOutputs ?? false,
    recordReasoning: options.recordReasoning ?? false,
    recordSessionTitle: options.recordSessionTitle ?? false,
    recordUserId: options.recordUserId ?? false,
    hashUserId: options.hashUserId ?? true,
    messageDelta: options.messageDelta ?? true,
    redact: options.redact,
    maxContentLength,
    maxBatchBytes,
    requestTimeoutMs,
    maxRetries,
    scheduledDelayMillis,
    maxTrackedSessions,
    stateTtlMs,
    debug: options.debug ?? process.env.CLS_OBS_DEBUG === "1",
    otlpMirrors: (options.otlpMirrors ?? []).map((mirror) => resolveMirror(mirror, region!)),
  };
}
