import { createRequire } from "node:module";
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
import { safeJsonAttribute, utf8Prefix } from "./content/safe-json.js";

export interface SpanPipeline {
  readonly tracer: Tracer;
  readonly provider: BasicTracerProvider;
  readonly flush: () => Promise<void>;
}

export const SDK_VERSION = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require("eve-cls-observability/package.json") as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

export function calculateExportTimeoutMillis(
  requestTimeoutMs: number,
  maxRetries: number,
): number {
  return requestTimeoutMs * (maxRetries + 1) + (maxRetries > 0 ? 30_000 : 0) + 5_000;
}

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

function safeJson(value: unknown, maxBytes: number, fallback: string): string {
  return safeJsonAttribute(value, maxBytes)?.json ?? fallback;
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
    links: safeJson(
      span.links.map((link) => ({
        traceID: link.context.traceId,
        spanID: link.context.spanId,
        ...(link.attributes !== undefined
          ? { attributes: redactAttributes(link.attributes, options?.redact) }
          : {}),
      })),
      maxContentBytes,
      "[]",
    ),
    logs: safeJson(
      span.events.map((event) => ({
        name: event.name,
        ...(event.attributes !== undefined
          ? { attributes: redactAttributes(event.attributes, options?.redact) }
          : {}),
      })),
      maxContentBytes,
      "[]",
    ),
    traceState: context.traceState?.serialize() ?? "",
    resource: safeJson(
      redactAttributes(span.resource.attributes, options?.redact),
      maxContentBytes,
      "{}",
    ),
    attribute: safeJson(
      redactAttributes(span.attributes, options?.redact),
      maxContentBytes,
      "{}",
    ),
  };
  return { timeMillis: Number(startNano / 1_000_000n), fields };
}

class ClsSpanExporter implements SpanExporter {
  readonly #writer: ClsWriter;
  readonly #onError: (error: unknown) => void;
  readonly #debug: boolean;
  readonly #maxContentBytes: number;
  readonly #redact?: AttributeRedactor;
  readonly #inFlight = new Set<Promise<void>>();
  #closed = false;

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
    if (this.#closed) {
      callback({ code: ExportResultCode.FAILED });
      return;
    }
    let entries: ClsLogEntry[];
    try {
      entries = spans.map((span) =>
        spanToClsLogEntry(span, {
          maxContentBytes: this.#maxContentBytes,
          ...(this.#redact !== undefined ? { redact: this.#redact } : {}),
        }),
      );
    } catch (error) {
      this.#onError(error);
      callback({ code: ExportResultCode.FAILED });
      return;
    }

    const operation = this.#writer.putLogs(entries);
    this.#inFlight.add(operation);
    operation.then(
      () => {
        if (this.#debug) {
          console.error(`[eve-cls-observability] uploaded ${spans.length} spans`);
        }
        callback({ code: ExportResultCode.SUCCESS });
      },
      (error: unknown) => {
        this.#onError(error);
        callback({ code: ExportResultCode.FAILED });
      },
    ).finally(() => this.#inFlight.delete(operation));
  }

  async forceFlush(): Promise<void> {
    await this.#writer.flush();
    await Promise.all([...this.#inFlight]);
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    await this.#writer.shutdown();
    await Promise.all([...this.#inFlight]);
  }
}

export function redactReadableSpan(
  span: ReadableSpan,
  redact: AttributeRedactor | undefined,
): ReadableSpan {
  if (redact === undefined) return span;
  const resource = Object.create(span.resource) as typeof span.resource;
  Object.defineProperty(resource, "attributes", {
    value: redactAttributes(span.resource.attributes, redact),
    enumerable: true,
  });
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext !== undefined
      ? { parentSpanContext: span.parentSpanContext }
      : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status,
    attributes: redactAttributes(span.attributes, redact) as never,
    links: span.links.map((link) => ({
      ...link,
      ...(link.attributes !== undefined
        ? { attributes: redactAttributes(link.attributes, redact) as never }
        : {}),
    })),
    events: span.events.map((event) => ({
      ...event,
      ...(event.attributes !== undefined
        ? { attributes: redactAttributes(event.attributes, redact) as never }
        : {}),
    })),
    duration: span.duration,
    ended: span.ended,
    resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

class RedactingSpanExporter implements SpanExporter {
  readonly #delegate: SpanExporter;
  readonly #redact: AttributeRedactor | undefined;

  constructor(delegate: SpanExporter, redact: AttributeRedactor | undefined) {
    this.#delegate = delegate;
    this.#redact = redact;
  }

  export(spans: ReadableSpan[], callback: (result: { code: ExportResultCode }) => void): void {
    this.#delegate.export(
      spans.map((span) => redactReadableSpan(span, this.#redact)),
      callback,
    );
  }

  forceFlush(): Promise<void> {
    return this.#delegate.forceFlush?.() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.#delegate.shutdown();
  }
}

/** Exports to primary CLS while treating optional mirrors as best-effort. */
class FanoutSpanExporter implements SpanExporter {
  readonly #primary: SpanExporter;
  readonly #mirrors: readonly SpanExporter[];

  constructor(primary: SpanExporter, mirrors: readonly SpanExporter[]) {
    this.#primary = primary;
    this.#mirrors = mirrors;
  }

  export(spans: ReadableSpan[], callback: (result: { code: ExportResultCode }) => void): void {
    for (const mirror of this.#mirrors) {
      try {
        mirror.export(spans, (result) => {
          if (result.code !== ExportResultCode.SUCCESS) {
            console.warn("eve-cls-observability: optional OTLP mirror export failed");
          }
        });
      } catch {
        console.warn("eve-cls-observability: optional OTLP mirror export failed");
      }
    }
    try {
      this.#primary.export(spans, callback);
    } catch {
      callback({ code: ExportResultCode.FAILED });
    }
  }

  async shutdown(): Promise<void> {
    let primaryError: unknown;
    try {
      await this.#primary.shutdown();
    } catch (error) {
      primaryError = error;
    } finally {
      await Promise.allSettled(this.#mirrors.map((exporter) => exporter.shutdown()));
    }
    if (primaryError !== undefined) throw primaryError;
  }

  async forceFlush(): Promise<void> {
    let primaryError: unknown;
    try {
      await this.#primary.forceFlush?.();
    } catch (error) {
      primaryError = error;
    } finally {
      await Promise.allSettled(
        this.#mirrors.map((exporter) => exporter.forceFlush?.() ?? Promise.resolve()),
      );
    }
    if (primaryError !== undefined) throw primaryError;
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
  const primaryExporter = new ClsSpanExporter(
    writer,
    (error) => console.warn("eve-cls-observability: UploadLog export failed", error),
    config.debug,
    config.maxContentLength,
    config.redact,
  );
  const mirrorExporters: SpanExporter[] = config.otlpMirrors.map(
    (mirror) =>
      new RedactingSpanExporter(
        new OTLPTraceExporter({
          url: mirror.endpoint,
          headers: mirror.headers,
        }),
        config.redact,
      ),
  );
  const exporter: SpanExporter =
    mirrorExporters.length === 0
      ? primaryExporter
      : new FanoutSpanExporter(primaryExporter, mirrorExporters);

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
        exportTimeoutMillis: calculateExportTimeoutMillis(
          config.requestTimeoutMs,
          config.maxRetries,
        ),
      }),
    ],
  });

  const flush = async (): Promise<void> => {
    // First drain spans still buffered by the processor, then always wait for
    // batches that a scheduled export had already handed to the exporter.
    let processorError: unknown;
    try {
      await provider.forceFlush();
    } catch (error) {
      processorError = error;
    } finally {
      await exporter.forceFlush?.();
    }
    if (processorError !== undefined) throw processorError;
  };

  return { tracer: provider.getTracer("eve-cls-observability", SDK_VERSION), provider, flush };
}
