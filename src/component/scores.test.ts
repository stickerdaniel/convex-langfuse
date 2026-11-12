import type { FunctionArgs } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
  BREAKER_REJECTED_SPANS,
  CONFIG_FRESH_MS,
  CONFIG_SYNC_DEADLINE_MS,
  DEFERRED_MS,
  LEASE_MS,
  MAX_PENDING_AGE_MS,
  MAX_PENDING_DELETES,
  MAX_ROW_BYTES,
  PENDING_BYTES_THRESHOLD,
  SCORE_SETTLE_MS,
} from "./constants.js";
import {
  consumeReceipts,
  drive,
  enableExport,
  insertRows,
  installFakeLangfuse,
  observations,
  pendingCounted,
  pendingScheduled,
  refusalCode,
  runScheduledNow,
  serveConfigs,
  spanId,
  startRunByHand,
  tables,
  totals,
  TRACE,
  type FakeLangfuse,
  type RecordedRequest,
  type RemoteConfig,
  type TestConvex,
} from "./fakeLangfuse.test-util.js";
import { initConvexTest } from "./setup.test.js";
import { byteLength } from "../shared/otlp.js";
import { definitionFingerprint, scoreBytes } from "../shared/scores.js";

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

/** The arguments of a numeric score, changed by `extra`. */
function scoreArgs(
  id: string,
  value: number,
  extra: { name?: string; comment?: string; fingerprint?: string } = {},
) {
  return {
    id,
    timestamp: TIMESTAMP,
    name: "quality",
    value,
    dataType: "NUMERIC" as const,
    traceId: TRACE.traceId,
    ...extra,
  };
}

async function upsert(...args: Parameters<typeof scoreArgs>) {
  return await t.mutation(api.scores.upsert, scoreArgs(...args));
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
    // The deletion request comes first: a score write enqueued before it
    // would hold it back.
    await t.mutation(api.traces.remove, { traceIds: [TRACE.traceId] });
    await upsert("s1", 1);
    await recordSpans(0, 50);
    await recordSpans(50, 50);
    const sentSpans = () => fake.requests.flatMap((r) => r.spanIds).length;
    await drive(t, fake, { until: () => sentSpans() === 100 });

    // Every request goes out in the same run, without a pause.
    expect(fake.requests.at(-1)!.at - fake.requests[0]!.at).toBeLessThan(100);
    const apiRequests = fake.requests.filter((r) => r.spanIds.length === 0);
    expect(apiRequests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "DELETE /api/public/traces",
      "POST /api/public/scores",
    ]);
    const state = await tables(t);
    expect(state.outbox.map((row) => row.kind)).toEqual([
      "traceDelete",
      "scoreCreate",
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
    expect((await scoreKey("s1"))?.queued).toBe(state.outbox[1]!._id);
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

  test("a bad default environment refuses a score without its own, and a valid explicit one is accepted", async () => {
    vi.stubEnv("LANGFUSE_TRACING_ENVIRONMENT", "Production");
    expect(await refusalCode(upsert("s1", 1))).toBe("invalid_environment");
    expect((await tables(t)).outbox).toEqual([]);
    expect(
      await t.mutation(api.scores.upsert, {
        ...scoreArgs("s2", 1),
        environment: "staging",
      }),
    ).toEqual({ enqueued: true });
  });
});

describe("score backlog", () => {
  test("score upserts with distinct ids close the gate past the byte threshold while Langfuse fails, and the next upsert returns backlog", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    fake.fallback = { network: true };
    // convex-test reads a whole table for every index query, so the 25,001
    // upserts of the row threshold take minutes; 292 scores of the largest
    // size cross the byte threshold.
    const id = (i: number) => `s${String(i).padStart(3, "0")}`;
    const base = scoreBytes(scoreArgs(id(0), 1, { comment: "" }));
    const comment = "x".repeat(MAX_ROW_BYTES - base);
    const rows = Math.ceil(PENDING_BYTES_THRESHOLD / MAX_ROW_BYTES);
    for (let i = 0; i < rows; i++) await upsert(id(i), 1, { comment });
    const deadline = Date.now() + 3_600_000;
    await drive(t, fake, {
      until: async () => !(await health()).accepting || Date.now() > deadline,
    });

    const { accepting, pendingCounted } = await health();
    expect(accepting).toBe(false);
    expect(pendingCounted.rows).toBe(rows);
    expect(pendingCounted.bytes).toBeGreaterThan(PENDING_BYTES_THRESHOLD);
    expect(await upsert("next", 1)).toEqual({
      enqueued: false,
      reason: "backlog",
    });
  }, 60_000);

  test("a waiting score replaced twice counts as one row with the bytes of its last body", async () => {
    await upsert("s1", 1, { comment: "the first body is the longest one" });
    await upsert("s1", 2, { comment: "a shorter one" });
    await upsert("s1", 3);
    await consumeReceipts(t);
    const { outbox, payloads } = await tables(t);
    expect(outbox).toHaveLength(1);
    expect(await pendingCounted(t)).toEqual({
      rows: 1,
      bytes: byteLength(payloads[0]!.data),
    });
  });

  test("accepting a score op while the gate is closed reopens it before the run ends", async () => {
    await upsert("s1", 1);
    await insertRows(t, [{ data: "x" }]);
    // Both rows are counted, and the gate is closed.
    await t.run(async (ctx) => {
      for (const receipt of await ctx.db.query("receipts").collect()) {
        await ctx.db.delete("receipts", receipt._id);
      }
      await ctx.db.insert("counter", { addedRows: 2, addedBytes: 2, chain: 0 });
      await ctx.db.insert("gate", { accepting: false, changedAt: 0 });
    });
    await startRunByHand(t);
    expect(
      await t.mutation(internal.exporter.advance, { generation: 1 }),
    ).toMatchObject({ done: false, op: { kind: "scoreCreate" } });
    // The span behind the score keeps the run going.
    expect(
      await t.mutation(internal.exporter.advance, {
        generation: 1,
        report: { outcome: "accepted", status: 200 },
      }),
    ).toEqual({ done: false, spans: ["x"] });
    await runScheduledNow(t);
    expect((await health()).accepting).toBe(true);
  });

  test("a run that dies with a score op in flight and a successor queued leaves equal totals once the successor is accepted", async () => {
    await upsert("s1", 1);
    await startRunByHand(t);
    await t.mutation(internal.exporter.advance, { generation: 1 });
    await upsert("s1", 2, { comment: "the successor" });
    // Both receipts are counted, and the gate reconciled, while the
    // successor waits, so no drift reset applies afterwards.
    await consumeReceipts(t);
    await runScheduledNow(t);
    vi.setSystemTime(Date.now() + LEASE_MS + 1);
    await t.mutation(internal.exporter.dispatch, { op: "start" });
    await drive(t, fake);

    expect(scorePosts().map((r) => scoreBody(r).value)).toEqual([2]);
    await consumeReceipts(t);
    const { added, removed } = await totals(t);
    expect(added.rows).toBe(2);
    expect(removed).toEqual(added);
  });

  test.each([
    ["transient", 503],
    ["deferred", 404],
  ])(
    "a %s failure of a score op with a waiting successor leaves equal totals once the successor is accepted",
    async (_, status) => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      fake.respond(async () => {
        await upsert("s1", 2, { comment: "the successor" });
        return { status };
      });
      await upsert("s1", 1);
      await drive(t, fake);

      expect(scorePosts().map((r) => scoreBody(r).value)).toEqual([1, 2]);
      await consumeReceipts(t);
      const { added, removed } = await totals(t);
      expect(added.rows).toBe(2);
      expect(removed).toEqual(added);
    },
  );

  test("a rejected score and an expired score each add one row and their bytes to the removed totals", async () => {
    await upsert("rejected", 1);
    await startRunByHand(t);
    await t.mutation(internal.exporter.advance, { generation: 1 });
    await t.mutation(internal.exporter.advance, {
      generation: 1,
      report: { outcome: "rejected", status: 400 },
    });
    const [deadLetter] = (await tables(t)).deadLetters;
    expect((await totals(t)).removed).toEqual({
      rows: 1,
      bytes: deadLetter!.bytes,
    });

    await upsert("expired", 1, { comment: "left to expire" });
    const [row] = (await tables(t)).outbox;
    vi.setSystemTime(Date.now() + MAX_PENDING_AGE_MS + 1_000);
    // A fresh row keeps the outbox non-empty, so no drift reset applies.
    await insertRows(t, [{ data: "x" }]);
    await t.mutation(internal.retention.sweep, {});
    expect((await tables(t)).exporter[0]).toMatchObject({ expired: 1 });
    expect((await totals(t)).removed).toEqual({
      rows: 2,
      bytes: deadLetter!.bytes + row!.bytes,
    });
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

  test.each([
    [0, 1_000, "too_many_pending_deletes"],
    [600, 400, "too_many_pending_deletes"],
    [600, 399, "admitted"],
  ])(
    "with %i requests in the outbox and %i rejected ones the next request is %s",
    async (queued, rejected, outcome) => {
      await t.run(async (ctx) => {
        for (let i = 0; i < queued + rejected; i++) {
          const row = {
            kind: "traceDelete" as const,
            ref: TRACE.traceId,
            bytes: 2,
            payloadId: await ctx.db.insert("payloads", { data: "{}" }),
          };
          if (i < queued) {
            await ctx.db.insert("outbox", { ...row, availableAt: Date.now() });
          } else {
            await ctx.db.insert("deadLetters", {
              ...row,
              reason: "rejected",
              status: 400,
              failedAt: Date.now(),
            });
          }
        }
      });
      const remove = t.mutation(api.traces.remove, {
        traceIds: [TRACE.traceId],
      });
      if (outcome === "admitted") {
        expect(await remove).toEqual({ enqueued: true });
      } else {
        expect(await refusalCode(remove)).toBe(outcome);
      }
    },
  );

  const isTraceDelete = (r: RecordedRequest) =>
    r.method === "DELETE" && r.path === "/api/public/traces";
  const requestLog = () =>
    fake.requests.map((r) =>
      isScorePost(r)
        ? `score ${scoreBody(r).value}`
        : isTraceDelete(r)
          ? "trace delete"
          : `spans ${r.spanIds.length}`,
    );

  /** Runs the exporter until the first score is accepted, and no longer. */
  const acceptFirst = () =>
    drive(t, fake, { until: () => scorePosts().length === 1 });

  test("a score written again before its trace is deleted is sent before the deletion request", async () => {
    await upsert("s1", 1);
    await acceptFirst();
    // The second write waits SCORE_SETTLE_MS after the first was accepted.
    await upsert("s1", 2);
    await t.mutation(api.traces.remove, { traceIds: [TRACE.traceId] });
    await drive(t, fake);

    expect(requestLog()).toEqual(["score 1", "score 2", "trace delete"]);
    expect((await tables(t)).outbox).toEqual([]);
  });

  test("a score written after the deletion request does not delay it", async () => {
    await upsert("s1", 1);
    await acceptFirst();
    const requestedAt = Date.now();
    await t.mutation(api.traces.remove, { traceIds: [TRACE.traceId] });
    await upsert("s1", 2);
    await drive(t, fake);

    expect(requestLog()).toEqual(["score 1", "trace delete", "score 2"]);
    expect(fake.requests[1]!.at - requestedAt).toBeLessThan(SCORE_SETTLE_MS);
  });

  test("the claim that holds back a deletion request goes on with the spans behind it", async () => {
    await upsert("s1", 1);
    await acceptFirst();
    await upsert("s1", 2);
    await t.mutation(api.traces.remove, { traceIds: [TRACE.traceId] });
    await recordSpans(0, 3);
    await startRunByHand(t);

    const step = await t.mutation(internal.exporter.advance, { generation: 1 });
    expect(step).toMatchObject({ done: false, spans: { length: 3 } });
    // The request now waits just behind the score write enqueued before it.
    const { outbox } = await tables(t);
    const score = outbox.find((row) => row.kind === "scoreCreate")!;
    const deletion = outbox.find((row) => row.kind === "traceDelete")!;
    expect(deletion.availableAt).toBe(score.availableAt + 1);
  });

  test("returns disabled without writing on a disabled component", async () => {
    vi.stubEnv("LANGFUSE_BASE_URL", "");
    expect(
      await t.mutation(api.traces.remove, { traceIds: [TRACE.traceId] }),
    ).toEqual({ enqueued: false, reason: "disabled" });
    expect((await tables(t)).outbox).toEqual([]);
  });
});

const DEFINITIONS = [
  { name: "helpful", dataType: "BOOLEAN" as const },
  { name: "rating", dataType: "NUMERIC" as const, min: 1, max: 5 },
  {
    name: "tone",
    dataType: "CATEGORICAL" as const,
    categories: ["formal", "casual"],
  },
];

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
type Definitions = FunctionArgs<typeof api.scores.syncConfigs>["definitions"];
const sync = (definitions: Definitions = DEFINITIONS) =>
  t.action(api.scores.syncConfigs, { definitions });

describe("score config sync", () => {
  test("creates a config for every definition without one", async () => {
    serveConfigs(fake, []);
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
    serveConfigs(fake, [
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
    serveConfigs(fake, [], async () => {
      second ??= await sync();
      return undefined;
    });
    expect((await sync()).status).toBe("ok");
    expect(second).toEqual({ status: "running", configs: [], conflicts: [] });
  });

  test("a failing page makes the run incomplete: nothing created, nothing stored", async () => {
    const remote: RemoteConfig[] = Array.from({ length: 150 }, (_, i) => ({
      id: `other-${i}`,
      name: `other-${i}`,
      dataType: "BOOLEAN",
      isArchived: false,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    }));
    let failing = false;
    serveConfigs(fake, remote, async (page) =>
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
    serveConfigs(fake, [], async () => {
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
    const remote: RemoteConfig[] = [];
    serveConfigs(fake, remote);
    await sync();
    const queuedBody = async (id: string) => {
      const state = await tables(t);
      const key = state.scoreKeys.find((k) => k.scoreId === id)!;
      const row = state.outbox.find((r) => r._id === key.queued)!;
      const payload = state.payloads.find((p) => p._id === row.payloadId)!;
      return JSON.parse(payload.data) as { configId?: string };
    };

    const rating = {
      name: "rating",
      fingerprint: await definitionFingerprint(DEFINITIONS[1]!),
    };
    await upsert("fresh", 3, rating);
    expect((await queuedBody("fresh")).configId).toBe("created-2");
    // Another data type than the synced config gets no id.
    await t.mutation(api.scores.upsert, {
      ...scoreArgs("other-type", 0, rating),
      value: "high",
      dataType: "CATEGORICAL",
    });
    expect((await queuedBody("other-type")).configId).toBeUndefined();
    // Neither does a score without a fingerprint.
    await upsert("unchecked", 3, { name: "rating" });
    expect((await queuedBody("unchecked")).configId).toBeUndefined();

    vi.setSystemTime(Date.now() + CONFIG_FRESH_MS + 1);
    await upsert("stale", 3, rating);
    expect((await queuedBody("stale")).configId).toBeUndefined();

    remote.find((config) => config.id === "created-2")!.isArchived = true;
    const result = await sync();
    expect(result.conflicts).toContainEqual({
      name: "rating",
      configId: "created-2",
      reason: "archived",
    });
    await upsert("resynced", 3, rating);
    expect((await queuedBody("resynced")).configId).toBe("created-4");
  });

  test("resyncTick writes and schedules nothing before the first sync, and schedules a resync after it", async () => {
    await t.mutation(internal.scores.resyncTick, {});
    expect(await pendingScheduled(t)).toEqual([]);
    expect(
      await t.run(async (ctx) => ctx.db.query("scoreConfigSync").collect()),
    ).toEqual([]);

    serveConfigs(fake, []);
    await sync();
    await t.mutation(internal.scores.resyncTick, {});
    expect(await pendingScheduled(t)).toContain("scores:resync");
  });

  test("a resync scheduled before a newer sync completed keeps the definitions and configs of the newer sync", async () => {
    serveConfigs(fake, []);
    await sync();
    await t.mutation(internal.scores.resyncTick, {});
    const newer = [{ name: "accuracy", dataType: "BOOLEAN" as const }];
    const result = await sync(newer);
    await runScheduledNow(t);

    const state = await t.run(
      async (ctx) => await ctx.db.query("scoreConfigSync").first(),
    );
    expect(JSON.parse(state!.definitions)).toEqual(newer);
    expect(state!.generation).toBe(3);
    expect(await stored()).toEqual(
      result.configs.map(({ name, configId }) => ({ name, configId })),
    );
  });

  test("a sync whose creations reach the deadline creates no more, stores what it has and returns incomplete", async () => {
    serveConfigs(fake, []);
    const served = fake.fallback;
    fake.fallback = async (request) => {
      // The listing takes 200 s and each creation 9 s, below the timeout.
      vi.setSystemTime(
        Date.now() + (request.method === "GET" ? 200_000 : 9_000),
      );
      return typeof served === "function" ? await served(request) : served;
    };
    const definitions = Array.from({ length: 8 }, (_, i) => ({
      name: `slow-${i}`,
      dataType: "BOOLEAN" as const,
    }));
    const startedAt = Date.now();
    const result = await sync(definitions);

    // Creations start at 200, 209, 218, 227 and 236 s; the next would
    // start at 245 s, past the deadline of 240 s.
    expect(result.status).toBe("incomplete");
    expect(configPosts().map((r) => r.at - startedAt)).toEqual(
      [200, 209, 218, 227, 236].map((s) => expect.closeTo(s * 1_000, -2)),
    );
    expect(
      configPosts().every((r) => r.at - startedAt <= CONFIG_SYNC_DEADLINE_MS),
    ).toBe(true);
    expect((await stored()).map(({ name }) => name)).toEqual(
      definitions.slice(0, 5).map(({ name }) => name),
    );
  });

  test.each([
    ["a name of 81 characters", { name: "a".repeat(81) }],
    ["an empty name", { name: "" }],
    ["a name with a character Langfuse refuses", { name: "rating!" }],
    [
      "an empty category label",
      { dataType: "CATEGORICAL" as const, categories: ["ok", ""] },
    ],
    ["a minimum that is not a number", { min: NaN }],
    ["an infinite maximum", { max: Infinity }],
  ])("refuses a definition with %s", async (_, change) => {
    serveConfigs(fake, []);
    const definition = { name: "rating", dataType: "NUMERIC" as const };
    expect(await refusalCode(sync([{ ...definition, ...change }]))).toBe(
      "invalid_score_definitions",
    );
    expect(configPosts()).toEqual([]);
  });

  test("accepts a name with letters outside ASCII, digits, spaces and punctuation Langfuse allows", async () => {
    serveConfigs(fake, []);
    const name = "Qualität (ñ) 2.0_über-π";
    expect((await sync([{ name, dataType: "BOOLEAN" }])).status).toBe("ok");
    expect((await stored()).map((entry) => entry.name)).toEqual([name]);
  });
});
