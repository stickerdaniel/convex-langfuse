import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  PIN_TTL_MS,
  PROMPT_REFRESH_INTERVAL_MS,
  SNAPSHOT_GRACE_MS,
  WEBHOOK_TOLERANCE_MS,
} from "./constants.js";
import {
  enableExport,
  installFakeLangfuse,
  pendingScheduled,
  runScheduledNow,
  type FakeLangfuse,
  type TestConvex,
} from "./fakeLangfuse.test-util.js";
import {
  FakePrompts,
  signature,
  WEBHOOK_SECRET,
  webhookBody,
} from "./fakePrompts.test-util.js";
import { initConvexTest } from "./setup.test.js";

// Captured before a test installs fake timers.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realTick = () => new Promise((resolve) => realSetTimeout(resolve, 5));

let t: TestConvex;
let fake: FakeLangfuse;
let prompts: FakePrompts;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  enableExport();
  vi.stubEnv("LANGFUSE_WEBHOOK_SECRET", WEBHOOK_SECRET);
  fake = installFakeLangfuse();
  prompts = new FakePrompts();
  fake.fallback = (request) => prompts.answer(request);
  t = initConvexTest();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Runs scheduled functions, and the ones they schedule, until none is left. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await runScheduledNow(t);
    if ((await pendingScheduled(t)).length === 0) return;
  }
  throw new Error("settle: functions are still scheduled");
}

async function sync(names?: string[]) {
  const result = await t.action(api.prompts.sync, names ? { names } : {});
  await settle();
  return result;
}

const get = (
  name: string,
  selector: { label?: string; version?: number } = {},
) => t.query(api.prompts.get, { name, ...selector });

const pin = (
  scope: string,
  name: string,
  extra: {
    label?: string;
    fallback?: { type: "text" | "chat"; prompt: string; config?: string };
    ttlMs?: number;
  } = {},
) => t.mutation(api.prompts.pin, { scope, name, ...extra });

async function deliver(body: string, header: string = signature(body)) {
  return await t.fetch("/prompt-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-langfuse-signature": header,
    },
    body,
  });
}

/** Delivers a valid webhook for `name` and lets its refreshes finish. */
async function notify(name: string): Promise<void> {
  expect((await deliver(webhookBody(name))).status).toBe(200);
  await settle();
}

type PromptTables = {
  promptSnapshots: Doc<"promptSnapshots">[];
  promptLabels: Doc<"promptLabels">[];
  promptNames: Doc<"promptNames">[];
  promptPins: Doc<"promptPins">[];
  promptSync: Doc<"promptSync">[];
};

async function promptTables(): Promise<PromptTables> {
  return await t.run(async (ctx) => ({
    promptSnapshots: await ctx.db.query("promptSnapshots").collect(),
    promptLabels: await ctx.db.query("promptLabels").collect(),
    promptNames: await ctx.db.query("promptNames").collect(),
    promptPins: await ctx.db.query("promptPins").collect(),
    promptSync: await ctx.db.query("promptSync").collect(),
  }));
}

function rowCounts(state: PromptTables): Record<string, number> {
  return Object.fromEntries(
    Object.entries(state).map(([table, rows]) => [table, rows.length]),
  );
}

async function nameRow(name: string) {
  return (await promptTables()).promptNames.find((row) => row.name === name);
}

const promptHealth = async () => (await t.query(api.outbox.health, {})).prompts;

describe("sync and get", () => {
  test("sync fills snapshots and labels; get resolves production by default, a label and a version", async () => {
    prompts.add("greeting", "Hello v1", ["staging"]);
    prompts.add("greeting", "Hello v2", ["production", "latest"], {
      temperature: 0.2,
      model: "m",
    });
    prompts.add("chat", [
      { role: "system", content: "Be brief" },
      { type: "placeholder", name: "history" },
    ]);

    const syncedAt = Date.now();
    expect(await sync()).toEqual({ status: "ok", tracked: 2, overflow: 0 });

    expect(await get("greeting")).toMatchObject({
      name: "greeting",
      version: 2,
      type: "text",
      prompt: "Hello v2",
      config: '{"model":"m","temperature":0.2}',
      source: "langfuse",
    });
    expect(await get("greeting", { label: "staging" })).toMatchObject({
      version: 1,
      prompt: "Hello v1",
    });
    expect(await get("greeting", { version: 1 })).toMatchObject({
      version: 1,
      prompt: "Hello v1",
    });
    expect(await get("greeting", { label: "missing" })).toBeNull();
    expect(await get("unknown")).toBeNull();
    const chat = await get("chat");
    expect(chat?.type).toBe("chat");
    expect(JSON.parse(chat!.prompt)).toEqual([
      { role: "system", content: "Be brief" },
      { type: "placeholder", name: "history" },
    ]);

    const state = await promptTables();
    expect(
      state.promptLabels.map((row) => `${row.name}:${row.label}`).sort(),
    ).toEqual([
      "chat:production",
      "greeting:latest",
      "greeting:production",
      "greeting:staging",
    ]);
    expect(state.promptSnapshots).toHaveLength(3);
    const health = await promptHealth();
    expect(health).toEqual({
      tracked: 2,
      errors: 0,
      lastListAt: state.promptSync[0]!.lastListAt,
      oldestAttemptAt: Math.min(
        ...state.promptNames.map((row) => row.attemptedAt),
      ),
    });
    expect(health.lastListAt! - syncedAt).toBeGreaterThanOrEqual(0);
    expect(health.lastListAt! - syncedAt).toBeLessThanOrEqual(1);
  });

  test("a label and a version together are refused", async () => {
    await expect(
      get("greeting", { label: "production", version: 1 }),
    ).rejects.toThrow(/invalid_prompt_selector/);
  });

  test("a disabled component syncs nothing", async () => {
    vi.stubEnv("LANGFUSE_BASE_URL", "");
    prompts.add("greeting", "Hello");
    expect(await sync()).toEqual({
      status: "disabled",
      tracked: 0,
      overflow: 0,
    });
    expect(rowCounts(await promptTables())).toMatchObject({
      promptNames: 0,
      promptSync: 0,
    });
    expect(fake.requests).toEqual([]);
  });

  test("a prompt name with a slash is requested as one encoded path segment", async () => {
    prompts.add("team/greeting", "Hello team");
    await sync(["team/greeting"]);
    expect(fake.requests.map((request) => request.path)).toContain(
      "/api/public/v2/prompts/team%2Fgreeting?label=production",
    );
    expect(await get("team/greeting")).toMatchObject({ prompt: "Hello team" });
  });

  test("the 501st name is not tracked and sync reports the overflow", async () => {
    const names = Array.from(
      { length: 501 },
      (_, i) => `p${String(i).padStart(3, "0")}`,
    );
    for (const name of names) prompts.add(name, name);
    expect(await t.action(api.prompts.sync, {})).toEqual({
      status: "ok",
      tracked: 500,
      overflow: 1,
    });
    const tracked = (await promptTables()).promptNames.map((row) => row.name);
    expect(tracked).toHaveLength(500);
    expect(tracked).not.toContain("p500");
  });
});

describe("webhook", () => {
  test("a label move followed by a signed webhook changes what get returns", async () => {
    prompts.add("greeting", "Hello v1");
    await sync();
    expect(await get("greeting")).toMatchObject({ version: 1 });

    prompts.add("greeting", "Hello v2");
    expect(await get("greeting")).toMatchObject({ version: 1 });
    vi.setSystemTime(Date.now() + 60_000);
    const deliveredAt = Date.now();
    await notify("greeting");
    expect(await get("greeting")).toMatchObject({
      version: 2,
      prompt: "Hello v2",
    });
    // The transaction clock of convex-test can run up to 1 ms ahead.
    const { lastWebhookAt } = await promptHealth();
    expect(lastWebhookAt! - deliveredAt).toBeGreaterThanOrEqual(0);
    expect(lastWebhookAt! - deliveredAt).toBeLessThanOrEqual(1);
  });

  test("a wrong signature, a stale timestamp and a missing secret are rejected and change no table", async () => {
    prompts.add("greeting", "Hello");
    const body = webhookBody("greeting");
    const before = await promptTables();

    const wrongKey = signature(body, Date.now(), "lf-whsec_wrong");
    expect((await deliver(body, wrongKey)).status).toBe(401);
    const otherBody = webhookBody("other");
    expect((await deliver(otherBody, signature(body))).status).toBe(401);
    expect((await deliver(body, "")).status).toBe(401);
    const stale = signature(body, Date.now() - WEBHOOK_TOLERANCE_MS - 1_000);
    expect((await deliver(body, stale)).status).toBe(401);
    const future = signature(body, Date.now() + WEBHOOK_TOLERANCE_MS + 1_000);
    expect((await deliver(body, future)).status).toBe(401);
    vi.stubEnv("LANGFUSE_WEBHOOK_SECRET", "");
    expect((await deliver(body)).status).toBe(404);

    await settle();
    expect(await promptTables()).toEqual(before);
    expect(fake.requests).toEqual([]);
  });

  test("five identical valid deliveries add no row beyond the first", async () => {
    prompts.add("greeting", "Hello");
    const body = webhookBody("greeting");
    const header = signature(body);
    const response = await deliver(body, header);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    await settle();
    const counts = rowCounts(await promptTables());
    expect(counts).toEqual({
      promptSnapshots: 1,
      promptLabels: 1,
      promptNames: 1,
      promptPins: 0,
      promptSync: 1,
    });

    for (let i = 0; i < 4; i++) {
      expect((await deliver(body, header)).status).toBe(200);
      await settle();
    }
    expect(rowCounts(await promptTables())).toEqual(counts);
    expect(await get("greeting")).toMatchObject({ prompt: "Hello" });
  });

  test("an event of another type is acknowledged and ignored", async () => {
    const body = JSON.stringify({ type: "skill-version", apiVersion: "v1" });
    expect((await deliver(body)).status).toBe(200);
    expect((await deliver("not json")).status).toBe(400);
    expect((await pendingScheduled(t)).length).toBe(0);
  });
});

describe("pins", () => {
  test("a pin keeps its bytes through a label move, a moved reference and another fallback; a second scope gets the new snapshot; an expired pin resolves again", async () => {
    prompts.add("child", "world");
    prompts.add(
      "parent",
      "Hello @@@langfusePrompt:name=child|label=production@@@",
    );
    await sync();
    const first = await pin("chat-1", "parent");
    expect(first).toMatchObject({
      prompt: "Hello world",
      version: 1,
      source: "langfuse",
    });

    // The label moves to a new version of the parent.
    prompts.add(
      "parent",
      "Hi @@@langfusePrompt:name=child|label=production@@@",
    );
    await notify("parent");
    expect(await get("parent")).toMatchObject({
      version: 2,
      prompt: "Hi world",
    });
    expect(await pin("chat-1", "parent")).toEqual(first);

    // The referenced prompt's label moves: same parent version, new content.
    prompts.add("child", "there");
    await notify("child");
    expect(await get("parent")).toMatchObject({
      version: 2,
      prompt: "Hi there",
    });
    expect(await pin("chat-1", "parent")).toEqual(first);

    expect(
      await pin("chat-1", "parent", {
        fallback: { type: "text", prompt: "Other fallback" },
      }),
    ).toEqual(first);

    expect(await pin("chat-2", "parent")).toMatchObject({
      version: 2,
      prompt: "Hi there",
    });

    vi.setSystemTime(Date.now() + PIN_TTL_MS + 1);
    expect(await pin("chat-1", "parent")).toMatchObject({
      version: 2,
      prompt: "Hi there",
    });
  });

  test("get and pin return the source; a fallback snapshot returns fallback", async () => {
    const fallback = await pin("s1", "intro", {
      fallback: {
        type: "text",
        prompt: "Fallback intro",
        config: '{"b":1,"a":2}',
      },
    });
    expect(fallback).toMatchObject({
      source: "fallback",
      prompt: "Fallback intro",
      config: '{"a":2,"b":1}',
    });
    expect(fallback).not.toHaveProperty("version");
    expect(await get("intro")).toBeNull();

    prompts.add("intro", "Remote intro");
    await sync(["intro"]);
    expect(await get("intro")).toMatchObject({ source: "langfuse" });
    expect(await pin("s2", "intro")).toMatchObject({
      source: "langfuse",
      prompt: "Remote intro",
    });
    expect(await pin("s1", "intro")).toEqual(fallback);
  });

  test("a miss without a fallback returns null and stores nothing", async () => {
    const before = await promptTables();
    expect(await pin("s1", "intro")).toBeNull();
    expect(await promptTables()).toEqual(before);
  });

  test("a chat fallback is stored as canonical JSON", async () => {
    const result = await pin("s1", "chat", {
      fallback: {
        type: "chat",
        prompt: JSON.stringify([{ role: "user", content: "Hi" }]),
      },
    });
    expect(result).toMatchObject({
      type: "chat",
      prompt: '[{"content":"Hi","role":"user"}]',
      config: "{}",
    });
    await expect(
      pin("s2", "chat", { fallback: { type: "chat", prompt: '"text"' } }),
    ).rejects.toThrow(/invalid_fallback/);
  });
});

describe("snapshots", () => {
  test("equal content from another version, another source or another resolution graph is another snapshot", async () => {
    prompts.add("same", "Same text", ["old"]);
    prompts.add("same", "Same text", ["production"]);
    prompts.add("leaf", "x");
    prompts.add("graph", "Use @@@langfusePrompt:name=leaf|label=production@@@");
    await sync();

    const v1 = await get("same", { label: "old" });
    const v2 = await get("same");
    expect(v1).toMatchObject({ version: 1, prompt: "Same text" });
    expect(v2).toMatchObject({ version: 2, prompt: "Same text" });
    expect(v2!.snapshotId).not.toBe(v1!.snapshotId);

    const fallback = await pin("s", "same", {
      label: "missing",
      fallback: { type: "text", prompt: "Same text" },
    });
    expect(fallback).toMatchObject({ source: "fallback", prompt: "Same text" });
    expect([v1!.snapshotId, v2!.snapshotId]).not.toContain(
      fallback!.snapshotId,
    );

    // The leaf gets a new version with equal content: the parent's resolved
    // text stays, its resolution graph changes.
    const before = await get("graph");
    prompts.add("leaf", "x");
    await notify("leaf");
    const after = await get("graph");
    expect(after).toMatchObject({ version: before!.version, prompt: "Use x" });
    expect(after!.snapshotId).not.toBe(before!.snapshotId);
  });

  test("the same result with its resolution graph in another order adds no snapshot", async () => {
    prompts.add("a", "A");
    prompts.add("b", "B");
    prompts.add(
      "p",
      "@@@langfusePrompt:name=b|label=production@@@ @@@langfusePrompt:name=a|label=production@@@",
    );
    await sync();
    const first = await get("p");
    const count = (await promptTables()).promptSnapshots.length;
    const graph = (await promptTables()).promptSnapshots.find(
      (row) => row._id === first!.snapshotId,
    )!.resolutionGraph!;
    expect(graph).toBe(
      '{"dependencies":{"p@1":[{"id":"a@1","name":"a","version":1},{"id":"b@1","name":"b","version":1}]},"root":{"id":"p@1","name":"p","version":1}}',
    );

    prompts.reverseGraphs = true;
    await notify("p");
    expect((await get("p"))!.snapshotId).toBe(first!.snapshotId);
    expect((await promptTables()).promptSnapshots).toHaveLength(count);
  });

  test("a candidate with an 850 KiB prompt and a 200 KiB resolution graph is not cached", async () => {
    prompts.add("big", "small");
    prompts.override = (request) =>
      request.path.startsWith("/api/public/v2/prompts/big?")
        ? {
            status: 200,
            body: {
              name: "big",
              version: 1,
              type: "text",
              prompt: "x".repeat(850 * 1024),
              config: {},
              labels: ["production"],
              resolutionGraph: {
                root: { id: "big@1", name: "big", version: 1 },
                dependencies: {
                  "big@1": [
                    {
                      id: "c@1",
                      name: "c",
                      version: 1,
                      pad: "y".repeat(200 * 1024),
                    },
                  ],
                },
              },
            },
          }
        : undefined;
    await sync(["big"]);
    expect(await get("big")).toBeNull();
    expect((await promptTables()).promptSnapshots).toEqual([]);
    expect((await nameRow("big"))?.error).toBe("oversize");
    expect((await promptHealth()).errors).toBe(1);
  });
});

describe("refresh", () => {
  test("two refreshes for one name where the older finishes last: the newer result stays", async () => {
    prompts.add("greeting", "Hello v1");
    await sync();
    const [older] = await t.mutation(internal.prompts.reserve, {
      names: ["greeting"],
    });

    // The older refresh reads v1 and is held before it can apply.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = true;
    fake.fallback = async (request) => {
      const answer = prompts.answer(request);
      if (holding && request.path.includes("?label=")) {
        holding = false;
        await held;
      }
      return answer;
    };
    const sent = fake.requests.length;
    const olderRun = t.action(internal.prompts.refresh, {
      name: "greeting",
      generation: older!,
    });
    while (!fake.requests.slice(sent).some((r) => r.path.includes("?label="))) {
      await realTick();
    }

    prompts.add("greeting", "Hello v2");
    vi.setSystemTime(Date.now() + 1);
    const [newer] = await t.mutation(internal.prompts.reserve, {
      names: ["greeting"],
    });
    expect(newer).toBeGreaterThan(older!);
    await t.action(internal.prompts.refresh, {
      name: "greeting",
      generation: newer!,
    });
    expect(await get("greeting")).toMatchObject({ prompt: "Hello v2" });

    release();
    await olderRun;
    expect(await get("greeting")).toMatchObject({ prompt: "Hello v2" });
  });

  test("without a webhook, the rolling refresh picks up a moved label, a deleted prompt, a deleted dependency and a failed refresh", async () => {
    prompts.add("moved", "m1");
    prompts.add("deleted", "d1");
    prompts.add("leaf", "l1");
    prompts.add("parent", "p @@@langfusePrompt:name=leaf|version=1@@@");
    prompts.add("flaky", "f1");
    await sync();
    expect(await get("parent")).toMatchObject({ prompt: "p l1" });
    const start = Date.now();

    prompts.add("moved", "m2");
    prompts.delete("deleted");
    prompts.delete("leaf");
    prompts.add("flaky", "f2");
    let failures = 0;
    prompts.override = (request) =>
      request.path.startsWith("/api/public/v2/prompts/flaky?") &&
      failures++ === 0
        ? { network: true }
        : undefined;

    const tickAt = async (minutes: number) => {
      vi.setSystemTime(start + minutes * 60_000);
      await t.mutation(internal.prompts.tick, {});
      await settle();
    };
    for (const minutes of [5, 10]) await tickAt(minutes);
    expect(await get("moved")).toMatchObject({ prompt: "m1" });

    // 15 minutes plus one tick after the changes.
    for (const minutes of [15, 20]) await tickAt(minutes);
    expect(await get("moved")).toMatchObject({ prompt: "m2" });
    expect(await get("deleted")).toBeNull();
    expect(await get("parent")).toBeNull();
    expect((await nameRow("parent"))?.error).toBe("http_409");
    expect(await nameRow("deleted")).toBeUndefined();
    expect(await get("flaky")).toMatchObject({ prompt: "f1" });
    expect((await nameRow("flaky"))?.error).toBe("network");

    // 15 minutes plus one tick after the failed refresh at minute 15.
    for (const minutes of [25, 30, 35]) await tickAt(minutes);
    expect(await get("flaky")).toMatchObject({ prompt: "f2" });
    expect((await nameRow("flaky"))?.error).toBeUndefined();
  });

  test("a 500 from the endpoint keeps the old mapping and records the error", async () => {
    prompts.add("greeting", "Hello v1");
    await sync();
    const first = await get("greeting");

    prompts.add("greeting", "Hello v2");
    prompts.override = (request) =>
      request.path.includes("?label=") ? { status: 500, body: {} } : undefined;
    await notify("greeting");
    expect(await get("greeting")).toEqual(first);
    expect((await nameRow("greeting"))?.error).toBe("http_500");
    expect((await promptHealth()).errors).toBe(1);
  });

  test("the tick writes and schedules nothing before promptSync exists or while disabled", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("promptNames", {
        name: "greeting",
        generation: 1,
        dependsOn: [],
        attemptedAt: Date.now() - 2 * PROMPT_REFRESH_INTERVAL_MS,
      });
    });
    const before = await promptTables();
    await t.mutation(internal.prompts.tick, {});
    expect(await promptTables()).toEqual(before);
    expect(await pendingScheduled(t)).toEqual([]);

    await t.run(async (ctx) => {
      await ctx.db.insert("promptSync", {});
    });
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    const withSync = await promptTables();
    await t.mutation(internal.prompts.tick, {});
    expect(await promptTables()).toEqual(withSync);
    expect(await pendingScheduled(t)).toEqual([]);
  });
});

describe("retention", () => {
  test("after 50 label moves and a sweep, only snapshots referenced by a label or a live pin remain", async () => {
    prompts.add("greeting", "v0");
    await sync();
    await pin("live", "greeting");
    for (let i = 1; i <= 50; i++) {
      vi.setSystemTime(Date.now() + 1_000);
      prompts.add("greeting", `v${i}`);
      await notify("greeting");
      if (i === 10) await pin("short", "greeting", { ttlMs: 60_000 });
    }
    expect((await promptTables()).promptSnapshots).toHaveLength(51);

    vi.setSystemTime(Date.now() + SNAPSHOT_GRACE_MS + 1);
    await t.mutation(internal.retention.sweep, {});
    const state = await promptTables();
    expect(state.promptSnapshots.map((row) => row.prompt).sort()).toEqual([
      "v0",
      "v50",
    ]);
    expect(state.promptPins.map((row) => row.scope)).toEqual(["live"]);
    expect(await pin("live", "greeting")).toMatchObject({ prompt: "v0" });
  });

  test("a sweep that reaches its read budget continues the snapshot scan in the next run", async () => {
    const old = Date.now() - 2 * SNAPSHOT_GRACE_MS;
    await t.run(async (ctx) => {
      // 12 referenced snapshots of 850 KiB, more than one run reads, then
      // one unreferenced snapshot.
      for (let i = 0; i < 12; i++) {
        const snapshotId = await ctx.db.insert("promptSnapshots", {
          key: `big-${i}`,
          name: "big",
          version: i + 1,
          source: "langfuse",
          type: "text",
          prompt: "x".repeat(850 * 1024),
          config: "{}",
          fetchedAt: old + i,
        });
        await ctx.db.insert("promptLabels", {
          name: "big",
          label: `l${i}`,
          snapshotId,
        });
      }
      await ctx.db.insert("promptSnapshots", {
        key: "orphan",
        name: "orphan",
        version: 1,
        source: "langfuse",
        type: "text",
        prompt: "orphan",
        config: "{}",
        fetchedAt: old + 100,
      });
    });

    await t.mutation(internal.retention.sweep, {});
    let names = (await promptTables()).promptSnapshots.map((row) => row.name);
    expect(names).toContain("orphan");
    expect(await pendingScheduled(t)).toEqual(["retention:sweep"]);

    await settle();
    names = (await promptTables()).promptSnapshots.map((row) => row.name);
    expect(names).not.toContain("orphan");
    expect(names).toHaveLength(12);
  });
});
