import { defineTestApp } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import componentTest from "../test.js";
import {
  enableExport,
  installFakeLangfuse,
  refusalCode,
  type FakeLangfuse,
} from "../component/fakeLangfuse.test-util.js";
import {
  driveSkills,
  FakeSkills,
  skillFiles,
} from "../component/fakeSkills.test-util.js";
import {
  Langfuse,
  type RunMutationCtx,
  type RunQueryCtx,
  type Skill,
  type SkillSyncResult,
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
      handler: async (ctx, { name }): Promise<Skill | null> =>
        await langfuse.skills.get(ctx, { name }),
    }),
    sync: app.mutation({
      args: { names: v.array(v.string()) },
      handler: async (ctx, { names }): Promise<SkillSyncResult> =>
        await langfuse.skills.sync(ctx, { names }),
    }),
  },
});

let fake: FakeLangfuse;
let skills: FakeSkills;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-13T12:00:00.000Z"));
  enableExport();
  fake = installFakeLangfuse();
  skills = new FakeSkills();
  fake.fallback = (request) => skills.answer(request);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("get returns a synced skill with its frontmatter parsed", async () => {
  const t = createTest();
  skills.add("weather-report", {
    frontmatter: { name: "weather-report", metadata: { units: ["C", "km/h"] } },
  });
  expect(await t.mutation(api.app.sync, { names: ["weather-report"] })).toEqual(
    { status: "ok", tracked: 1 },
  );
  await driveSkills(t, fake, {
    until: async () =>
      (await t.query(api.app.get, { name: "weather-report" })) !== null,
    maxMs: 60_000,
  });

  expect(await t.query(api.app.get, { name: "weather-report" })).toEqual({
    name: "weather-report",
    version: 1,
    description: "Writes a short weather report from a forecast.",
    frontmatter: { metadata: { units: ["C", "km/h"] }, name: "weather-report" },
    files: [...skillFiles("weather-report")].sort((a, b) =>
      a.path < b.path ? -1 : 1,
    ),
    snapshotId: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
});

test("a name with a lone surrogate throws invalid_skill_name and makes no component call", async () => {
  const t = createTest();
  // What `"cut 😀".slice(0, -1)` leaves, which Convex refuses as an argument.
  const cut = "cut 😀".slice(0, -1);
  const calls: unknown[] = [];
  const codes = await t.action(async (ctx) => {
    const spy: RunQueryCtx & RunMutationCtx = {
      runQuery: async (reference, ...args) => {
        calls.push(args[0]);
        return await ctx.runQuery(reference, ...args);
      },
      runMutation: async (reference, ...args) => {
        calls.push(args[0]);
        return await ctx.runMutation(reference, ...args);
      },
    };
    return [
      await refusalCode(langfuse.skills.get(spy, { name: cut })),
      await refusalCode(langfuse.skills.sync(spy, { names: ["ok", cut] })),
    ];
  });
  expect(codes).toEqual(["invalid_skill_name", "invalid_skill_name"]);
  expect(calls).toEqual([]);
});
