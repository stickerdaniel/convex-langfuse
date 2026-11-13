import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { COUNT_BATCH, PENDING_ROWS_THRESHOLD } from "./constants.js";
import {
  consumeReceipts,
  countStep,
  drive,
  enableExport,
  exporterDoc,
  installFakeLangfuse,
  insertRows,
  observations,
  oneByteRows,
  pendingCounted,
  pendingScheduled,
  runScheduledNow,
  startRunByHand,
  startScheduledNow,
  tables,
  totals,
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

const outboxSize = async (t: TestConvex) => (await tables(t)).outbox.length;
const accepted = { outcome: "accepted" as const, status: 200 };

/** Runs `advance` of generation 1 until the run ends. */
async function drain(t: TestConvex) {
  await t.mutation(internal.exporter.advance, { generation: 1 });
  for (;;) {
    const step = await t.mutation(internal.exporter.advance, {
      generation: 1,
      report: accepted,
    });
    if (step.done) return;
  }
}

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
              .withIndex("by_creation_time")
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

    // One run drains the outbox, and the gate is sampled as each request
    // arrives.
    let reopenedAt: { rows: number } | undefined;
    fake.fallback = async () => {
      // On a real backend the gate reconciliation that a batch schedules runs
      // while the next request is in flight.
      await startScheduledNow();
      const { accepting, pendingCounted } = await health();
      if (accepting) reopenedAt ??= { rows: pendingCounted.rows };
      return { status: 200 };
    };
    await t.mutation(internal.exporter.kick, {});
    await drive(t, fake, {
      until: async () =>
        (await health()).pendingAtLeast === 0 || Date.now() > deadline,
    });
    // Reopened while the deletions run, long before the outbox is empty.
    expect(reopenedAt?.rows).toBeLessThan(PENDING_ROWS_THRESHOLD / 2);
    expect(reopenedAt?.rows).toBeGreaterThan(
      PENDING_ROWS_THRESHOLD / 2 - 1_000,
    );
  }, 120_000);

  /**
   * Totals of `added` counted and `removed` removed rows, with 50 counted
   * rows and 60 rows whose receipt is not consumed in the outbox, and a run
   * of generation 1. A counted row that is not available yet keeps the
   * outbox from becoming empty.
   */
  async function nearThreshold(
    t: TestConvex,
    totals: { added: number; removed: number; accepting: boolean },
  ) {
    await insertRows(t, oneByteRows(1), { availableAt: Date.now() + 60_000 });
    await insertRows(t, oneByteRows(50));
    await t.run(async (ctx) => {
      for (const receipt of await ctx.db.query("receipts").collect()) {
        await ctx.db.delete("receipts", receipt._id);
      }
      await ctx.db.insert("counter", {
        addedRows: totals.added,
        addedBytes: totals.added,
        chain: 0,
      });
      await ctx.db.insert(
        "exporter",
        exporterDoc({
          generation: 1,
          leaseExpiresAt: Date.now() + 120_000,
          runStartedAt: Date.now(),
          removedRows: totals.removed,
          removedBytes: totals.removed,
        }),
      );
      if (!totals.accepting) {
        await ctx.db.insert("gate", { accepting: false, changedAt: 0 });
      }
    });
    await insertRows(t, oneByteRows(60));
  }
  const advance = (t: TestConvex, report?: typeof accepted) =>
    t.mutation(internal.exporter.advance, { generation: 1, report });

  test("a count step next to a deletion leaves an open gate open below the threshold", async () => {
    const t = initConvexTest();
    await nearThreshold(t, { added: 30_000, removed: 5_050, accepting: true });
    // The count step starts from 5,050 removed rows and adds 60. The deletion
    // starts from 30,000 added rows and removes 50. Neither view alone is
    // the backlog: 30,060 - 5,100 = 24,960.
    await advance(t);
    await countStep(t);
    await advance(t, accepted);
    await runScheduledNow(t);
    const health = await t.query(api.outbox.health, {});
    expect(health.pendingCounted.rows).toBe(24_960);
    expect(health.accepting).toBe(true);
  });

  test("a count step next to a deletion keeps a closed gate closed above half the threshold", async () => {
    const t = initConvexTest();
    await nearThreshold(t, {
      added: 30_000,
      removed: 17_460,
      accepting: false,
    });
    const health = () => t.query(api.outbox.health, {});
    // 30,000 - 17,510 would be below 12,500. With the 60 counted rows the
    // backlog is 12,550.
    await advance(t);
    await countStep(t);
    await advance(t, accepted);
    await runScheduledNow(t);
    expect((await health()).pendingCounted.rows).toBe(12_550);
    expect((await health()).accepting).toBe(false);

    // 60 more accepted rows bring it to 12,490.
    await advance(t, accepted);
    await advance(t, accepted);
    await runScheduledNow(t);
    expect((await health()).pendingCounted.rows).toBe(12_490);
    expect((await health()).accepting).toBe(true);
  });
});

describe("counting", () => {
  test("counts exactly the rows that still exist, around exports and new rows", async () => {
    const t = initConvexTest();
    await insertRows(t, oneByteRows(300));
    await startRunByHand(t);
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
    await countStep(t);
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
    await countStep(t);
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

  test("rows exported before their receipt is consumed count as zero, before and after the step", async () => {
    const t = initConvexTest();
    await insertRows(t, oneByteRows(10));
    await startRunByHand(t);
    await drain(t);
    expect(await outboxSize(t)).toBe(0);
    expect(await pendingCounted(t)).toEqual({ rows: 0, bytes: 0 });
    await countStep(t);
    expect(await pendingCounted(t)).toEqual({ rows: 0, bytes: 0 });
    expect((await t.query(api.outbox.health, {})).accepting).toBe(true);
  });

  test("more receipts than a batch in one commit are consumed in steps of at most 1,000", async () => {
    // A step reads each receipt twice, to scan and to delete it. A step that
    // read the whole commit would exceed the read limit.
    const t = initConvexTest({ transactionLimits: { documentsRead: 2_100 } });
    const rows = COUNT_BATCH + 500;
    await insertRows(t, oneByteRows(rows), { receiptPerRow: true });
    await countStep(t);
    expect(await pendingCounted(t)).toEqual({ rows: 1_000, bytes: 1_000 });
    await countStep(t);
    await countStep(t);
    expect(await pendingCounted(t)).toEqual({ rows, bytes: rows });
    expect(
      await t.run(async (ctx) => await ctx.db.query("receipts").first()),
    ).toBeNull();
  });

  test("a step of a chain that is not the current one changes nothing and schedules nothing", async () => {
    const t = initConvexTest();
    await insertRows(t, oneByteRows(3));
    await t.run(async (ctx) => {
      await ctx.db.insert("counter", { addedRows: 0, addedBytes: 0, chain: 2 });
    });
    const before = await tables(t);
    await t.mutation(internal.outbox.count, { chain: 1 });
    expect(await tables(t)).toEqual(before);
    expect(await pendingScheduled(t)).toEqual([]);
  });

  test("while a chain is alive, dispatch starts no second one and no receipt is counted twice", async () => {
    const t = initConvexTest();
    const rows = 2 * COUNT_BATCH + 500;
    await insertRows(t, oneByteRows(rows), { receiptPerRow: true });
    const counts = async () =>
      (await pendingScheduled(t)).filter((name) => name.includes("count"));
    for (let i = 0; i < 5; i++) {
      // The loop calls dispatch every 2 s while a run holds the lease.
      await t.mutation(internal.exporter.dispatch, { op: "wait" });
      expect((await counts()).length).toBeLessThanOrEqual(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await t.finishInProgressScheduledFunctions();
    }
    expect(await counts()).toEqual([]);
    expect(await pendingCounted(t)).toEqual({ rows, bytes: rows });
    const state = await tables(t);
    expect(state.receipts).toEqual([]);
    expect(state.counter.map((counter) => counter.chain)).toEqual([1]);
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
    const state = await tables(t);
    expect(state.deadLetters).toHaveLength(20);
    expect(state.receipts).toMatchObject([{ rows: 500, bytes: 500 }]);
  });

  test("a row committed after the step's snapshot is counted once, by a later step", async () => {
    const t = initConvexTest();
    await countStep(t);
    await t.run(async (ctx) => {
      const payloadId = await ctx.db.insert("payloads", { data: "x" });
      await ctx.db.insert("outbox", {
        kind: "span",
        ref: "r",
        bytes: 1,
        availableAt: Date.now(),
        payloadId,
      });
      await ctx.db.insert("receipts", {
        rows: 1,
        bytes: 1,
        seq: ctx.db.vars.commitTs,
      });
      // This receipt commits after the snapshot the nested step reads.
      await ctx.runMutation(internal.outbox.count, { chain: 0 });
    });
    await countStep(t);
    await countStep(t);
    expect(await pendingCounted(t)).toEqual({ rows: 1, bytes: 1 });
  });

  test("a dead letter moved back is counted once", async () => {
    const t = initConvexTest();
    await insertRows(t, [{ data: "x" }]);
    await countStep(t);
    await startRunByHand(t);
    await t.mutation(internal.exporter.advance, { generation: 1 });
    await t.mutation(internal.exporter.advance, {
      generation: 1,
      report: { outcome: "rejected", status: 400 },
    });
    expect(await pendingCounted(t)).toEqual({ rows: 0, bytes: 0 });

    expect(await t.mutation(internal.outbox.retryDeadLetters, {})).toEqual({
      moved: 1,
    });
    await countStep(t);
    await countStep(t);
    expect(await pendingCounted(t)).toEqual({ rows: 1, bytes: 1 });
  });

  test("a receipt left behind when traffic stops is consumed after the next sweep", async () => {
    const fake = installFakeLangfuse();
    const t = initConvexTest();
    // A chain has just run, so the record below starts no new one.
    await t.mutation(internal.exporter.dispatch, { op: "wait" });
    await runScheduledNow(t);
    await t.mutation(api.tracing.record, {
      trace: TRACE,
      observations: observations(0, 1),
    });
    await drive(t, fake);
    expect(fake.requests).toHaveLength(1);
    let state = await tables(t);
    expect(state.outbox).toEqual([]);
    expect(state.receipts).toHaveLength(1);

    vi.setSystemTime(Date.now() + 3_600_000);
    await t.mutation(internal.retention.sweep, {});
    await runScheduledNow(t);
    state = await tables(t);
    expect(state.receipts).toEqual([]);
    expect(await pendingCounted(t)).toEqual({ rows: 0, bytes: 0 });
  });

  /** Totals of 30,000 counted rows that no longer exist, and a closed gate. */
  async function drift(t: TestConvex) {
    await t.run(async (ctx) => {
      await ctx.db.insert(
        "exporter",
        exporterDoc({
          generation: 1,
          leaseExpiresAt: Date.now() + 120_000,
          runStartedAt: Date.now(),
        }),
      );
      await ctx.db.insert("counter", {
        addedRows: 30_000,
        addedBytes: 5_000,
        chain: 0,
      });
      await ctx.db.insert("gate", { accepting: false, changedAt: 0 });
    });
  }

  test("stale totals over an empty outbox return to zero and open the gate", async () => {
    for (const run of ["sweep", "advance"] as const) {
      const t = initConvexTest();
      await drift(t);
      if (run === "sweep") {
        await t.mutation(internal.retention.sweep, {});
      } else {
        await t.mutation(internal.exporter.advance, { generation: 1 });
        await runScheduledNow(t);
      }
      const health = await t.query(api.outbox.health, {});
      expect(health.pendingCounted).toEqual({ rows: 0, bytes: 0 });
      expect(health.accepting).toBe(true);
    }
  });

  test("a run that ends on a failed request whose rows are gone still opens a closed gate", async () => {
    const t = initConvexTest();
    await drift(t);
    const [row] = await insertRows(t, [{ data: "x" }]);
    expect(
      await t.mutation(internal.exporter.advance, { generation: 1 }),
    ).toEqual({ done: false, spans: ["x"] });
    // The whole claim vanishes before its report, for example by hand.
    await t.run(async (ctx) => {
      const claimed = await ctx.db.get("outbox", row!);
      await ctx.db.delete("payloads", claimed!.payloadId);
      await ctx.db.delete("outbox", row!);
    });
    expect(
      await t.mutation(internal.exporter.advance, {
        generation: 1,
        report: { outcome: "transient", status: 503 },
      }),
    ).toEqual({ done: true });
    await runScheduledNow(t);
    expect((await t.query(api.outbox.health, {})).accepting).toBe(true);
    // The totals are reset once the row's receipt is consumed.
    await countStep(t);
    await runScheduledNow(t);
    expect(await pendingCounted(t)).toEqual({ rows: 0, bytes: 0 });
  });

  /** Totals of `added` and `removed` with a run of generation 1. */
  async function setTotals(
    t: TestConvex,
    added: { rows: number; bytes: number },
    removed: { rows: number; bytes: number },
  ) {
    await t.run(async (ctx) => {
      await ctx.db.insert("counter", {
        addedRows: added.rows,
        addedBytes: added.bytes,
        chain: 0,
      });
      await ctx.db.insert(
        "exporter",
        exporterDoc({
          generation: 1,
          leaseExpiresAt: Date.now() + 120_000,
          runStartedAt: Date.now(),
          removedRows: removed.rows,
          removedBytes: removed.bytes,
        }),
      );
    });
  }

  test.each([
    ["below", { rows: 5, bytes: 50 }, { rows: 2, bytes: 20 }],
    ["above", { rows: 2, bytes: 20 }, { rows: 5, bytes: 50 }],
  ])(
    "removed totals %s the added ones over an outbox without counted rows and receipts are reset",
    async (_, added, removed) => {
      const t = initConvexTest();
      await setTotals(t, added, removed);
      await t.mutation(internal.outbox.reconcileGate, {});
      expect(await totals(t)).toEqual({ added, removed: added });
    },
  );

  test("drifted totals with a receipt left are not written until the receipt is consumed", async () => {
    const t = initConvexTest();
    const added = { rows: 5, bytes: 50 };
    const removed = { rows: 2, bytes: 20 };
    await setTotals(t, added, removed);
    await t.run(async (ctx) => {
      await ctx.db.insert("receipts", {
        rows: 1,
        bytes: 3,
        seq: ctx.db.vars.commitTs,
      });
    });
    await t.mutation(internal.outbox.reconcileGate, {});
    expect(await totals(t)).toEqual({ added, removed });

    await countStep(t);
    await runScheduledNow(t);
    const counted = { rows: 6, bytes: 53 };
    expect(await totals(t)).toEqual({ added: counted, removed: counted });
  });

  test("a waiting score replaced by a smaller one, accepted before the replacement is counted, leaves exact totals", async () => {
    const t = initConvexTest();
    const upsert = (comment: string) =>
      t.mutation(api.scores.upsert, {
        id: "s1",
        timestamp: Date.now(),
        name: "quality",
        value: 1,
        dataType: "NUMERIC",
        traceId: TRACE.traceId,
        comment,
      });
    await upsert("x".repeat(100));
    await countStep(t);
    // The replacement writes a receipt with a negative byte difference.
    await upsert("");
    await startRunByHand(t);
    await t.mutation(internal.exporter.advance, { generation: 1 });
    await t.mutation(internal.exporter.advance, {
      generation: 1,
      report: accepted,
    });
    // A gate reconciliation runs before that receipt is consumed.
    await t.mutation(internal.outbox.reconcileGate, {});
    await consumeReceipts(t);
    await runScheduledNow(t);

    const { added, removed } = await totals(t);
    expect(added.rows).toBe(1);
    expect(removed).toEqual(added);
  });

  test("a closed gate opens when the last counted row is accepted while a trace deletion request is deferred", async () => {
    const fake = installFakeLangfuse();
    fake.fallback = (request) =>
      request.path === "/api/public/traces" ? { status: 404 } : { status: 200 };
    const t = initConvexTest();
    await t.mutation(api.traces.remove, { traceIds: [TRACE.traceId] });
    await t.mutation(api.tracing.record, {
      trace: TRACE,
      observations: observations(0, 1),
    });
    await countStep(t);
    // Drifted totals far above the threshold and a closed gate.
    await t.run(async (ctx) => {
      const counter = (await ctx.db.query("counter").first())!;
      await ctx.db.patch("counter", counter._id, { addedRows: 30_000 });
      await ctx.db.insert("gate", { accepting: false, changedAt: 0 });
    });
    await t.mutation(internal.exporter.kick, {});
    const health = () => t.query(api.outbox.health, {});
    await drive(t, fake, {
      until: async () =>
        (await health()).accepting || fake.requests.length > 10,
    });

    expect((await health()).accepting).toBe(true);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "DELETE /api/public/traces",
      "POST /api/public/otel/v1/traces",
    ]);
    expect((await tables(t)).outbox.map((row) => row.kind)).toEqual([
      "traceDelete",
    ]);
  });

  test("a pending trace deletion request does not keep drifted totals alive", async () => {
    const t = initConvexTest();
    await drift(t);
    await t.mutation(api.traces.remove, { traceIds: [TRACE.traceId] });
    await t.mutation(internal.retention.sweep, {});
    const health = await t.query(api.outbox.health, {});
    expect(health.pendingCounted).toEqual({ rows: 0, bytes: 0 });
    expect(health.accepting).toBe(true);
    expect((await tables(t)).outbox).toHaveLength(1);
  });

  test.each(["span", "scoreCreate", "scoreDelete"] as const)(
    "stale totals and a closed gate stay while the outbox holds a %s row",
    async (kind) => {
      const t = initConvexTest();
      await drift(t);
      // The row is not available yet, so the run claims nothing and ends.
      const [id] = await insertRows(t, [{ data: "x" }], {
        availableAt: Date.now() + 60_000,
      });
      await t.run(async (ctx) => {
        await ctx.db.patch("outbox", id!, { kind });
        for (const receipt of await ctx.db.query("receipts").collect()) {
          await ctx.db.delete("receipts", receipt._id);
        }
      });
      expect(
        await t.mutation(internal.exporter.advance, { generation: 1 }),
      ).toEqual({ done: true });
      await runScheduledNow(t);
      const health = await t.query(api.outbox.health, {});
      expect(health.pendingCounted).toEqual({ rows: 30_000, bytes: 5_000 });
      expect(health.accepting).toBe(false);
    },
  );
});

describe("health", () => {
  test("reports pending rows, dead letters, the gate and an active backoff", async () => {
    const t = initConvexTest();
    await insertRows(t, [{ data: "a" }, { data: "b" }, { data: "c" }]);
    await countStep(t);
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
      await ctx.db.insert(
        "exporter",
        exporterDoc({
          generation: 4,
          backoffUntil: now + 30_000,
          consecutiveFailures: 2,
          consecutiveRejected: 1,
          lastAcceptedAt: now - 60_000,
          lastError: { at: now - 1_000, class: "transient", status: 503 },
          accepted: 7,
          deadLettered: 1,
        }),
      );
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
      prompts: { tracked: 0, errors: 0 },
      skills: { tracked: 0, errors: 0, due: 0, overflow: false },
    });
  });
});
