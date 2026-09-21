import { createHash } from "node:crypto";
import { serialize } from "node:v8";

export interface MessageCursorOptions {
  readonly maxSessions: number;
  readonly ttlMs: number;
  readonly now?: () => number;
}

export interface MessageCursorSnapshot {
  readonly version: number;
  readonly messageHashes: readonly string[];
  readonly fullHash: string;
  readonly reliable: boolean;
  readonly updatedAtMs: number;
}

export type MessageAdvance<T> =
  | { readonly kind: "full"; readonly hash: string; readonly messages: readonly T[] }
  | { readonly kind: "delta"; readonly hash: string; readonly messages: readonly T[] }
  | { readonly kind: "stale"; readonly hash: string; readonly messages: readonly T[] };

interface HashResult {
  readonly hash: string;
  readonly reliable: boolean;
}

function structuralHash(value: unknown): HashResult {
  try {
    return {
      hash: createHash("md5").update(serialize(value)).digest("hex"),
      reliable: true,
    };
  } catch {
    return {
      hash: createHash("md5").update(String(value)).digest("hex"),
      reliable: false,
    };
  }
}

function messageHashes(messages: readonly unknown[]): {
  readonly hashes: string[];
  readonly reliable: boolean;
} {
  const results = messages.map((message) => structuralHash(message));
  return {
    hashes: results.map((result) => result.hash),
    reliable: results.every((result) => result.reliable),
  };
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
    const previous = this.#cursors.get(sessionId);
    if (previous !== undefined && version <= previous.version) {
      return { kind: "stale", hash: previous.fullHash, messages: [] };
    }
    const messageHashResult = messageHashes(messages);
    const fullHashResult = structuralHash(messages);
    const hashes = messageHashResult.hashes;
    const fullHash = fullHashResult.hash;
    const reliable = messageHashResult.reliable && fullHashResult.reliable;
    const isFresh = true;
    const extendsPrefix =
      reliable &&
      previous?.reliable === true &&
      previous.messageHashes.length < hashes.length &&
      previous.messageHashes.every((hash, index) => hash === hashes[index]);

    if (isFresh) {
      this.#cursors.delete(sessionId);
      this.#cursors.set(sessionId, {
        version,
        messageHashes: hashes,
        fullHash,
        reliable,
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
