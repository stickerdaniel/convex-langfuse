import { defineTestApp } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import componentTest from "../test.js";
import {
  enableExport,
  installFakeLangfuse,
  refusalCode,
} from "../component/fakeLangfuse.test-util.js";
import { FakePrompts } from "../component/fakePrompts.test-util.js";
import {
  Langfuse,
  type Prompt,
  type PromptSyncResult,
  type RunActionCtx,
  type RunMutationCtx,
  type RunQueryCtx,
} from "./index.js";

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

describe("a lone surrogate", () => {
  // What `"cut 😀".slice(0, -1)` leaves: a lone surrogate, which Convex
  // refuses in a function argument.
  const CUT = "cut 😀".slice(0, -1);
  const FIXED = "cut \ufffd";

  type Ctx = RunQueryCtx & RunMutationCtx & RunActionCtx;

  /** A ctx that records the arguments of every component call it forwards. */
  function recording(ctx: Ctx, calls: unknown[]): Ctx {
    return {
      runQuery: async (reference, ...args) => {
        calls.push(args[0]);
        return await ctx.runQuery(reference, ...args);
      },
      runMutation: async (reference, ...args) => {
        calls.push(args[0]);
        return await ctx.runMutation(reference, ...args);
      },
      runAction: async (reference, ...args) => {
        calls.push(args[0]);
        return await ctx.runAction(reference, ...args);
      },
    };
  }

  test("in a name, a label or a scope throws its code and makes no component call", async () => {
    const t = createTest();
    const calls: unknown[] = [];
    const codes = await t.action(async (ctx) => {
      const spy = recording(ctx, calls);
      const { prompts } = langfuse;
      return [
        await refusalCode(prompts.get(spy, { name: CUT })),
        await refusalCode(prompts.get(spy, { name: "n", label: CUT })),
        await refusalCode(prompts.pin(spy, { scope: "s", name: CUT })),
        await refusalCode(
          prompts.pin(spy, { scope: "s", name: "n", label: CUT }),
        ),
        await refusalCode(prompts.pin(spy, { scope: CUT, name: "n" })),
        await refusalCode(prompts.sync(spy, { names: ["n", CUT] })),
      ];
    });
    expect(codes).toEqual([
      "invalid_prompt_name",
      "invalid_prompt_selector",
      "invalid_prompt_name",
      "invalid_prompt_selector",
      "invalid_prompt_scope",
      "invalid_prompt_name",
    ]);
    expect(calls).toEqual([]);
  });

  test("in a fallback's text or config is stored as U+FFFD", async () => {
    const t = createTest();
    // As JSON: Convex refuses a returned object key outside ASCII.
    const pinned = await t.action(async (ctx) =>
      JSON.stringify([
        await langfuse.prompts.pin(ctx, {
          scope: "s1",
          name: "text",
          fallback: { type: "text", prompt: CUT, config: { [CUT]: [CUT] } },
        }),
        await langfuse.prompts.pin(ctx, {
          scope: "s2",
          name: "chat",
          fallback: { type: "chat", prompt: [{ role: "user", content: CUT }] },
        }),
      ]),
    );
    expect(JSON.parse(pinned)).toMatchObject([
      { prompt: FIXED, config: { [FIXED]: [FIXED] } },
      { prompt: [{ role: "user", content: FIXED }] },
    ]);
  });
});
