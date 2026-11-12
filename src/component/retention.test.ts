import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import { DEAD_LETTER_RETENTION_MS, MAX_PENDING_AGE_MS } from "./constants.js";
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
    });
    expect(await pendingScheduled(t)).toEqual([]);
  });
});
