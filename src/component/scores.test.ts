import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
  BREAKER_REJECTED_SPANS,
  CONFIG_FRESH_MS,
  DEFERRED_MS,
  LEASE_MS,
  MAX_PENDING_AGE_MS,
  MAX_PENDING_DELETES,
  SCORE_SETTLE_MS,
} from "./constants.js";
import {
  drive,
  enableExport,
  installFakeLangfuse,
  observations,
  pendingScheduled,
  spanId,
  startRunByHand,
  tables,
  TRACE,
  type FakeLangfuse,
  type RecordedRequest,
  type TestConvex,
} from "./fakeLangfuse.test-util.js";
import { initConvexTest } from "./setup.test.js";

let t: TestConvex;
let fake: FakeLangfuse;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  enableExport();
  fake = installFakeLangfuse();
  t = initConvexTest();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TIMESTAMP = Date.parse("2026-11-11T11:59:00.000Z");

async function upsert(id: string, value: number, name = "quality") {
  return await t.mutation(api.scores.upsert, {
    id,
    timestamp: TIMESTAMP,
    name,
    value,
    dataType: "NUMERIC",
    traceId: TRACE.traceId,
  });
}

async function recordSpans(from: number, count: number) {
  await t.mutation(api.tracing.record, {
    trace: TRACE,
    observations: observations(from, count),
  });
}

const isScorePost = (r: RecordedRequest) =>
  r.method === "POST" && r.path === "/api/public/scores";
const scorePosts = () => fake.requests.filter(isScorePost);
const scoreBody = (r: RecordedRequest) =>
  JSON.parse(r.body) as { id: string; value: number; configId?: string };
const health = () => t.query(api.outbox.health, {});
const scoreKey = async (id: string) =>
  (await tables(t)).scoreKeys.find((key) => key.scoreId === id);

describe("score ops", () => {
  test("three upserts for one id before the first send go out as one request with the last value", async () => {
    await upsert("s1", 1);
    await upsert("s1", 2);
    await upsert("s1", 3);
    await drive(t, fake);

    expect(scorePosts().map(scoreBody)).toMatchObject([{ id: "s1", value: 3 }]);
    const state = await tables(t);
    expect(state.outbox).toEqual([]);
    expect(state.payloads).toEqual([]);
  });

  test("an upsert during the flight of its predecessor waits for it and goes out at least 30 s after its acceptance", async () => {
    let outboxDuringFlight: string[] = [];
    fake.respond(async () => {
      await upsert("s1", 2);
      const state = await tables(t);
      outboxDuringFlight = state.outbox.map((row) => {
        const payload = state.payloads.find((p) => p._id === row.payloadId)!;
        return String((JSON.parse(payload.data) as { value: number }).value);
      });
      return { status: 200 };
    });
    await upsert("s1", 1);
    await drive(t, fake);

    // The in-flight row survives the enqueue of its successor.
    expect(outboxDuringFlight).toEqual(["1", "2"]);
    const posts = scorePosts();
    expect(posts.map(scoreBody).map((b) => b.value)).toEqual([1, 2]);
    expect(posts[1]!.at - posts[0]!.at).toBeGreaterThanOrEqual(SCORE_SETTLE_MS);
  });

  test("after a transient failure with a successor queued, only the successor is sent", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    fake.respond(async () => {
      await upsert("s1", 2);
      return { status: 503 };
    });
    await upsert("s1", 1);
    await drive(t, fake);

    expect(
      scorePosts()
        .map(scoreBody)
        .map((b) => b.value),
    ).toEqual([1, 2]);
    const state = await tables(t);
    expect(state.outbox).toEqual([]);
    expect(state.payloads).toEqual([]);
  });

  test.each([
    ["without a successor, the op is sent again", false, [1, 1]],
    ["with a successor, only the successor is sent", true, [1, 2]],
  ])(
    "a run that dies with a score op in flight: %s",
    async (_, successor, values) => {
      await upsert("s1", 1);
      await startRunByHand(t);
      const step = await t.mutation(internal.exporter.advance, {
        generation: 1,
      });
      if (!("op" in step)) throw new Error("expected an API op");
      // The request reaches Langfuse; the run dies before it reports.
      const { sendOp } = await import("./exporter.js");
      const config = {
        publicKey: "pk-lf-test",
        secretKey: "sk-lf-test",
        baseUrl: "https://langfuse.test",
      };
      await sendOp(config, step.op);
      expect((await scoreKey("s1"))?.inFlight).toBeDefined();
      if (successor) await upsert("s1", 2);

      vi.setSystemTime(Date.now() + LEASE_MS + 1);
      await t.mutation(internal.exporter.dispatch, { op: "start" });
      const key = await scoreKey("s1");
      expect(key?.inFlight).toBeUndefined();
      expect((await tables(t)).outbox.map((row) => row._id)).toEqual([
        key?.queued,
      ]);

      await drive(t, fake);
      expect(
        scorePosts()
          .map(scoreBody)
          .map((b) => b.value),
      ).toEqual(values);
      expect((await tables(t)).outbox).toEqual([]);
    },
  );

  test("a score row expired by retention leaves no pointer, and a later upsert of the id is sent", async () => {
    await upsert("s1", 1);
    vi.setSystemTime(Date.now() + MAX_PENDING_AGE_MS + 1_000);
    await t.mutation(internal.retention.sweep, {});
    let state = await tables(t);
    expect(state.outbox).toEqual([]);
    expect(state.scoreKeys).toHaveLength(1);
    expect(state.scoreKeys[0]!.queued).toBeUndefined();
    expect(state.scoreKeys[0]!.inFlight).toBeUndefined();

    await upsert("s1", 2);
    await drive(t, fake);
    expect(scorePosts().map(scoreBody)).toMatchObject([{ id: "s1", value: 2 }]);
    state = await tables(t);
    expect(state.outbox).toEqual([]);
  });

  test("retryDeadLetters moves a span dead letter and leaves a score dead letter", async () => {
    await t.run(async (ctx) => {
      for (const kind of ["scoreCreate", "span"] as const) {
        const payloadId = await ctx.db.insert("payloads", { data: kind });
        await ctx.db.insert("deadLetters", {
          kind,
          ref: kind,
          bytes: 1,
          payloadId,
          reason: "rejected",
          status: 400,
          failedAt: Date.now(),
        });
      }
    });
    expect(await t.mutation(internal.outbox.retryDeadLetters, {})).toEqual({
      moved: 1,
    });
    const state = await tables(t);
    expect(state.outbox.map((row) => row.kind)).toEqual(["span"]);
    expect(state.deadLetters.map((row) => row.kind)).toEqual(["scoreCreate"]);
  });

  test("150 score ops of ids accepted less than 30 s ago do not delay a span enqueued after them", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `s${i}`);
    for (const id of ids) await upsert(id, 1);
    await drive(t, fake, { until: () => scorePosts().length === 150 });

    for (const id of ids) await upsert(id, 2);
    const enqueuedAt = Date.now();
    await recordSpans(0, 1);
    await drive(t, fake);

    // The span is the first request after the first round of scores.
    const spanRequest = fake.requests[150]!;
    expect(spanRequest.spanIds).toEqual([spanId(0)]);
    expect(spanRequest.at - enqueuedAt).toBeLessThan(SCORE_SETTLE_MS);
    expect(scorePosts()).toHaveLength(300);
    expect(fake.requests.slice(151).every(isScorePost)).toBe(true);
  });

  test("a 400 for a score is dead-lettered without counting toward the breaker, and later rows are sent", async () => {
    fake.respond({ status: 400 });
    await upsert("bad", 1);
    await upsert("good", 1);
    await drive(t, fake);

    expect(
      scorePosts()
        .map(scoreBody)
        .map((b) => b.id),
    ).toEqual(["bad", "good"]);
    const state = await tables(t);
    expect(state.deadLetters).toMatchObject([
      { kind: "scoreCreate", ref: "bad", reason: "rejected", status: 400 },
    ]);
    expect(state.outbox).toEqual([]);
    expect(state.exporter[0]!.consecutiveRejected).toBe(0);
    expect((await scoreKey("bad"))?.inFlight).toBeUndefined();
    expect(BREAKER_REJECTED_SPANS).toBeGreaterThan(1);
  });

  test("score and trace deletion endpoints that answer 404 defer their own rows by 30 minutes while 100 spans behind them are accepted", async () => {
    // A backoff would last the full computed delay.
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    fake.fallback = (request) =>
      request.spanIds.length > 0 ? { status: 200 } : { status: 404 };
    await upsert("s1", 1);
    await t.mutation(api.traces.remove, { traceIds: [TRACE.traceId] });
    await recordSpans(0, 50);
    await recordSpans(50, 50);
    const sentSpans = () => fake.requests.flatMap((r) => r.spanIds).length;
    await drive(t, fake, { until: () => sentSpans() === 100 });

    // Every request goes out in the same run, without a pause.
    expect(fake.requests.at(-1)!.at - fake.requests[0]!.at).toBeLessThan(100);
    const apiRequests = fake.requests.filter((r) => r.spanIds.length === 0);
    expect(apiRequests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/public/scores",
      "DELETE /api/public/traces",
    ]);
    const state = await tables(t);
    expect(state.outbox.map((row) => row.kind)).toEqual([
      "scoreCreate",
      "traceDelete",
    ]);
    for (const [i, row] of state.outbox.entries()) {
      // The fake clock moves 1 ms per transaction.
      expect(
        row.availableAt - apiRequests[i]!.at - DEFERRED_MS,
      ).toBeGreaterThanOrEqual(0);
      expect(row.availableAt - apiRequests[i]!.at - DEFERRED_MS).toBeLessThan(
        100,
      );
    }
    const { exporter } = await health();
    expect(exporter.lastError).toMatchObject({ class: "config", status: 404 });
    expect(exporter.backoffUntil).toBeUndefined();
    expect(exporter.consecutiveFailures).toBe(0);
    expect(exporter.accepted).toBe(100);
    expect((await scoreKey("s1"))?.queued).toBe(state.outbox[0]!._id);
  });

  test("a deferred op that ends a run leaves no backoff", async () => {
    fake.fallback = { status: 404 };
    await upsert("s1", 1);
    await drive(t, fake, { until: () => fake.requests.length === 1 });
    await drive(t, fake, {
      until: async () => !(await health()).exporter.running,
    });
    const { exporter } = await health();
    expect(exporter.lastError).toMatchObject({ class: "config", status: 404 });
    expect(exporter.backoffUntil).toBeUndefined();
    expect(exporter.consecutiveFailures).toBe(0);
  });
});

describe("trace deletion requests", () => {
  test("a request after spans of its trace is sent after them, as one DELETE with the ids", async () => {
    await recordSpans(0, 3);
    const other = "1af7651916cd43dd8448eb211c80319c";
    await t.mutation(api.traces.remove, { traceIds: [TRACE.traceId, other] });
    await drive(t, fake);

    expect(fake.requests.map((r) => r.spanIds.length)).toEqual([3, 0]);
    const deletion = fake.requests[1]!;
    expect(`${deletion.method} ${deletion.path}`).toBe(
      "DELETE /api/public/traces",
    );
    expect(JSON.parse(deletion.body)).toEqual({
      traceIds: [TRACE.traceId, other],
    });
    expect((await tables(t)).outbox).toEqual([]);
  });

  test("is admitted while the gate is closed and survives a retention sweep 80 hours later", async () => {
    fake.fallback = { status: 503 };
    await t.run(async (ctx) => {
      await ctx.db.insert("gate", { accepting: false, changedAt: Date.now() });
    });
    expect(
      await t.mutation(api.traces.remove, { traceIds: [TRACE.traceId] }),
    ).toEqual({ enqueued: true });
    expect(await upsert("s1", 1)).toEqual({
      enqueued: false,
      reason: "backlog",
    });

    // A failed send leaves the request waiting.
    await drive(t, fake, { until: () => fake.requests.length === 1 });
    vi.setSystemTime(Date.now() + 80 * 60 * 60 * 1_000);
    await t.mutation(internal.retention.sweep, {});
    const state = await tables(t);
    expect(state.outbox.map((row) => row.kind)).toEqual(["traceDelete"]);
    expect(state.exporter[0]!.expired).toBe(0);
  });

  test(`throws when ${MAX_PENDING_DELETES} requests are pending`, async () => {
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_PENDING_DELETES; i++) {
        const payloadId = await ctx.db.insert("payloads", { data: "{}" });
        await ctx.db.insert("outbox", {
          kind: "traceDelete",
          ref: TRACE.traceId,
          bytes: 2,
          availableAt: Date.now(),
          payloadId,
        });
      }
    });
    await expect(
      t.mutation(api.traces.remove, { traceIds: [TRACE.traceId] }),
    ).rejects.toThrow("too_many_pending_deletes");
  });

  test("returns disabled without writing on a disabled component", async () => {
    vi.stubEnv("LANGFUSE_BASE_URL", "");
    expect(
      await t.mutation(api.traces.remove, { traceIds: [TRACE.traceId] }),
    ).toEqual({ enqueued: false, reason: "disabled" });
    expect((await tables(t)).outbox).toEqual([]);
  });
});

/** A remote score config as the list endpoint returns it. */
type Remote = {
  id: string;
  name: string;
  dataType: string;
  isArchived: boolean;
  minValue?: number | null;
  maxValue?: number | null;
  categories?: { label: string; value: number }[] | null;
  createdAt: string;
};

const DEFINITIONS = [
  { name: "helpful", dataType: "BOOLEAN" as const },
  { name: "rating", dataType: "NUMERIC" as const, min: 1, max: 5 },
  {
    name: "tone",
    dataType: "CATEGORICAL" as const,
    categories: ["formal", "casual"],
  },
];

/**
 * Serves `remote` as the score config endpoints, newest first like
 * Langfuse, and appends created configs to it. `onPage` can replace the
 * answer of a page.
 */
function serveConfigs(
  remote: Remote[],
  onPage?: (page: number) => Promise<{ status: number } | undefined>,
) {
  let created = 0;
  fake.fallback = async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/public/score-configs") return { status: 200 };
    if (request.method === "POST") {
      const body = JSON.parse(request.body) as Omit<Remote, "id">;
      created += 1;
      const config: Remote = {
        ...body,
        id: `created-${created}`,
        isArchived: false,
        createdAt: new Date().toISOString(),
      };
      remote.push(config);
      return { status: 200, body: config };
    }
    const page = Number(url.searchParams.get("page"));
    const limit = Number(url.searchParams.get("limit"));
    const replaced = await onPage?.(page);
    if (replaced) return replaced;
    const sorted = [...remote].reverse();
    return {
      status: 200,
      body: {
        data: sorted.slice((page - 1) * limit, page * limit),
        meta: {
          page,
          limit,
          totalItems: sorted.length,
          totalPages: Math.ceil(sorted.length / limit),
        },
      },
    };
  };
}

const configPosts = () =>
  fake.requests.filter(
    (r) => r.method === "POST" && r.path === "/api/public/score-configs",
  );
const stored = () =>
  t.run(async (ctx) =>
    (await ctx.db.query("scoreConfigs").collect()).map(
      ({ name, configId }) => ({ name, configId }),
    ),
  );
const sync = (definitions = DEFINITIONS) =>
  t.action(api.scores.syncConfigs, { definitions });

describe("score config sync", () => {
  test("creates a config for every definition without one", async () => {
    serveConfigs([]);
    const result = await sync();

    expect(result).toEqual({
      status: "ok",
      configs: [
        { name: "helpful", configId: "created-1", created: true },
        { name: "rating", configId: "created-2", created: true },
        { name: "tone", configId: "created-3", created: true },
      ],
      conflicts: [],
    });
    expect(configPosts().map((r) => JSON.parse(r.body) as unknown)).toEqual([
      { name: "helpful", dataType: "BOOLEAN" },
      { name: "rating", dataType: "NUMERIC", minValue: 1, maxValue: 5 },
      {
        name: "tone",
        dataType: "CATEGORICAL",
        categories: [
          { label: "formal", value: 0 },
          { label: "casual", value: 1 },
        ],
      },
    ]);
    expect(await stored()).toEqual(
      result.configs.map(({ name, configId }) => ({ name, configId })),
    );
  });

  test("reuses the oldest compatible config of duplicates, reports conflicts and stores none of them", async () => {
    const at = (day: number) => `2026-01-0${day}T00:00:00.000Z`;
    serveConfigs([
      // Compatible duplicates of "rating"; the oldest wins.
      {
        id: "r-new",
        name: "rating",
        dataType: "NUMERIC",
        isArchived: false,
        minValue: 1,
        maxValue: 5,
        createdAt: at(3),
      },
      {
        id: "r-old",
        name: "rating",
        dataType: "NUMERIC",
        isArchived: false,
        minValue: 1,
        maxValue: 5,
        createdAt: at(1),
      },
      {
        id: "r-range",
        name: "rating",
        dataType: "NUMERIC",
        isArchived: false,
        minValue: 0,
        maxValue: 10,
        createdAt: at(1),
      },
      {
        id: "t-order",
        name: "tone",
        dataType: "CATEGORICAL",
        isArchived: false,
        categories: [
          { label: "casual", value: 0 },
          { label: "formal", value: 1 },
        ],
        createdAt: at(1),
      },
      {
        id: "h-archived",
        name: "helpful",
        dataType: "BOOLEAN",
        isArchived: true,
        categories: [
          { label: "True", value: 1 },
          { label: "False", value: 0 },
        ],
        createdAt: at(1),
      },
    ]);
    const result = await sync();

    expect(result.status).toBe("ok");
    expect(result.configs).toEqual([
      { name: "helpful", configId: "created-1", created: true },
      { name: "rating", configId: "r-old", created: false },
      { name: "tone", configId: "created-2", created: true },
    ]);
    expect(result.conflicts).toEqual([
      { name: "helpful", configId: "h-archived", reason: "archived" },
      { name: "rating", configId: "r-range", reason: "incompatible" },
      { name: "tone", configId: "t-order", reason: "incompatible" },
    ]);
    const ids = (await stored()).map((entry) => entry.configId);
    expect(ids).toEqual(["created-1", "r-old", "created-2"]);
  });

  test("a second call while a sync runs returns running", async () => {
    let second: unknown;
    serveConfigs([], async () => {
      second ??= await sync();
      return undefined;
    });
    expect((await sync()).status).toBe("ok");
    expect(second).toEqual({ status: "running", configs: [], conflicts: [] });
  });

  test("a failing page makes the run incomplete: nothing created, nothing stored", async () => {
    const remote: Remote[] = Array.from({ length: 150 }, (_, i) => ({
      id: `other-${i}`,
      name: `other-${i}`,
      dataType: "BOOLEAN",
      isArchived: false,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    }));
    let failing = false;
    serveConfigs(remote, async (page) =>
      failing && page === 2 ? { status: 500 } : undefined,
    );
    await sync();
    const before = await stored();
    const posts = configPosts().length;

    failing = true;
    expect(await sync()).toEqual({
      status: "incomplete",
      configs: [],
      conflicts: [],
    });
    expect(configPosts()).toHaveLength(posts);
    expect(await stored()).toEqual(before);
    // The run released its lease.
    failing = false;
    expect((await sync()).status).toBe("ok");
  });

  test("the result of a superseded sync is not stored", async () => {
    serveConfigs([], async () => {
      await t.run(async (ctx) => {
        const state = (await ctx.db.query("scoreConfigSync").first())!;
        await ctx.db.patch("scoreConfigSync", state._id, {
          generation: state.generation + 1,
        });
      });
      return undefined;
    });
    expect((await sync()).status).toBe("incomplete");
    expect(await stored()).toEqual([]);
  });

  test("a configId is attached while fresh, not after 3 hours, and not after a resync found it archived", async () => {
    const remote: Remote[] = [];
    serveConfigs(remote);
    await sync();
    const queuedBody = async (id: string) => {
      const state = await tables(t);
      const key = state.scoreKeys.find((k) => k.scoreId === id)!;
      const row = state.outbox.find((r) => r._id === key.queued)!;
      const payload = state.payloads.find((p) => p._id === row.payloadId)!;
      return JSON.parse(payload.data) as { configId?: string };
    };

    await upsert("fresh", 3, "rating");
    expect((await queuedBody("fresh")).configId).toBe("created-2");
    // Another data type than the synced config gets no id.
    await t.mutation(api.scores.upsert, {
      id: "other-type",
      timestamp: TIMESTAMP,
      name: "rating",
      value: "high",
      dataType: "CATEGORICAL",
      traceId: TRACE.traceId,
    });
    expect((await queuedBody("other-type")).configId).toBeUndefined();

    vi.setSystemTime(Date.now() + CONFIG_FRESH_MS + 1);
    await upsert("stale", 3, "rating");
    expect((await queuedBody("stale")).configId).toBeUndefined();

    remote.find((config) => config.id === "created-2")!.isArchived = true;
    const result = await sync();
    expect(result.conflicts).toContainEqual({
      name: "rating",
      configId: "created-2",
      reason: "archived",
    });
    await upsert("resynced", 3, "rating");
    expect((await queuedBody("resynced")).configId).toBe("created-4");
  });

  test("resyncTick writes and schedules nothing before the first sync, and schedules a sync after it", async () => {
    await t.mutation(internal.scores.resyncTick, {});
    expect(await pendingScheduled(t)).toEqual([]);
    expect(
      await t.run(async (ctx) => ctx.db.query("scoreConfigSync").collect()),
    ).toEqual([]);

    serveConfigs([]);
    await sync();
    await t.mutation(internal.scores.resyncTick, {});
    expect(await pendingScheduled(t)).toContain("scores:syncConfigs");
  });
});
