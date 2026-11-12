import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { register } from "../../src/test.js";

const modules = import.meta.glob("./**/*.ts");

function initConvexTest() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}

const completion = {
  conversationId: "conversation-1",
  userId: "user-1",
  prompt: "What is Convex?",
  completion: "A reactive backend.",
  model: "gpt-5",
  inputTokens: 12,
  outputTokens: 28,
};

beforeEach(() => {
  // The exporter is scheduled but never runs, so nothing is sent.
  vi.useFakeTimers();
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-example");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-example");
  vi.stubEnv("LANGFUSE_BASE_URL", "https://langfuse.example");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test("recordChatCompletion saves a note and enqueues one generation", async () => {
  const t = initConvexTest();
  await t.mutation(api.example.recordChatCompletion, completion);

  const notes = await t.run(
    async (ctx) => await ctx.db.query("notes").collect(),
  );
  expect(notes.map((note) => note.body)).toEqual([completion.completion]);
  expect((await t.query(api.example.health, {})).pendingAtLeast).toBe(1);
});

test("recordStep records into the same trace", async () => {
  const t = initConvexTest();
  const generation = await t.mutation(
    api.example.recordChatCompletion,
    completion,
  );
  const step = await t.mutation(api.example.recordStep, {
    conversationId: completion.conversationId,
    parentObservationId: generation.observationId,
    name: "vector-search",
  });

  expect(step.traceId).toBe(generation.traceId);
  expect(step.observationId).not.toBe(generation.observationId);
  expect((await t.query(api.example.health, {})).pendingAtLeast).toBe(2);
});

test("getDashboardUrl returns the base URL, or null when unset", async () => {
  const t = initConvexTest();
  expect(await t.query(api.example.getDashboardUrl, {})).toBe(
    "https://langfuse.example",
  );
  vi.stubEnv("LANGFUSE_BASE_URL", undefined);
  expect(await t.query(api.example.getDashboardUrl, {})).toBe(null);
});
