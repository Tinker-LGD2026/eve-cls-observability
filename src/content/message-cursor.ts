import { createHash } from "node:crypto";
import { safeJsonAttribute } from "./safe-json.js";

export interface MessageCursorOptions {
  readonly maxSessions: number;
  readonly ttlMs: number;
  readonly now?: () => number;
}

export interface MessageCursorSnapshot {
  readonly version: number;
  readonly messageHashes: readonly string[];
  readonly fullHash: string;
  readonly updatedAtMs: number;
}

export type MessageAdvance<T> =
  | { readonly kind: "full"; readonly hash: string; readonly messages: readonly T[] }
  | { readonly kind: "delta"; readonly hash: string; readonly messages: readonly T[] };

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return safeJsonAttribute(value, 16 * 1024 * 1024)?.json ?? "null";
}

function messageHashes(messages: readonly unknown[]): string[] {
  return messages.map((message) => md5(canonical(message)));
}

/** Bounded, content-free cursor used for append-only GenAI message deltas. */
export class MessageCursorStore {
  readonly #maxSessions: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #cursors = new Map<string, MessageCursorSnapshot>();

  constructor(options: MessageCursorOptions) {
    this.#maxSessions = options.maxSessions;
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  advance<T>(sessionId: string, messages: readonly T[], version: number): MessageAdvance<T> {
    this.evictExpired();
    const hashes = messageHashes(messages);
    const fullHash = md5(canonical(messages));
    const previous = this.#cursors.get(sessionId);
    const isFresh = previous === undefined || version > previous.version;
    const extendsPrefix =
      previous !== undefined &&
      previous.messageHashes.length < hashes.length &&
      previous.messageHashes.every((hash, index) => hash === hashes[index]);

    if (isFresh) {
      this.#cursors.delete(sessionId);
      this.#cursors.set(sessionId, {
        version,
        messageHashes: hashes,
        fullHash,
        updatedAtMs: this.#now(),
      });
      this.#evictOverflow();
    }

    if (isFresh && extendsPrefix && previous !== undefined) {
      return { kind: "delta", hash: fullHash, messages: messages.slice(previous.messageHashes.length) };
    }
    return { kind: "full", hash: fullHash, messages };
  }

  delete(sessionId: string): void {
    this.#cursors.delete(sessionId);
  }

  evictExpired(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [sessionId, cursor] of this.#cursors) {
      if (cursor.updatedAtMs < cutoff) this.#cursors.delete(sessionId);
    }
  }

  snapshot(): Readonly<Record<string, MessageCursorSnapshot>> {
    return Object.fromEntries(this.#cursors);
  }

  #evictOverflow(): void {
    while (this.#cursors.size > this.#maxSessions) {
      const oldest = this.#cursors.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#cursors.delete(oldest);
    }
  }
}
