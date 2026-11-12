import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import {
  DEAD_LETTER_RETENTION_MS,
  MAX_PENDING_AGE_MS,
  MAX_ROW_BYTES,
  MAX_SNAPSHOT_BYTES,
  RETENTION_BATCH,
  RETENTION_BATCH_BYTES,
  SCORE_KEY_RETENTION_MS,
} from "./constants.js";
import {
  countStep,
  enableExport,
  insertRows,
  ownerlessPayloads,
  pendingCounted,
  pendingScheduled,
  startRunByHand,
  tables,
  type TestConvex,
} from "./fakeLangfuse.test-util.js";
import { initConvexTest } from "./setup.test.js";

let t: TestConvex;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  enableExport();
  t = initConvexTest();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("retention sweep", () => {
  test("an expired row lowers the pending count by one, counted before or after, never below zero", async () => {
    // "aa" is counted before it expires, "bbb" only after.
    await insertRows(t, [{ data: "aa" }]);
    await countStep(t);
    await insertRows(t, [{ data: "bbb" }]);
    expect(await pendingCounted(t)).toEqual({ rows: 1, bytes: 2 });

    vi.setSystemTime(Date.now() + MAX_PENDING_AGE_MS + 1_000);
    // A fresh row keeps the outbox non-empty, so no drift reset applies.
    await insertRows(t, [{ data: "c" }]);
    await t.mutation(internal.retention.sweep, {});
    const state = await tables(t);
    expect(state.outbox).toHaveLength(1);
    expect(state.exporter[0]!.expired).toBe(2);
    expect(await pendingCounted(t)).toEqual({ rows: 0, bytes: 0 });
    await countStep(t);
    expect(await pendingCounted(t)).toEqual({ rows: 1, bytes: 1 });
  });

  test("skips the claimed batch, and a report for deleted rows is a no-op for them", async () => {
    const [first, second] = await insertRows(t, [{ data: "a" }, { data: "b" }]);
    await startRunByHand(t);
    const step = await t.mutation(internal.exporter.advance, { generation: 1 });
    expect(step).toEqual({ done: false, spans: ["a", "b"] });
    await insertRows(t, [{ data: "c" }]);

    vi.setSystemTime(Date.now() + MAX_PENDING_AGE_MS + 1_000);
    await t.mutation(internal.retention.sweep, {});
    let state = await tables(t);
    expect(state.outbox.map((row) => row._id)).toEqual([first, second]);
    expect(state.exporter[0]!.expired).toBe(1);
    expect(ownerlessPayloads(state)).toEqual([]);

    // One claimed row disappears before the acknowledgement arrives.
    await t.run(async (ctx) => {
      const row = (await ctx.db.get("outbox", first!))!;
      await ctx.db.delete("payloads", row.payloadId);
      await ctx.db.delete("outbox", row._id);
    });
    expect(
      await t.mutation(internal.exporter.advance, {
        generation: 1,
        report: { outcome: "accepted", status: 200 },
      }),
    ).toEqual({ done: true });
    state = await tables(t);
    expect(state.outbox).toEqual([]);
    expect(state.exporter[0]!.accepted).toBe(1);
    expect(ownerlessPayloads(state)).toEqual([]);

    // Dead letters past their retention go with their payloads.
    await t.run(async (ctx) => {
      const payloadId = await ctx.db.insert("payloads", { data: "d" });
      await ctx.db.insert("deadLetters", {
        kind: "span",
        ref: "r",
        bytes: 1,
        payloadId,
        reason: "rejected",
        status: 400,
        failedAt: Date.now() - DEAD_LETTER_RETENTION_MS - 1,
      });
    });
    await t.mutation(internal.retention.sweep, {});
    state = await tables(t);
    expect(state.deadLetters).toEqual([]);
    expect(state.payloads).toEqual([]);
  });

  describe("with Convex's transaction limits", () => {
    const ROWS = 20;
    const data = "x".repeat(MAX_ROW_BYTES);

    beforeEach(() => {
      t = initConvexTest({ transactionLimits: true });
    });

    /** `count` outbox rows of `MAX_ROW_BYTES`, five per commit. */
    async function insertLargeRows(count: number): Promise<void> {
      for (let i = 0; i < count; i += 5) {
        await insertRows(
          t,
          Array.from({ length: Math.min(5, count - i) }, () => ({ data })),
        );
      }
    }

    /** `count` dead letters of `MAX_ROW_BYTES`, five per commit. */
    async function insertLargeDeadLetters(count: number): Promise<void> {
      for (let i = 0; i < count; i += 5) {
        await t.run(async (ctx) => {
          for (let j = i; j < Math.min(i + 5, count); j++) {
            const payloadId = await ctx.db.insert("payloads", { data });
            await ctx.db.insert("deadLetters", {
              kind: "span",
              ref: `r${j}`,
              bytes: MAX_ROW_BYTES,
              payloadId,
              reason: "rejected",
              status: 400,
              failedAt: Date.now() - DEAD_LETTER_RETENTION_MS - 1,
            });
          }
        });
      }
    }

    async function sweepUntilDone(): Promise<void> {
      await t.mutation(internal.retention.sweep, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    }

    test("20 expired rows of 900 KiB are all deleted and counted", async () => {
      await insertLargeRows(ROWS);
      vi.setSystemTime(Date.now() + MAX_PENDING_AGE_MS + 1_000);
      await sweepUntilDone();

      const state = await tables(t);
      expect(state.outbox).toEqual([]);
      expect(state.payloads).toEqual([]);
      expect(state.exporter[0]).toMatchObject({
        expired: ROWS,
        removedRows: ROWS,
        removedBytes: ROWS * MAX_ROW_BYTES,
      });
      expect(await pendingCounted(t)).toEqual({ rows: 0, bytes: 0 });
    });

    test("20 old dead letters of 900 KiB are all deleted", async () => {
      await insertLargeDeadLetters(ROWS);
      await sweepUntilDone();

      const state = await tables(t);
      expect(state.deadLetters).toEqual([]);
      expect(state.payloads).toEqual([]);
    });

    test("dead letters follow in the next run once outbox rows spent the budget", async () => {
      const rows = Math.floor(RETENTION_BATCH_BYTES / MAX_ROW_BYTES) + 1;
      await insertLargeRows(rows);
      vi.setSystemTime(Date.now() + MAX_PENDING_AGE_MS + 1_000);
      await insertLargeDeadLetters(3);

      await t.mutation(internal.retention.sweep, {});
      let state = await tables(t);
      expect(state.outbox).toHaveLength(1);
      expect(state.deadLetters).toHaveLength(3);
      expect(await pendingScheduled(t)).toContain("retention:sweep");

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      state = await tables(t);
      expect(state.outbox).toEqual([]);
      expect(state.deadLetters).toEqual([]);
      expect(state.payloads).toEqual([]);
      expect(state.exporter[0]!.expired).toBe(rows);
    });

    test("prompt snapshot collection waits for the next run once outbox rows spent the budget", async () => {
      await insertLargeRows(Math.floor(RETENTION_BATCH_BYTES / MAX_ROW_BYTES));
      const snapshots = async () =>
        await t.run(
          async (ctx) => await ctx.db.query("promptSnapshots").collect(),
        );
      for (let i = 0; i < 4; i++) {
        await t.run(async (ctx) => {
          await ctx.db.insert("promptSnapshots", {
            key: `big-${i}`,
            name: "big",
            version: i + 1,
            source: "langfuse",
            type: "text",
            prompt: "x".repeat(MAX_SNAPSHOT_BYTES - 2),
            config: "{}",
            fetchedAt: Date.now(),
          });
        });
      }
      vi.setSystemTime(Date.now() + MAX_PENDING_AGE_MS + 1_000);

      await t.mutation(internal.retention.sweep, {});
      expect((await tables(t)).outbox).toEqual([]);
      expect(await snapshots()).toHaveLength(4);
      expect(await pendingScheduled(t)).toContain("retention:sweep");

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await snapshots()).toEqual([]);
    });
  });

  test("200 old keys with queued ops do not keep an idle key behind them from being deleted", async () => {
    await t.run(async (ctx) => {
      for (let i = 0; i < RETENTION_BATCH; i++) {
        const payloadId = await ctx.db.insert("payloads", { data: "{}" });
        const queued = await ctx.db.insert("outbox", {
          kind: "scoreCreate",
          ref: `s${i}`,
          bytes: 2,
          availableAt: Date.now(),
          payloadId,
        });
        await ctx.db.insert("scoreKeys", {
          scoreId: `s${i}`,
          queued,
          updatedAt: Date.now() + i,
        });
      }
      await ctx.db.insert("scoreKeys", {
        scoreId: "idle",
        updatedAt: Date.now() + RETENTION_BATCH,
      });
    });
    // An outage of more than a day, shorter than the expiry of the ops.
    vi.setSystemTime(Date.now() + SCORE_KEY_RETENTION_MS + 60_000);
    await t.mutation(internal.retention.sweep, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const state = await tables(t);
    expect(state.scoreKeys.map((key) => key.scoreId)).not.toContain("idle");
    expect(state.scoreKeys).toHaveLength(RETENTION_BATCH);
    expect(state.scoreKeys.every((key) => key.queued !== undefined)).toBe(true);
    expect(state.outbox).toHaveLength(RETENTION_BATCH);
  });

  test("a sweep over empty tables writes and schedules nothing", async () => {
    await t.mutation(internal.retention.sweep, {});
    expect(await tables(t)).toEqual({
      outbox: [],
      payloads: [],
      deadLetters: [],
      receipts: [],
      counter: [],
      exporter: [],
      gate: [],
      scoreKeys: [],
    });
    expect(await pendingScheduled(t)).toEqual([]);
  });
});
