import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  MAX_PROMPT_DEPENDENCIES,
  MAX_PROMPT_LABELS,
  MAX_PROMPT_NAME_BYTES,
  MAX_PROMPT_NAMES,
  MAX_PROMPT_RESPONSE_BYTES,
  MAX_PROMPT_SCOPE_BYTES,
  MAX_SNAPSHOT_BYTES,
  PIN_TTL_MS,
  PROMPT_LIST_MAX_NAMES,
  PROMPT_LIST_MAX_REQUESTS,
  PROMPT_REFRESH_INTERVAL_MS,
  PROMPT_REFRESH_MAX_MS,
  PROMPT_REFRESH_SPACING_MS,
  PROMPT_STEP_LABELS,
  RETENTION_BATCH,
  SNAPSHOT_GRACE_MS,
  WEBHOOK_TOLERANCE_MS,
} from "./constants.js";
import {
  enableExport,
  installFakeLangfuse,
  pendingScheduled,
  refusalCode,
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
import { byteLength } from "../shared/otlp.js";

// Captured before a test installs fake timers.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realTick = () => new Promise((resolve) => realSetTimeout(resolve, 5));

/**
 * For a test over `MAX_PROMPT_NAMES` names: it does 500 times the work of
 * the others and passes the default 5 s on a busy machine.
 */
const LONG = { timeout: 30_000 };

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

/**
 * Runs scheduled functions, and the ones they schedule, until none is left.
 * The fake clock moves to each one's time, such as a tick's spaced refreshes.
 */
async function settle(): Promise<void> {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
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
    version?: number;
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
  promptVersions: Doc<"promptVersions">[];
  promptNames: Doc<"promptNames">[];
  promptPins: Doc<"promptPins">[];
  promptSync: Doc<"promptSync">[];
  promptSlots: Doc<"promptSlots">[];
};

async function promptTables(): Promise<PromptTables> {
  return await t.run(async (ctx) => ({
    promptSnapshots: await ctx.db.query("promptSnapshots").collect(),
    promptLabels: await ctx.db.query("promptLabels").collect(),
    promptVersions: await ctx.db.query("promptVersions").collect(),
    promptNames: await ctx.db.query("promptNames").collect(),
    promptPins: await ctx.db.query("promptPins").collect(),
    promptSync: await ctx.db.query("promptSync").collect(),
    promptSlots: await ctx.db.query("promptSlots").collect(),
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

const MINUTE = 60_000;

/** The refreshes that are scheduled and have not run, with their start time. */
async function scheduledRefreshes(): Promise<{ name: string; at: number }[]> {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter(
        (job) => job.state.kind === "pending" && job.name === "prompts:refresh",
      )
      .map((job) => ({
        name: (job.args[0] as { name: string }).name,
        at: job.scheduledTime,
      })),
  );
}

/** A text snapshot of `name` as a refresh would store it, for direct inserts. */
function snapshotDoc(
  name: string,
  fields: { fetchedAt: number; prompt?: string },
): Omit<Doc<"promptSnapshots">, "_id" | "_creationTime"> {
  return {
    key: `${name}-${fields.fetchedAt}-${Math.random()}`,
    name,
    version: 1,
    source: "langfuse",
    type: "text",
    prompt: fields.prompt ?? name,
    config: "{}",
    fetchedAt: fields.fetchedAt,
  };
}

/**
 * A fake answer that holds the first request `matches` accepts until
 * `release` is called, and tells once that request arrived.
 */
function holdFirst(matches: (path: string) => boolean) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let holding = true;
  const from = fake.requests.length;
  fake.fallback = async (request) => {
    const answer = prompts.answer(request);
    if (holding && matches(request.path)) {
      holding = false;
      await held;
    }
    return answer;
  };
  return {
    release,
    arrived: async () => {
      while (!fake.requests.slice(from).some((r) => matches(r.path))) {
        await realTick();
      }
    },
  };
}

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

  test(
    "the 501st name is not tracked and sync reports the overflow",
    LONG,
    async () => {
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
    },
  );

  test(
    "a name that left the cache frees its place for another name",
    LONG,
    async () => {
      for (let i = 0; i < MAX_PROMPT_NAMES; i++) {
        const name = `p${String(i).padStart(3, "0")}`;
        prompts.add(name, name);
      }
      await sync();
      prompts.add("late", "late");
      expect(await sync(["late"])).toEqual({
        status: "ok",
        tracked: 0,
        overflow: 1,
      });

      // The refresh finds the prompt gone and stops tracking the name.
      prompts.delete("p000");
      await sync(["p000"]);
      expect(await sync(["late"])).toEqual({
        status: "ok",
        tracked: 1,
        overflow: 0,
      });
      expect(await get("late")).toMatchObject({ prompt: "late" });
    },
  );

  test("a name of 257 UTF-8 bytes: sync refuses it, the listing counts it as overflow, get returns null and pin refuses it", async () => {
    const longest = "é".repeat(MAX_PROMPT_NAME_BYTES / 2);
    const long = `${longest}n`;
    prompts.add(longest, "Longest");
    prompts.add(long, "Too long");

    expect(
      await refusalCode(t.action(api.prompts.sync, { names: [long] })),
    ).toBe("invalid_prompt_name");
    expect(await sync()).toEqual({ status: "ok", tracked: 1, overflow: 1 });
    expect(await get(longest)).toMatchObject({ prompt: "Longest" });
    expect(await get(long)).toBeNull();
    expect(
      await refusalCode(
        pin("s", long, { fallback: { type: "text", prompt: "Fallback" } }),
      ),
    ).toBe("invalid_prompt_name");
    const state = await promptTables();
    expect(state.promptNames.map((row) => row.name)).toEqual([longest]);
    expect(state.promptPins).toEqual([]);
  });

  test("a listing cut at its name cap returns incomplete, and the next tick starts no listing", async () => {
    prompts.override = (request) => {
      const url = new URL(request.url);
      if (
        url.pathname !== "/api/public/v2/prompts" ||
        url.searchParams.has("name")
      ) {
        return undefined;
      }
      const page = Number(url.searchParams.get("page"));
      return {
        status: 200,
        body: {
          data: [{ name: `p${page}`, labels: ["production"] }],
          meta: { page, totalItems: PROMPT_LIST_MAX_NAMES + 1 },
        },
      };
    };
    expect(await sync()).toEqual({
      status: "incomplete",
      tracked: PROMPT_LIST_MAX_NAMES / 100,
      overflow: 0,
    });

    vi.setSystemTime(Date.now() + 5 * MINUTE);
    await t.mutation(internal.prompts.tick, {});
    expect(await pendingScheduled(t)).toEqual([]);
  });
});

describe("listing", () => {
  /** Query strings of the project listing's requests, in order. */
  const listingQueries = () =>
    fake.requests
      .map((request) => new URL(request.url))
      .filter(
        (url) =>
          url.pathname === "/api/public/v2/prompts" &&
          !url.searchParams.has("name"),
      )
      .map((url) => url.search);

  const names = (count: number) =>
    Array.from({ length: count }, (_, i) => `p${String(i).padStart(3, "0")}`);

  /** Lets the tick start the hourly listing and its refreshes finish. */
  async function hourlyListing(): Promise<void> {
    await t.run(async (ctx) => {
      await ctx.db.insert("promptSync", {});
    });
    await t.mutation(internal.prompts.tick, {});
    await settle();
  }

  test.each(["sync", "the hourly listing"])(
    "names whose configs fit one by one but not on one page are all tracked and cached through %s",
    async (via) => {
      const config = { pad: "x".repeat(800 * 1024) };
      // The fewest names whose latest configs pass the response cap together.
      const big = names(
        Math.floor(MAX_PROMPT_RESPONSE_BYTES / (800 * 1024)) + 1,
      );
      for (const name of big) prompts.add(name, name, ["production"], config);

      if (via === "sync") {
        expect(await sync()).toEqual({
          status: "ok",
          tracked: big.length,
          overflow: 0,
        });
      } else {
        await hourlyListing();
      }
      // The pages of 100 and of 10 pass the cap; every name is read alone.
      expect(listingQueries()).toEqual([
        "?page=1&limit=100",
        "?page=1&limit=10",
        ...big.map((_, i) => `?page=${i + 1}&limit=1`),
      ]);
      for (const name of big) {
        const cached = await get(name);
        expect(cached?.prompt).toBe(name);
        expect(cached?.config === JSON.stringify(config)).toBe(true);
      }
    },
  );

  test("a name whose listing entry alone passes the cap is skipped and makes sync incomplete; the other 249 are tracked", async () => {
    const all = names(250);
    const huge = all[149]!;
    for (const name of all) {
      prompts.add(
        name,
        name,
        ["production"],
        name === huge ? { pad: "x".repeat(MAX_PROMPT_RESPONSE_BYTES) } : {},
      );
    }
    expect(await t.action(api.prompts.sync, {})).toEqual({
      status: "incomplete",
      tracked: 249,
      overflow: 0,
    });
    expect(listingQueries()).toContain("?page=150&limit=1");
    const tracked = (await promptTables()).promptNames.map((row) => row.name);
    expect(tracked.sort()).toEqual(all.filter((name) => name !== huge));
  });

  test("a listing that reaches its request cap returns incomplete, and the next tick starts no listing", async () => {
    for (const name of names(250)) prompts.add(name, name);
    // Every page of more than one name passes the cap.
    prompts.override = (request) => {
      const url = new URL(request.url);
      return url.pathname === "/api/public/v2/prompts" &&
        Number(url.searchParams.get("limit")) > 1
        ? {
            status: 200,
            headers: {
              "content-length": String(MAX_PROMPT_RESPONSE_BYTES + 1),
            },
            body: {},
          }
        : undefined;
    };
    // A block of 100 names takes 1 + 10 × (1 + 10) = 111 requests. The 39
    // left read the next page of 100 and three blocks of 10 in 1 + 3 × 11
    // requests, then a page of 10 and four names alone: 100 + 30 + 4 names.
    expect(await sync()).toEqual({
      status: "incomplete",
      tracked: 134,
      overflow: 0,
    });
    expect(listingQueries()).toHaveLength(PROMPT_LIST_MAX_REQUESTS);

    vi.setSystemTime(Date.now() + 5 * MINUTE);
    await t.mutation(internal.prompts.tick, {});
    expect(await pendingScheduled(t)).toEqual([]);
  });

  test("a project of 250 small names is listed in three requests", async () => {
    for (const name of names(250)) prompts.add(name, name);
    expect(await t.action(api.prompts.sync, {})).toEqual({
      status: "ok",
      tracked: 250,
      overflow: 0,
    });
    expect(listingQueries()).toEqual([
      "?page=1&limit=100",
      "?page=2&limit=100",
      "?page=3&limit=100",
    ]);
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

  test("five identical valid deliveries each refresh the prompt and add no row beyond the first", async () => {
    prompts.add("greeting", "Hello");
    const fetches = () =>
      fake.requests.filter((request) =>
        request.path.startsWith("/api/public/v2/prompts/greeting?"),
      ).length;
    const body = webhookBody("greeting");
    const header = signature(body);
    const response = await deliver(body, header);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    await settle();
    expect(fetches()).toBe(1);
    const counts = rowCounts(await promptTables());
    expect(counts).toEqual({
      promptSnapshots: 1,
      promptLabels: 1,
      promptVersions: 1,
      promptNames: 1,
      promptPins: 0,
      promptSync: 1,
      promptSlots: 1,
    });

    for (let i = 0; i < 4; i++) {
      expect((await deliver(body, header)).status).toBe(200);
      await settle();
      expect(fetches()).toBe(i + 2);
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

  test("a webhook for a name of 257 UTF-8 bytes answers 200 and tracks nothing", async () => {
    const long = `${"é".repeat(MAX_PROMPT_NAME_BYTES / 2)}n`;
    prompts.add(long, "Too long");
    await notify(long);
    expect((await promptTables()).promptNames).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  test("a parent that lost its label on a 409 is refreshed by the webhook of its restored dependency", async () => {
    prompts.add("child", "world");
    prompts.add(
      "parent",
      "Hello @@@langfusePrompt:name=child|label=production@@@",
    );
    await sync();

    prompts.delete("child");
    await notify("child");
    expect(await get("parent")).toBeNull();
    expect((await nameRow("parent"))?.error).toBe("http_409");

    prompts.add("child", "again");
    await notify("child");
    expect(await get("parent")).toMatchObject({ prompt: "Hello again" });
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

  test("a scope of 257 UTF-8 bytes is refused with invalid_prompt_scope and stores nothing; one of 256 is pinned", async () => {
    const longest = "é".repeat(MAX_PROMPT_SCOPE_BYTES / 2);
    const fallback = { type: "text" as const, prompt: "Fallback" };
    const before = await promptTables();
    expect(await refusalCode(pin(`${longest}s`, "intro", { fallback }))).toBe(
      "invalid_prompt_scope",
    );
    expect(await promptTables()).toEqual(before);

    expect(await pin(longest, "intro", { fallback })).toMatchObject({
      prompt: "Fallback",
    });
    expect((await promptTables()).promptPins.map((row) => row.scope)).toEqual([
      longest,
    ]);
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

  /**
   * Caches `big`, then answers its next fetch with a body of four times the
   * cap, pulled only as the reader asks, and refreshes it. Returns the bytes
   * the body handed out.
   */
  async function refreshOversize(
    headers?: Record<string, string>,
  ): Promise<number> {
    prompts.add("big", "small");
    await sync(["big"]);
    expect(await get("big")).toMatchObject({ prompt: "small" });

    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent >= 4 * MAX_PROMPT_RESPONSE_BYTES) return controller.close();
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    prompts.override = (request) =>
      request.path.startsWith("/api/public/v2/prompts/big?")
        ? { status: 200, headers, body }
        : undefined;
    await notify("big");
    expect(await get("big")).toBeNull();
    expect((await promptTables()).promptLabels).toEqual([]);
    expect((await nameRow("big"))?.error).toBe("oversize");
    return sent;
  }

  test("a label whose response body passes the cap is removed as oversize, and the body is read no further than the cap", async () => {
    const sent = await refreshOversize();
    expect(sent).toBeGreaterThan(MAX_PROMPT_RESPONSE_BYTES);
    expect(sent).toBeLessThanOrEqual(MAX_PROMPT_RESPONSE_BYTES + 64 * 1024);
  });

  test("a label whose Content-Length passes the cap is removed as oversize without reading the body", async () => {
    const declared = String(MAX_PROMPT_RESPONSE_BYTES + 1);
    expect(await refreshOversize({ "content-length": declared })).toBe(0);
  });

  test("a response just under the cap with a snapshot of the largest size is cached", async () => {
    // A line break takes two bytes in the response; with the config `{}`
    // the snapshot has exactly `MAX_SNAPSHOT_BYTES`.
    const prompt = "\n".repeat(MAX_SNAPSHOT_BYTES - 2);
    const body = {
      id: "big@1",
      name: "big",
      version: 1,
      type: "text",
      prompt,
      config: {},
      labels: ["production"],
      tags: [],
      resolutionGraph: null,
      commitMessage: "",
    };
    body.commitMessage = "x".repeat(
      MAX_PROMPT_RESPONSE_BYTES - 1 - byteLength(JSON.stringify(body)),
    );
    expect(byteLength(JSON.stringify(body))).toBe(
      MAX_PROMPT_RESPONSE_BYTES - 1,
    );
    prompts.add("big", "listed");
    prompts.override = (request) =>
      request.path.startsWith("/api/public/v2/prompts/big?")
        ? { status: 200, body }
        : undefined;
    await sync(["big"]);
    const cached = await get("big");
    expect(cached?.config).toBe("{}");
    expect(cached?.prompt === prompt).toBe(true);
  });

  test("a text prompt of control characters with a snapshot just under the largest size is cached", async () => {
    // With the config `{}` the snapshot has `MAX_SNAPSHOT_BYTES` - 1 bytes;
    // each character escapes to six bytes of the response.
    const prompt = "\u0001".repeat(MAX_SNAPSHOT_BYTES - 3);
    expect(byteLength(JSON.stringify(prompt))).toBeGreaterThan(5 * 1024 * 1024);
    prompts.add("control", prompt);
    await sync(["control"]);
    const cached = await get("control");
    expect(cached?.config).toBe("{}");
    expect(cached?.prompt === prompt).toBe(true);
  });

  test("a version returns what the last refresh resolved it to, while a pin keeps an earlier resolution", async () => {
    prompts.add("child", "A");
    prompts.add("parent", "@@@langfusePrompt:name=child|label=production@@@");
    await sync();
    expect(await get("parent", { version: 1 })).toMatchObject({ prompt: "A" });

    // The child's label moves to a new version: parent version 1 reads B.
    prompts.add("child", "B");
    await notify("child");
    expect(await get("parent", { version: 1 })).toMatchObject({ prompt: "B" });
    const pinned = await pin("s1", "parent", { version: 1 });
    expect(pinned).toMatchObject({ prompt: "B" });

    // It moves back: the refresh finds the first snapshot by its key.
    prompts.move("child", 1, "production");
    await notify("child");
    expect(await get("parent")).toMatchObject({ prompt: "A" });
    expect(await get("parent", { version: 1 })).toMatchObject({ prompt: "A" });
    expect(await pin("s2", "parent", { version: 1 })).toMatchObject({
      prompt: "A",
    });
    expect(await pin("s1", "parent")).toEqual(pinned);
  });

  test("a dependency name of 257 bytes is left out of dependsOn, also where it would sort into the first 32, and the error is recorded", async () => {
    const long = "a".repeat(MAX_PROMPT_NAME_BYTES + 1);
    const children = Array.from(
      { length: MAX_PROMPT_DEPENDENCIES },
      (_, i) => `c${String(i).padStart(2, "0")}`,
    );
    for (const child of [long, ...children]) prompts.add(child, "x");
    prompts.add(
      "parent",
      [long, ...children]
        .map((child) => `@@@langfusePrompt:name=${child}|label=production@@@`)
        .join(""),
    );
    await sync(["parent"]);
    expect(await get("parent")).toMatchObject({ prompt: "x".repeat(33) });
    expect(await nameRow("parent")).toMatchObject({
      dependsOn: children,
      error: "too_many_dependencies",
    });
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
    const hold = holdFirst((path) => path.includes("?label="));
    const olderRun = t.action(internal.prompts.refresh, {
      name: "greeting",
      token: older!,
    });
    await hold.arrived();

    prompts.add("greeting", "Hello v2");
    const [newer] = await t.mutation(internal.prompts.reserve, {
      names: ["greeting"],
    });
    expect(newer).not.toBe(older);
    await t.action(internal.prompts.refresh, {
      name: "greeting",
      token: newer!,
    });
    expect(await get("greeting")).toMatchObject({ prompt: "Hello v2" });

    hold.release();
    await olderRun;
    expect(await get("greeting")).toMatchObject({ prompt: "Hello v2" });
  });

  test("with a frozen clock, a refresh reserved before the name was deleted and tracked again leaves the newer result", async () => {
    const refresh = async (token: string | null) =>
      await t.action(internal.prompts.refresh, {
        name: "greeting",
        token: token!,
      });
    const reserve = async () =>
      (await t.mutation(internal.prompts.reserve, { names: ["greeting"] }))[0]!;

    // With the fake clock frozen at T, convex-test runs the first
    // transaction at T and every later one at T + 1. A fence derived from
    // the clock would give the row created again below the value of the
    // older reservation.
    prompts.add("greeting", "Old");
    await reserve();
    const older = await reserve();
    const hold = holdFirst((path) => path.includes("?label="));
    const olderRun = refresh(older);
    await hold.arrived();

    // The prompt is deleted, its refresh deletes the row, and it is tracked
    // again, all in the same millisecond.
    prompts.delete("greeting");
    await refresh(await reserve());
    expect(await nameRow("greeting")).toBeUndefined();
    prompts.add("greeting", "New");
    await refresh(await reserve());
    expect(await get("greeting")).toMatchObject({ prompt: "New" });

    hold.release();
    await olderRun;
    expect(await get("greeting")).toMatchObject({ prompt: "New" });
  });

  test("a refresh that stops after its first storing step publishes no label, and the next one publishes every label together", async () => {
    const labels = ["a", "b", "c", "d", "e", "f"];
    expect(labels.length).toBeGreaterThan(PROMPT_STEP_LABELS);
    prompts.add("greeting", "Old", labels);
    await sync();
    prompts.add("greeting", "New", labels);

    // The first label of the second step never answers.
    const hold = holdFirst((path) => path.endsWith("?label=e"));
    const [token] = await t.mutation(internal.prompts.reserve, {
      names: ["greeting"],
    });
    const stopped = t.action(internal.prompts.refresh, {
      name: "greeting",
      token: token!,
    });
    await hold.arrived();
    for (const label of labels) {
      expect(await get("greeting", { label })).toMatchObject({ prompt: "Old" });
    }

    await notify("greeting");
    for (const label of labels) {
      expect(await get("greeting", { label })).toMatchObject({ prompt: "New" });
    }
    hold.release();
    await stopped;
  });

  test("a refresh of 50 labels has at most two label requests in flight at once", async () => {
    const labels = Array.from(
      { length: MAX_PROMPT_LABELS },
      (_, i) => `l${String(i).padStart(2, "0")}`,
    );
    prompts.add("wide", "Hello", labels);
    let inFlight = 0;
    let most = 0;
    fake.fallback = async (request) => {
      if (!request.path.includes("?label=")) return prompts.answer(request);
      most = Math.max(most, ++inFlight);
      await realTick();
      inFlight -= 1;
      return prompts.answer(request);
    };
    await sync(["wide"]);
    expect(most).toBe(2);
    expect((await promptTables()).promptLabels).toHaveLength(MAX_PROMPT_LABELS);
  });

  test("a sweep while a refresh holds an old unreferenced snapshot it reused keeps it, so the refresh publishes it", async () => {
    const labels = ["a", "b", "c", "d", "e"];
    prompts.add("greeting", "First", labels);
    await sync();
    prompts.add("greeting", "Second", labels);
    await notify("greeting");
    vi.setSystemTime(Date.now() + 2 * SNAPSHOT_GRACE_MS);

    // The labels move back. The first step reuses the old snapshot; the
    // refresh is held in its second step while the sweep runs.
    prompts.move("greeting", 1, ...labels);
    const hold = holdFirst((path) => path.endsWith("?label=e"));
    const [token] = await t.mutation(internal.prompts.reserve, {
      names: ["greeting"],
    });
    const run = t.action(internal.prompts.refresh, {
      name: "greeting",
      token: token!,
    });
    await hold.arrived();
    await t.mutation(internal.retention.sweep, {});
    hold.release();
    await run;
    for (const label of labels) {
      expect(await get("greeting", { label })).toMatchObject({
        prompt: "First",
      });
    }
  });

  test("refreshes that die after storing leave no orphan past the grace period and the lease, while the running refresh keeps what it staged", async () => {
    const reserve = async () =>
      (await t.mutation(internal.prompts.reserve, { names: ["greeting"] }))[0]!;
    const store = async (token: string, prompt: string) =>
      (await t.mutation(internal.prompts.store, {
        name: "greeting",
        token,
        candidates: [{ version: 1, type: "text", prompt, config: "{}" }],
      }))![0]!;
    const sweep = () => t.mutation(internal.retention.sweep, {});
    const snapshots = async () => (await promptTables()).promptSnapshots;

    // Every 15 minutes the name is reserved, as a tick does, and its refresh
    // stores a new snapshot and dies before it publishes.
    const start = Date.now();
    let newest = await store(await reserve(), "v0");
    for (let round = 1; round < 12; round++) {
      vi.setSystemTime(start + round * 15 * MINUTE);
      newest = await store(await reserve(), `v${round}`);
      await sweep();
      const oldest = Math.min(...(await snapshots()).map((s) => s.fetchedAt));
      expect(Date.now() - oldest).toBeLessThanOrEqual(
        SNAPSHOT_GRACE_MS + PROMPT_REFRESH_MAX_MS,
      );
    }
    expect((await snapshots()).length).toBeLessThan(12);

    // Every orphan passes the grace period; the running refresh reuses the
    // newest one, and the sweep keeps only that.
    vi.setSystemTime(Date.now() + 2 * SNAPSHOT_GRACE_MS);
    expect(await store(await reserve(), "v11")).toBe(newest);
    await sweep();
    expect((await snapshots()).map((s) => s._id)).toEqual([newest]);

    // That refresh dies too: once its lease is over, the sweep collects it.
    vi.setSystemTime(Date.now() + PROMPT_REFRESH_MAX_MS + 1_000);
    await sweep();
    expect(await snapshots()).toEqual([]);
  });

  test("an orphan that no running refresh staged is collected although its name was reserved a moment ago", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert(
        "promptSnapshots",
        snapshotDoc("greeting", {
          fetchedAt: Date.now() - 2 * SNAPSHOT_GRACE_MS,
        }),
      );
    });
    await t.mutation(internal.prompts.reserve, { names: ["greeting"] });
    expect(await nameRow("greeting")).toBeDefined();
    await t.mutation(internal.retention.sweep, {});
    expect((await promptTables()).promptSnapshots).toEqual([]);
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

    // Due 13 minutes after the sync, reserved by the tick at minute 15.
    await tickAt(15);
    expect(await get("moved")).toMatchObject({ prompt: "m2" });
    expect(await get("deleted")).toBeNull();
    expect(await get("parent")).toBeNull();
    expect((await nameRow("parent"))?.error).toBe("http_409");
    expect(await nameRow("deleted")).toBeUndefined();
    expect(await get("flaky")).toMatchObject({ prompt: "f1" });
    expect((await nameRow("flaky"))?.error).toBe("network");

    // Due 13 minutes after the failed refresh, reserved by the tick at
    // minute 30.
    for (const minutes of [20, 25]) await tickAt(minutes);
    expect(await get("flaky")).toMatchObject({ prompt: "f1" });
    await tickAt(30);
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
        token: "token",
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

  test("a tick with an initialized cache and nothing due writes and schedules nothing", async () => {
    prompts.add("greeting", "Hello");
    await sync();
    vi.setSystemTime(Date.now() + 5 * MINUTE);
    const before = await promptTables();
    await t.mutation(internal.prompts.tick, {});
    expect(await promptTables()).toEqual(before);
    expect(await pendingScheduled(t)).toEqual([]);
  });

  test(
    "500 names attempted one second after a tick are scheduled by the first eligible tick within 99.8 s and applied within 20 minutes",
    LONG,
    async () => {
      const names = Array.from(
        { length: MAX_PROMPT_NAMES },
        (_, i) => `p${String(i).padStart(3, "0")}`,
      );
      for (const name of names) prompts.add(name, name);
      const start = Date.now();
      await t.run(async (ctx) => {
        await ctx.db.insert("promptSync", { lastListAt: start });
        for (const name of names) {
          await ctx.db.insert("promptNames", {
            name,
            token: "token",
            dependsOn: [],
            attemptedAt: start + 1_000,
          });
          await ctx.db.insert("promptSlots", { name });
        }
      });

      for (const minutes of [5, 10, 15]) {
        vi.setSystemTime(start + minutes * MINUTE);
        await t.mutation(internal.prompts.tick, {});
        if (minutes < 15) expect(await scheduledRefreshes()).toEqual([]);
      }
      const scheduled = await scheduledRefreshes();
      expect(scheduled.map((job) => job.name).sort()).toEqual(names);
      const times = scheduled.map((job) => job.at);
      // The transaction clock of convex-test can run up to 1 ms ahead.
      expect(Math.min(...times) - (start + 15 * MINUTE)).toBeLessThanOrEqual(1);
      expect(Math.max(...times) - Math.min(...times)).toBe(
        (MAX_PROMPT_NAMES - 1) * PROMPT_REFRESH_SPACING_MS,
      );

      await vi.advanceTimersByTimeAsync(
        start + 1_000 + 20 * MINUTE - Date.now(),
      );
      await t.finishInProgressScheduledFunctions();
      expect(Date.now()).toBe(start + 1_000 + 20 * MINUTE);
      const labeled = (await promptTables()).promptLabels.map(
        (row) => row.name,
      );
      expect(labeled.sort()).toEqual(names);
    },
  );
});

describe("with Convex's transaction limits", () => {
  beforeEach(() => {
    t = initConvexTest({ transactionLimits: true });
  });

  /** The names of the snapshots left. */
  const snapshotNames = async () =>
    (await promptTables()).promptSnapshots.map((row) => row.name).sort();

  async function sweepUntilDone(): Promise<void> {
    await t.mutation(internal.retention.sweep, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }

  test(
    "500 names with rows of the largest size are reserved and scheduled by one tick and by one webhook",
    LONG,
    async () => {
      const pad = (prefix: string) => prefix.padEnd(MAX_PROMPT_NAME_BYTES, "x");
      const dependsOn = Array.from(
        { length: MAX_PROMPT_DEPENDENCIES },
        (_, i) => pad(`dep${String(i).padStart(2, "0")}`),
      );
      const names = Array.from({ length: MAX_PROMPT_NAMES }, (_, i) =>
        pad(`name${String(i).padStart(3, "0")}`),
      );
      const snapshotIds = await t.run(async (ctx) => {
        await ctx.db.insert("promptSync", { lastListAt: Date.now() });
        const ids: Id<"promptSnapshots">[] = [];
        for (let i = 0; i < MAX_PROMPT_LABELS; i++) {
          ids.push(
            await ctx.db.insert(
              "promptSnapshots",
              snapshotDoc(`s${i}`, { fetchedAt: Date.now() }),
            ),
          );
        }
        return ids;
      });
      // Every row stages `MAX_PROMPT_LABELS` ids, the largest `staged`. A
      // reservation clears it, so the rows are staged again before the webhook.
      const stageAll = () =>
        t.run(async (ctx) => {
          const staged = { at: Date.now(), snapshotIds };
          for (const row of await ctx.db.query("promptNames").collect()) {
            await ctx.db.patch("promptNames", row._id, { staged });
          }
        });
      for (let i = 0; i < names.length; i += 100) {
        await t.run(async (ctx) => {
          for (const name of names.slice(i, i + 100)) {
            await ctx.db.insert("promptNames", {
              name,
              token: "token",
              dependsOn,
              attemptedAt: Date.now() - PROMPT_REFRESH_INTERVAL_MS,
            });
            await ctx.db.insert("promptSlots", { name });
          }
        });
      }

      await stageAll();
      await t.mutation(internal.prompts.tick, {});
      expect(
        (await scheduledRefreshes()).map((job) => job.name).sort(),
      ).toEqual(names);
      const rows = (await promptTables()).promptNames;
      expect(rows.filter((row) => row.token === "token")).toEqual([]);

      await stageAll();
      await t.mutation(internal.prompts.webhook, { name: dependsOn[0]! });
      expect(await scheduledRefreshes()).toHaveLength(2 * MAX_PROMPT_NAMES);
    },
  );

  test("eleven unreferenced snapshots of 900 KiB are all collected once past the grace period; a younger one stays", async () => {
    const fetchedAt = Date.now();
    for (let i = 0; i < 11; i++) {
      await t.run(async (ctx) => {
        await ctx.db.insert(
          "promptSnapshots",
          snapshotDoc(`big${String(i).padStart(2, "0")}`, {
            fetchedAt,
            prompt: "x".repeat(MAX_SNAPSHOT_BYTES - 2),
          }),
        );
      });
    }
    vi.setSystemTime(fetchedAt + SNAPSHOT_GRACE_MS + 1);
    await t.run(async (ctx) => {
      await ctx.db.insert(
        "promptSnapshots",
        snapshotDoc("young", { fetchedAt: fetchedAt + MINUTE }),
      );
    });
    await sweepUntilDone();
    expect(await snapshotNames()).toEqual(["young"]);
  });

  test("a sweep over 200 expired pins and 200 old snapshots that live pins reference, all pins of the largest size, finishes", async () => {
    const name = "n".repeat(MAX_PROMPT_NAME_BYTES);
    const scope = (i: number) => String(i).padEnd(MAX_PROMPT_SCOPE_BYTES, "x");
    const old = Date.now() - 2 * SNAPSHOT_GRACE_MS;
    for (let i = 0; i < RETENTION_BATCH; i++) {
      await t.run(async (ctx) => {
        const snapshotId = await ctx.db.insert(
          "promptSnapshots",
          snapshotDoc(name, { fetchedAt: old }),
        );
        for (const [n, expiresAt] of [
          [i, Date.now() + PIN_TTL_MS],
          [RETENTION_BATCH + i, Date.now() - 1],
        ] as const) {
          await ctx.db.insert("promptPins", {
            scope: scope(n),
            name,
            snapshotId,
            expiresAt,
          });
        }
      });
    }

    await t.mutation(internal.retention.sweep, {});
    const state = await promptTables();
    expect(state.promptSnapshots).toHaveLength(RETENTION_BATCH);
    expect(state.promptPins.map((row) => row.scope).sort()).toEqual(
      Array.from({ length: RETENTION_BATCH }, (_, i) => scope(i)).sort(),
    );
  });

  test("snapshots with one fetchedAt, more than two pages of them, are all collected", async () => {
    const fetchedAt = Date.now() - 2 * SNAPSHOT_GRACE_MS;
    await t.run(async (ctx) => {
      for (let i = 0; i < 2 * RETENTION_BATCH + 50; i++) {
        await ctx.db.insert("promptSnapshots", snapshotDoc("s", { fetchedAt }));
      }
    });
    await sweepUntilDone();
    expect(await snapshotNames()).toEqual([]);
  });

  test("referenced snapshots in front of an orphan stay, more than one run reads, and the orphan goes", async () => {
    const old = Date.now() - 2 * SNAPSHOT_GRACE_MS;
    for (let i = 0; i < 12; i++) {
      await t.run(async (ctx) => {
        const snapshotId = await ctx.db.insert(
          "promptSnapshots",
          snapshotDoc("big", {
            fetchedAt: old + i,
            prompt: "x".repeat(850 * 1024),
          }),
        );
        await ctx.db.insert("promptLabels", {
          name: "big",
          label: `l${i}`,
          snapshotId,
        });
      });
    }
    await t.run(async (ctx) => {
      await ctx.db.insert(
        "promptSnapshots",
        snapshotDoc("orphan", { fetchedAt: old + 100 }),
      );
    });

    await t.mutation(internal.retention.sweep, {});
    expect(await snapshotNames()).toContain("orphan");
    expect(await pendingScheduled(t)).toEqual(["retention:sweep"]);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await snapshotNames()).toEqual(Array(12).fill("big"));
  });

  test("a pass whose cursor document was deleted meanwhile finishes", async () => {
    const old = Date.now() - 2 * SNAPSHOT_GRACE_MS;
    // A page of orphans that ends with a referenced snapshot, then more
    // orphans.
    const last = await t.run(async (ctx) => {
      for (let i = 0; i < RETENTION_BATCH - 1; i++) {
        await ctx.db.insert(
          "promptSnapshots",
          snapshotDoc("first", { fetchedAt: old }),
        );
      }
      const snapshotId = await ctx.db.insert(
        "promptSnapshots",
        snapshotDoc("kept", { fetchedAt: old + 1 }),
      );
      const labelId = await ctx.db.insert("promptLabels", {
        name: "kept",
        label: "production",
        snapshotId,
      });
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert(
          "promptSnapshots",
          snapshotDoc("after", { fetchedAt: old + 2 }),
        );
      }
      return { snapshotId, labelId };
    });

    await t.mutation(internal.retention.sweep, {});
    expect(await snapshotNames()).toEqual([
      "after",
      "after",
      "after",
      "after",
      "after",
      "kept",
    ]);
    await t.run(async (ctx) => {
      await ctx.db.delete("promptLabels", last.labelId);
      await ctx.db.delete("promptSnapshots", last.snapshotId);
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await snapshotNames()).toEqual([]);
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
});
