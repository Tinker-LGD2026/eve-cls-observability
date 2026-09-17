import { randomBytes } from "node:crypto";

/** 32-char lowercase hex trace ID (CLS spec: per-turn unique). */
export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** 16-char lowercase hex span ID. */
export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

/** CLS turn ID chain: `{sessionId}:t{N}` (N from 1). */
export function clsTurnId(sessionId: string, turnSequence: number): string {
  return `${sessionId}:t${turnSequence}`;
}

/** CLS step ID chain: `{turnId}:s{N}` (N from 1). */
export function clsStepId(turnId: string, round: number): string {
  return `${turnId}:s${round}`;
}
