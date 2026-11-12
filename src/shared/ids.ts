// Deterministic Langfuse ids. Uses only Web Crypto and TextEncoder, so it runs
// in the Convex default runtime, Node and Bun.

import { sha256Hex } from "./hash.js";

/**
 * Trace id for a seed: the first 32 hex characters of SHA-256 over the UTF-8
 * seed. Equal to `createTraceId(seed)` of `@langfuse/tracing`, so the same seed
 * names the same trace in both. Throws a `TypeError` for an empty seed.
 */
export async function traceIdFromSeed(seed: string): Promise<string> {
  if (seed === "") throw new TypeError("traceIdFromSeed: seed is empty");
  return (await sha256Hex(seed)).slice(0, 32);
}

/**
 * Observation (span) id for a key inside a trace: the first 16 hex characters
 * of SHA-256 over `${traceId}:${key}`. Equal keys in different traces give
 * different ids. Throws a `TypeError` for an empty key.
 */
export async function observationIdFromKey(
  traceId: string,
  key: string,
): Promise<string> {
  if (key === "") throw new TypeError("observationIdFromKey: key is empty");
  return (await sha256Hex(`${traceId}:${key}`)).slice(0, 16);
}

/** 32 lowercase hex characters, not all zero. */
export function isTraceId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value);
}

/** 16 lowercase hex characters, not all zero. */
export function isObservationId(value: string): boolean {
  return /^[0-9a-f]{16}$/.test(value) && !/^0+$/.test(value);
}

/**
 * Langfuse's rule for environment names: 1 to 40 characters of [a-z0-9-_],
 * not starting with "langfuse". The server maps other names to "default" or
 * strips the reserved prefix.
 */
export function isEnvironmentName(value: string): boolean {
  return /^[a-z0-9_-]{1,40}$/.test(value) && !value.startsWith("langfuse");
}
