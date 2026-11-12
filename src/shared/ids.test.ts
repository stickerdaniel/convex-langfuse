import { createTraceId } from "@langfuse/tracing";
import { describe, expect, test } from "vitest";
import {
  isEnvironmentName,
  isObservationId,
  isTraceId,
  observationIdFromKey,
  traceIdFromSeed,
} from "./ids.js";

describe("traceIdFromSeed", () => {
  test.each([
    "chat:abc:turn:1",
    "a",
    "Grüße, 世界 🚀",
    "x".repeat(250),
    "seed with spaces\nand a newline",
  ])("equals createTraceId of @langfuse/tracing for %j", async (seed) => {
    const traceId = await traceIdFromSeed(seed);
    expect(traceId).toBe(await createTraceId(seed));
    expect(isTraceId(traceId)).toBe(true);
  });

  test("rejects an empty seed", async () => {
    await expect(traceIdFromSeed("")).rejects.toThrow(TypeError);
  });
});

describe("observationIdFromKey", () => {
  const traceA = "0123456789abcdef0123456789abcdef";
  const traceB = "fedcba9876543210fedcba9876543210";

  test("is a stable 16 character hex id", async () => {
    const id = await observationIdFromKey(traceA, "llm");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(isObservationId(id)).toBe(true);
    expect(await observationIdFromKey(traceA, "llm")).toBe(id);
  });

  test("is the first 16 hex characters of SHA-256 over `<traceId>:<key>`", async () => {
    // Computed once with node:crypto.
    expect(await observationIdFromKey(traceA, "llm")).toBe("99970f641a3edfd5");
  });

  test("differs for different keys and different traces", async () => {
    const id = await observationIdFromKey(traceA, "llm");
    expect(await observationIdFromKey(traceA, "tool")).not.toBe(id);
    expect(await observationIdFromKey(traceB, "llm")).not.toBe(id);
  });

  test("rejects an empty key", async () => {
    await expect(observationIdFromKey(traceA, "")).rejects.toThrow(TypeError);
  });
});

describe("id checks", () => {
  test("isTraceId", () => {
    expect(isTraceId("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isTraceId("0".repeat(31) + "1")).toBe(true);
    expect(isTraceId("0".repeat(32))).toBe(false);
    expect(isTraceId("0123456789ABCDEF0123456789ABCDEF")).toBe(false);
    expect(isTraceId("0123456789abcdef0123456789abcde")).toBe(false);
    expect(isTraceId("0123456789abcdef0123456789abcdef0")).toBe(false);
    expect(isTraceId("g123456789abcdef0123456789abcdef")).toBe(false);
  });

  test("isObservationId", () => {
    expect(isObservationId("0123456789abcdef")).toBe(true);
    expect(isObservationId("0".repeat(16))).toBe(false);
    expect(isObservationId("0123456789ABCDEF")).toBe(false);
    expect(isObservationId("0123456789abcde")).toBe(false);
    expect(isObservationId("0123456789abcdef0123456789abcdef")).toBe(false);
  });

  test("isEnvironmentName", () => {
    expect(isEnvironmentName("production")).toBe(true);
    expect(isEnvironmentName("staging-eu_1")).toBe(true);
    expect(isEnvironmentName("a".repeat(40))).toBe(true);
    expect(isEnvironmentName("a".repeat(41))).toBe(false);
    expect(isEnvironmentName("")).toBe(false);
    expect(isEnvironmentName("langfuse-x")).toBe(false);
    expect(isEnvironmentName("langfuse")).toBe(false);
    expect(isEnvironmentName("Production")).toBe(false);
    expect(isEnvironmentName("prod env")).toBe(false);
    expect(isEnvironmentName("prod.eu")).toBe(false);
  });
});
