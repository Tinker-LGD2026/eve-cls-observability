import { hostname } from "node:os";
import { SpanKind, SpanStatusCode, type HrTime, type Tracer } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  BasicTracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { ClsWriter, type ClsLogEntry } from "./cls-writer.js";
import type { AttributeRedactor, ResolvedConfig } from "./config.js";
import { utf8Prefix } from "./content/safe-json.js";

export interface SpanPipeline {
  readonly tracer: Tracer;
  readonly provider: BasicTracerProvider;
  readonly flush: () => Promise<void>;
}

const SDK_VERSION = "0.1.0";

const KIND_NAMES: Record<number, string> = {
  [SpanKind.INTERNAL]: "internal",
  [SpanKind.SERVER]: "server",
  [SpanKind.CLIENT]: "client",
  [SpanKind.PRODUCER]: "internal",
  [SpanKind.CONSUMER]: "internal",
};

const STATUS_NAMES: Record<number, string> = {
  [SpanStatusCode.UNSET]: "UNSET",
  [SpanStatusCode.OK]: "OK",
  [SpanStatusCode.ERROR]: "ERROR",
};

function hrTimeToNano(value: HrTime): bigint {
  return BigInt(value[0]) * 1_000_000_000n + BigInt(value[1]);
}

function redactAttributes(
  attributes: Readonly<Record<string, unknown>>,
  redact: AttributeRedactor | undefined,
): Record<string, unknown> {
  if (redact === undefined) return { ...attributes };
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    try {
      const redacted = redact(key, value);
      if (redacted !== undefined) result[key] = redacted;
    } catch {
      // A failing customer redactor fails closed for that field.
    }
  }
  return result;
}

/** Maps one OTel span to the CLS Trace physical structure (spec §1). */
export function spanToClsLogEntry(
  span: ReadableSpan,
  options?: { readonly maxContentBytes?: number; readonly redact?: AttributeRedactor },
): ClsLogEntry {
  const context = span.spanContext();
  const startNano = hrTimeToNano(span.startTime);
  const endNano = hrTimeToNano(span.endTime);
  const maxContentBytes = options?.maxContentBytes ?? 32 * 1024;
  const fields: Record<string, string> = {
    traceID: context.traceId,
    spanID: context.spanId,
    parentSpanID: span.parentSpanContext?.spanId ?? "",
    name: span.name,
    kind: KIND_NAMES[span.kind] ?? "internal",
    start: startNano.toString(),
    end: endNano.toString(),
    duration: (endNano - startNano).toString(),
    statusCode: STATUS_NAMES[span.status.code] ?? "UNSET",
    statusMessage: utf8Prefix(span.status.message ?? "", maxContentBytes),
    links: JSON.stringify(
      span.links.map((link) => ({
        traceID: link.context.traceId,
        spanID: link.context.spanId,
        ...(link.attributes !== undefined ? { attributes: link.attributes } : {}),
      })),
    ),
    logs: JSON.stringify(
      span.events.map((event) => ({
        name: event.name,
        ...(event.attributes !== undefined ? { attributes: event.attributes } : {}),
      })),
    ),
    traceState: context.traceState?.serialize() ?? "",
    resource: JSON.stringify(span.resource.attributes),
    attribute: JSON.stringify(redactAttributes(span.attributes, options?.redact)),
  };
  return { timeMillis: Number(startNano / 1_000_000n), fields };
}

class ClsSpanExporter implements SpanExporter {
  readonly #writer: ClsWriter;
  readonly #onError: (error: unknown) => void;
  readonly #debug: boolean;
  readonly #maxContentBytes: number;
  readonly #redact?: AttributeRedactor;

  constructor(
    writer: ClsWriter,
    onError: (error: unknown) => void,
    debug: boolean,
    maxContentBytes: number,
    redact?: AttributeRedactor,
  ) {
    this.#writer = writer;
    this.#onError = onError;
    this.#debug = debug;
    this.#maxContentBytes = maxContentBytes;
    this.#redact = redact;
  }

  export(spans: ReadableSpan[], callback: (result: { code: ExportResultCode }) => void): void {
    this.#writer
      .putLogs(
        spans.map((span) =>
          spanToClsLogEntry(span, {
            maxContentBytes: this.#maxContentBytes,
            ...(this.#redact !== undefined ? { redact: this.#redact } : {}),
          }),
        ),
      )
      .then(() => {
        if (this.#debug) {
          console.error(`[eve-cls-observability] uploaded ${spans.length} spans`);
        }
        callback({ code: ExportResultCode.SUCCESS });
      })
      .catch((error: unknown) => {
        this.#onError(error);
        callback({ code: ExportResultCode.FAILED });
      });
  }

  async shutdown(): Promise<void> {
    // Nothing to release: PutLogs has no persistent connection.
  }
}

/** Fans one span batch out to every configured destination. */
class FanoutSpanExporter implements SpanExporter {
  readonly #exporters: readonly SpanExporter[];

  constructor(exporters: readonly SpanExporter[]) {
    this.#exporters = exporters;
  }

  export(spans: ReadableSpan[], callback: (result: { code: ExportResultCode }) => void): void {
    let remaining = this.#exporters.length;
    let failed = false;
    for (const exporter of this.#exporters) {
      exporter.export(spans, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) failed = true;
        remaining -= 1;
        if (remaining === 0) {
          callback({ code: failed ? ExportResultCode.FAILED : ExportResultCode.SUCCESS });
        }
      });
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.#exporters.map((exporter) => exporter.shutdown()));
  }

  async forceFlush(): Promise<void> {
    await Promise.allSettled(
      this.#exporters.map((exporter) => exporter.forceFlush?.() ?? Promise.resolve()),
    );
  }
}

/**
 * Builds an isolated tracer pipeline that writes CLS Agent Trace spec logs
 * directly via UploadLog, optionally mirroring raw OTLP to extra topics.
 * NOT registered globally: the host agent's own OTel setup is left untouched.
 */
export function createSpanPipeline(config: ResolvedConfig): SpanPipeline {
  const writer = new ClsWriter({
    secretId: config.secretId,
    secretKey: config.secretKey,
    ...(config.token !== undefined ? { token: config.token } : {}),
    region: config.region,
    topicId: config.topicId,
    maxRetries: config.maxRetries,
    requestTimeoutMs: config.requestTimeoutMs,
    maxBatchBytes: config.maxBatchBytes,
    ...(config.apiHost !== undefined ? { apiHost: config.apiHost } : {}),
  });
  const destinations: SpanExporter[] = [
    new ClsSpanExporter(
      writer,
      (error) => console.warn("eve-cls-observability: UploadLog export failed", error),
      config.debug,
      config.maxContentLength,
      config.redact,
    ),
    ...config.otlpMirrors.map(
      (mirror) =>
        new OTLPTraceExporter({
          url: mirror.endpoint,
          headers: mirror.headers,
        }),
    ),
  ];
  const exporter: SpanExporter =
    destinations.length === 1 ? destinations[0] : new FanoutSpanExporter(destinations);

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      "service.name": config.serviceName,
      ...(config.serviceVersion !== undefined
        ? { "service.version": config.serviceVersion }
        : {}),
      ...(config.environment !== undefined
        ? { "deployment.environment.name": config.environment }
        : {}),
      "service.instance.id": `${config.agentType}@${process.pid}`,
      "host.name": hostname(),
      "process.pid": process.pid,
      "process.runtime.name": "nodejs",
      "telemetry.sdk.name": "eve-cls-observability",
      "telemetry.sdk.language": "nodejs",
      "telemetry.sdk.version": SDK_VERSION,
    }),
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        scheduledDelayMillis: config.scheduledDelayMillis,
        maxExportBatchSize: 128,
        // Must exceed the configured request/retry budget.
        exportTimeoutMillis:
          config.requestTimeoutMs * (config.maxRetries + 1) +
          2_000 * config.maxRetries +
          5_000,
      }),
    ],
  });

  const flush = async (): Promise<void> => {
    // Lifecycle flush/shutdown callers need the real failure. Agent event
    // handlers do not call this in the normal turn hot path.
    await provider.forceFlush();
  };

  return { tracer: provider.getTracer("eve-cls-observability", SDK_VERSION), provider, flush };
}
