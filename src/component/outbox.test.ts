import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { PENDING_ROWS_THRESHOLD } from "./constants.js";
import {
  drive,
  enableExport,
  exporterDoc,
  installFakeLangfuse,
  insertRows,
  observations,
  pendingCounted,
  startRunByHand,
  tables,
  TRACE,
  type TestConvex,
} from "./fakeLangfuse.test-util.js";
import { initConvexTest } from "./setup.test.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  enableExport();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const count = (t: TestConvex) => t.mutation(internal.outbox.count, {});
const outboxSize = async (t: TestConvex) => (await tables(t)).outbox.length;

describe("admission gate", () => {
  test("closes from counted rows and reopens as they drain, with no transaction scanning the outbox", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fake = installFakeLangfuse();
    fake.fallback = { network: true };
    // A scan of the whole outbox would read 25,001 rows in one transaction.
    const t = initConvexTest({ transactionLimits: { documentsRead: 2_500 } });
    const record = (from: number, size: number) =>
      t.mutation(api.tracing.record, {
        trace: TRACE,
        observations: observations(from, size),
      });
    const rows = PENDING_ROWS_THRESHOLD + 1;
    for (let from = 0; from < rows; from += 50) {
      await record(from, Math.min(50, rows - from));
    }
    const health = () => t.query(api.outbox.health, {});

    const deadline = Date.now() + 3_600_000;
    await drive(t, fake, {
      until: async () => !(await health()).accepting || Date.now() > deadline,
    });
    expect((await health()).accepting).toBe(false);
    expect((await health()).pendingCounted.rows).toBe(rows);

    const newest = () =>
      t.run(
        async (ctx) =>
          (
            await ctx.db
              .query("outbox")
              .withIndex("by_seq")
              .order("desc")
              .first()
          )?._id,
      );
    const before = await newest();
    expect(await record(rows, 1)).toEqual({
      enqueued: 0,
      dropped: 1,
      reason: "backlog",
    });
    expect(await newest()).toBe(before);

    // One run drains the outbox without the fake clock moving, so the gate is
    // sampled as each request arrives.
    let reopenedAt: { rows: number } | undefined;
    fake.fallback = async () => {
      const state = await t.run(async (ctx) => ({
        gate: await ctx.db.query("gate").first(),
        exporter: await ctx.db.query("exporter").first(),
      }));
      if (state.gate?.accepting) {
        reopenedAt ??= { rows: state.exporter!.pendingRows };
      }
      return { status: 200 };
    };
    await t.mutation(internal.exporter.kick, {});
    await drive(t, fake, {
      until: async () =>
        (await newest()) === undefined || Date.now() > deadline,
    });
    // Reopened by the deletions themselves, long before the outbox is empty.
    expect(reopenedAt?.rows).toBeLessThan(PENDING_ROWS_THRESHOLD / 2);
    expect(reopenedAt?.rows).toBeGreaterThan(
      PENDING_ROWS_THRESHOLD / 2 - 1_000,
    );
  }, 120_000);
});

describe("counting", () => {
  test("counts exactly the rows that still exist, around exports and new rows", async () => {
    const t = initConvexTest();
    await insertRows(
      t,
      Array.from({ length: 300 }, () => ({ data: "x" })),
    );
    await startRunByHand(t);
    const accepted = { outcome: "accepted" as const, status: 200 };
    await t.mutation(internal.exporter.advance, { generation: 1 });
    await t.mutation(internal.exporter.advance, {
      generation: 1,
      report: accepted,
    });
    // 100 rows are exported before the first count step.
    await t.mutation(internal.exporter.advance, {
      generation: 1,
      report: accepted,
    });
    await count(t);
    expect(await pendingCounted(t)).toEqual({ rows: 200, bytes: 200 });
    expect(await outboxSize(t)).toBe(200);

    // A count step between two export batches, with uncounted rows added.
    await insertRows(
      t,
      Array.from({ length: 30 }, () => ({ data: "yy" })),
    );
    await t.mutation(internal.exporter.advance, {
      generation: 1,
      report: accepted,
    });
    expect(await pendingCounted(t)).toEqual({ rows: 150, bytes: 150 });
    await count(t);
    expect(await pendingCounted(t)).toEqual({ rows: 180, bytes: 210 });
    expect(await outboxSize(t)).toBe(180);

    for (;;) {
      const step = await t.mutation(internal.exporter.advance, {
        generation: 1,
        report: accepted,
      });
      if (step.done) break;
    }
    expect(await outboxSize(t)).toBe(0);
    expect(await pendingCounted(t)).toEqual({ rows: 0, bytes: 0 });
  });

  test("a commit larger than a batch is counted in steps of at most 1,000 rows", async () => {
    // Rows of one transaction share a seq. Reading that whole commit in one
    // step would exceed the read limit.
    const t = initConvexTest({ transactionLimits: { documentsRead: 1_100 } });
    await insertRows(
      t,
      Array.from({ length: 1_500 }, () => ({ data: "x" })),
    );
    await count(t);
    expect(await pendingCounted(t)).toEqual({ rows: 1_000, bytes: 1_000 });
    await count(t);
    await count(t);
    expect(await pendingCounted(t)).toEqual({ rows: 1_500, bytes: 1_500 });
  });

  test("a step that stops inside a commit subtracts only the rows it counted", async () => {
    const t = initConvexTest();
    const now = Date.now();
    // One commit of 1,200 rows. The last 200 are available earlier, so the
    // exporter claims them first, while a count step reaches them last.
    await t.run(async (ctx) => {
      for (let i = 0; i < 1_200; i++) {
        const payloadId = await ctx.db.insert("payloads", { data: "x" });
        await ctx.db.insert("outbox", {
          kind: "span",
          ref: `r${i}`,
          bytes: 1,
          availableAt: i < 1_000 ? now : now - 1_000,
          payloadId,
          seq: ctx.db.vars.commitTs,
        });
      }
    });
    await count(t);
    expect(await pendingCounted(t)).toEqual({ rows: 1_000, bytes: 1_000 });

    await startRunByHand(t);
    const accepted = { outcome: "accepted" as const, status: 200 };
    await t.mutation(internal.exporter.advance, { generation: 1 });
    // 50 uncounted rows of the same commit are exported.
    await t.mutation(internal.exporter.advance, {
      generation: 1,
      report: accepted,
    });
    expect(await outboxSize(t)).toBe(1_150);
    expect(await pendingCounted(t)).toEqual({ rows: 1_000, bytes: 1_000 });

    // The rest of the commit is counted; the 50 rows in flight still exist.
    await count(t);
    await count(t);
    expect(await pendingCounted(t)).toEqual({ rows: 1_150, bytes: 1_150 });
    await t.mutation(internal.exporter.advance, {
      generation: 1,
      report: accepted,
    });
    expect(await outboxSize(t)).toBe(1_100);
    expect(await pendingCounted(t)).toEqual({ rows: 1_100, bytes: 1_100 });
  });

  test("retryDeadLetters moves at most 500 dead letters per call", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => {
      for (let i = 0; i < 520; i++) {
        const payloadId = await ctx.db.insert("payloads", { data: "x" });
        await ctx.db.insert("deadLetters", {
          kind: "span",
          ref: `r${i}`,
          bytes: 1,
          payloadId,
          reason: "rejected",
          failedAt: i,
        });
      }
    });
    expect(
      await t.mutation(internal.outbox.retryDeadLetters, { limit: 10_000 }),
    ).toEqual({ moved: 500 });
    expect((await tables(t)).deadLetters).toHaveLength(20);
  });

  test("a row committed after the step's snapshot is counted once, by a later step", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => {
      const payloadId = await ctx.db.insert("payloads", { data: "x" });
      await ctx.db.insert("outbox", {
        kind: "span",
        ref: "r",
        bytes: 1,
        availableAt: Date.now(),
        payloadId,
        seq: ctx.db.vars.commitTs,
      });
      // This row commits after the snapshot the nested step reads.
      await ctx.runMutation(internal.outbox.count, {});
    });
    await count(t);
    await count(t);
    expect(await pendingCounted(t)).toEqual({ rows: 1, bytes: 1 });
  });

  test("a dead letter moved back gets a new seq and is counted once", async () => {
    const t = initConvexTest();
    await insertRows(t, [{ data: "x" }]);
    await count(t);
    await startRunByHand(t);
    await t.mutation(internal.exporter.advance, { generation: 1 });
    await t.mutation(internal.exporter.advance, {
      generation: 1,
      report: { outcome: "rejected", status: 400 },
    });
    expect(await pendingCounted(t)).toEqual({ rows: 0, bytes: 0 });
    const countedThrough = (await tables(t)).exporter[0]!.countedThrough!;

    expect(await t.mutation(internal.outbox.retryDeadLetters, {})).toEqual({
      moved: 1,
    });
    const [moved] = (await tables(t)).outbox;
    expect(moved!.seq).toBeGreaterThan(countedThrough);
    await count(t);
    await count(t);
    expect(await pendingCounted(t)).toEqual({ rows: 1, bytes: 1 });
  });

  test("stale counters over an empty outbox return to zero and open the gate", async () => {
    for (const run of ["sweep", "advance"] as const) {
      const t = initConvexTest();
      await t.run(async (ctx) => {
        await ctx.db.insert(
          "exporter",
          exporterDoc({
            generation: 1,
            leaseExpiresAt: Date.now() + 120_000,
            runStartedAt: Date.now(),
            pendingRows: 30_000,
            pendingBytes: 5_000,
          }),
        );
        await ctx.db.insert("gate", { accepting: false, changedAt: 0 });
      });
      if (run === "sweep") {
        await t.mutation(internal.retention.sweep, {});
      } else {
        await t.mutation(internal.exporter.advance, { generation: 1 });
      }
      const health = await t.query(api.outbox.health, {});
      expect(health.pendingCounted).toEqual({ rows: 0, bytes: 0 });
      expect(health.accepting).toBe(true);
    }
  });
});

describe("health", () => {
  test("reports pending rows, dead letters, the gate and an active backoff", async () => {
    const t = initConvexTest();
    await insertRows(t, [{ data: "a" }, { data: "b" }, { data: "c" }]);
    await count(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      const payloadId = await ctx.db.insert("payloads", { data: "d" });
      await ctx.db.insert("deadLetters", {
        kind: "span",
        ref: "r",
        bytes: 1,
        payloadId,
        reason: "rejected",
        status: 422,
        failedAt: now,
      });
      const exporter = (await ctx.db.query("exporter").first())!;
      await ctx.db.patch("exporter", exporter._id, {
        generation: 4,
        backoffUntil: now + 30_000,
        consecutiveFailures: 2,
        consecutiveRejected: 1,
        lastAcceptedAt: now - 60_000,
        lastError: { at: now - 1_000, class: "transient", status: 503 },
        accepted: 7,
        deadLettered: 1,
      });
    });

    const oldest = (await tables(t)).outbox[0]!._creationTime;
    expect(await t.query(api.outbox.health, {})).toEqual({
      enabled: true,
      accepting: true,
      pendingAtLeast: 3,
      pendingCounted: { rows: 3, bytes: 3 },
      oldestPendingAt: oldest,
      deadLettersAtLeast: 1,
      exporter: {
        running: false,
        backoffUntil: now + 30_000,
        consecutiveFailures: 2,
        lastAcceptedAt: now - 60_000,
        lastError: { at: now - 1_000, class: "transient", status: 503 },
        accepted: 7,
        deadLettered: 1,
        expired: 0,
      },
    });
  });
});
