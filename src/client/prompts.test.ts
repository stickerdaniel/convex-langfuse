import { defineTestApp } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import componentTest from "../test.js";
import {
  enableExport,
  installFakeLangfuse,
} from "../component/fakeLangfuse.test-util.js";
import { FakePrompts } from "../component/fakePrompts.test-util.js";
import { Langfuse, type Prompt, type PromptSyncResult } from "./index.js";

const schema = defineSchema({ notes: defineTable({ body: v.string() }) });
const app = defineTestApp({
  schema,
  components: { convexLangfuse: componentTest },
});
const langfuse = new Langfuse(app.components.convexLangfuse, {
  content: "full",
});

const { api, createTest } = app.defineModules({
  app: {
    get: app.query({
      args: { name: v.string() },
      handler: async (ctx, { name }): Promise<Prompt | null> =>
        await langfuse.prompts.get(ctx, { name }),
    }),
    /** Pins `name` for `scope`, with a chat fallback, next to an app write. */
    pin: app.mutation({
      args: { scope: v.string(), name: v.string() },
      handler: async (ctx, { scope, name }): Promise<Prompt | null> => {
        await ctx.db.insert("notes", { body: scope });
        return await langfuse.prompts.pin(ctx, {
          scope,
          name,
          fallback: {
            type: "chat",
            prompt: [
              { role: "system", content: "Fallback" },
              { type: "placeholder", name: "history" },
            ],
            config: { temperature: 0 },
          },
        });
      },
    }),
    sync: app.action({
      args: {},
      handler: async (ctx): Promise<PromptSyncResult> =>
        await langfuse.prompts.sync(ctx),
    }),
  },
});

let prompts: FakePrompts;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  enableExport();
  const fake = installFakeLangfuse();
  prompts = new FakePrompts();
  fake.fallback = (request) => prompts.answer(request);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("get decodes a synced chat prompt into messages and its config", async () => {
  const t = createTest();
  prompts.add(
    "assistant",
    [
      { role: "system", content: "Be brief" },
      { type: "placeholder", name: "history" },
    ],
    ["production"],
    { model: "m" },
  );
  expect(await t.action(api.app.sync, {})).toEqual({
    status: "ok",
    tracked: 1,
    overflow: 0,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const prompt = await t.query(api.app.get, { name: "assistant" });
  expect(prompt).toEqual({
    name: "assistant",
    version: 1,
    source: "langfuse",
    snapshotId: expect.any(String),
    config: { model: "m" },
    type: "chat",
    prompt: [
      { role: "system", content: "Be brief" },
      { type: "placeholder", name: "history" },
    ],
  });
});

test("pin stores a chat fallback on a miss and returns it decoded", async () => {
  const t = createTest();
  const pinned = await t.mutation(api.app.pin, {
    scope: "chat-1",
    name: "assistant",
  });
  expect(pinned).toEqual({
    name: "assistant",
    source: "fallback",
    snapshotId: expect.any(String),
    config: { temperature: 0 },
    type: "chat",
    prompt: [
      { role: "system", content: "Fallback" },
      { type: "placeholder", name: "history" },
    ],
  });
  expect(await t.query(api.app.get, { name: "assistant" })).toBeNull();
  expect(
    await t.mutation(api.app.pin, { scope: "chat-1", name: "assistant" }),
  ).toEqual(pinned);
});
