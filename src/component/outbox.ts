import { ping } from "@convex-dev/batch-worker";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  internalMutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import {
  COUNT_BATCH,
  HEALTH_COUNT_CAP,
  MEASURE_INTERVAL_MS,
  PENDING_BYTES_THRESHOLD,
  PENDING_ROWS_THRESHOLD,
  WORKER_NAME,
} from "./constants.js";
import { exportConfig } from "./settings.js";

/** The exporter singleton, or `null` before the first dispatch. */
export async function getExporter(
  ctx: QueryCtx,
): Promise<Doc<"exporter"> | null> {
  return await ctx.db.query("exporter").first();
}

export async function getOrCreateExporter(
  ctx: MutationCtx,
): Promise<Doc<"exporter">> {
  const existing = await getExporter(ctx);
  if (existing) return existing;
  const id = await ctx.db.insert("exporter", {
    generation: 0,
    claimed: [],
    consecutiveFailures: 0,
    consecutiveRejected: 0,
    isolateRemaining: 0,
    accepted: 0,
    deadLettered: 0,
    expired: 0,
    pendingRows: 0,
    pendingBytes: 0,
  });
  return (await ctx.db.get("exporter", id))!;
}

/** Whether a count step scheduled at `measuredAt` is due again. */
export function measurementDue(
  measuredAt: number | undefined,
  now: number,
): boolean {
  return measuredAt === undefined || now - measuredAt >= MEASURE_INTERVAL_MS;
}

/**
 * Makes sure the batch-worker loop that drives the exporter runs. Read-only
 * while the loop is running, so app mutations that enqueue do not conflict
 * with the exporter.
 */
export async function pingExporter(ctx: MutationCtx): Promise<void> {
  await ping(ctx, components.batchWorker, {
    name: WORKER_NAME,
    workQuery: internal.exporter.nextWork,
    workerMutation: internal.exporter.dispatch,
    config: { debounceMs: 1000 },
  });
}

/** The pending counters of the exporter document. */
export type Counters = Pick<Doc<"exporter">, "pendingRows" | "pendingBytes">;

/** Whether a count step has already added the row with this `seq`. */
function isCounted(
  seq: Doc<"outbox">["seq"],
  countedThrough: bigint | undefined,
): boolean {
  return (
    typeof seq === "bigint" &&
    countedThrough !== undefined &&
    seq <= countedThrough
  );
}

/**
 * The pending counters after `removed` left the outbox. A row deleted before
 * a count step reached it was never added, so it is not subtracted.
 */
export function withoutRows(
  exporter: Doc<"exporter">,
  removed: Doc<"outbox">[],
): Counters {
  let { pendingRows, pendingBytes } = exporter;
  for (const row of removed) {
    if (row.kind !== "span" || !isCounted(row.seq, exporter.countedThrough)) {
      continue;
    }
    pendingRows -= 1;
    pendingBytes -= row.bytes;
  }
  return { pendingRows, pendingBytes };
}

/**
 * Moves the admission gate from the counters: closed above either threshold,
 * open again below half of both. Writes the gate only when its value changes.
 */
export async function moveGate(
  ctx: MutationCtx,
  { pendingRows, pendingBytes }: Counters,
): Promise<void> {
  const gate = await ctx.db.query("gate").first();
  const accepting = gate?.accepting ?? true;
  let next = accepting;
  if (
    pendingRows > PENDING_ROWS_THRESHOLD ||
    pendingBytes > PENDING_BYTES_THRESHOLD
  ) {
    next = false;
  } else if (
    pendingRows < PENDING_ROWS_THRESHOLD / 2 &&
    pendingBytes < PENDING_BYTES_THRESHOLD / 2
  ) {
    next = true;
  }
  if (next === accepting) return;
  const changedAt = Date.now();
  if (gate) {
    await ctx.db.patch("gate", gate._id, { accepting: next, changedAt });
  } else {
    await ctx.db.insert("gate", { accepting: next, changedAt });
  }
}

/** Whether the admission gate is closed. A missing gate document is open. */
export async function gateClosed(ctx: QueryCtx): Promise<boolean> {
  const gate = await ctx.db.query("gate").first();
  return gate?.accepting === false;
}

/**
 * Schedules a count step unless one was scheduled less than
 * `MEASURE_INTERVAL_MS` ago. The step runs in a mutation of its own, so the
 * caller stays short.
 */
export async function scheduleCount(
  ctx: MutationCtx,
  exporter: Doc<"exporter">,
  now: number,
): Promise<void> {
  if (!measurementDue(exporter.measuredAt, now)) return;
  await ctx.db.patch("exporter", exporter._id, { measuredAt: now });
  await ctx.scheduler.runAfter(0, internal.outbox.count, {});
}

/**
 * Safety net for drifted counters: when the outbox is empty but the counters
 * are not zero or the gate is closed, opens the gate and returns zero
 * counters for the caller to store. Returns `null` when nothing changes.
 */
export async function resetCountersIfEmpty(
  ctx: MutationCtx,
  exporter: Doc<"exporter">,
): Promise<Counters | null> {
  if (await ctx.db.query("outbox").first()) return null;
  const drifted = exporter.pendingRows !== 0 || exporter.pendingBytes !== 0;
  if (!drifted && !(await gateClosed(ctx))) return null;
  const zero = { pendingRows: 0, pendingBytes: 0 };
  await moveGate(ctx, zero);
  return zero;
}

/**
 * One count step. Adds the outbox rows committed after `countedThrough` to
 * the pending counters, about `COUNT_BATCH` rows at most, and moves the gate.
 * Rows that commit after this transaction's snapshot lie outside the read
 * range, so concurrent enqueues do not conflict with it. Deletions subtract
 * counted rows and write the exporter document too, so they serialize with
 * this step. A full step schedules the next one at once.
 */
export const count = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const exporter = await getOrCreateExporter(ctx);
    const snapshot = ctx.meta.getSnapshotTs();
    const from = exporter.countedThrough ?? 0n;
    const rows = await ctx.db
      .query("outbox")
      .withIndex("by_seq", (q) => q.gt("seq", from).lte("seq", snapshot))
      .take(COUNT_BATCH);
    const full = rows.length === COUNT_BATCH;
    let batch = rows;
    let countedThrough = snapshot;
    if (full) {
      // Rows of one commit share a `seq`. Stop before the last commit in the
      // batch so the next step counts its rows together; a single commit
      // larger than the batch is read whole.
      const last = rows.at(-1)!.seq;
      batch = rows.filter((row) => row.seq !== last);
      if (batch.length === 0) {
        batch = await ctx.db
          .query("outbox")
          .withIndex("by_seq", (q) => q.eq("seq", last))
          .collect();
      }
      const through = batch.at(-1)!.seq;
      if (typeof through !== "bigint") throw new Error("count: uncommitted");
      countedThrough = through;
    }
    const counters: Counters = {
      pendingRows: exporter.pendingRows,
      pendingBytes: exporter.pendingBytes,
    };
    for (const row of batch) {
      if (row.kind !== "span") continue;
      counters.pendingRows += 1;
      counters.pendingBytes += row.bytes;
    }
    await ctx.db.patch("exporter", exporter._id, {
      ...counters,
      countedThrough,
    });
    await moveGate(ctx, counters);
    if (full) await ctx.scheduler.runAfter(0, internal.outbox.count, {});
    return null;
  },
});

const vLastError = v.object({
  at: v.number(),
  class: v.string(),
  status: v.optional(v.number()),
});

/**
 * Export state for dashboards and alerts. `pendingAtLeast` and
 * `deadLettersAtLeast` are lower bounds capped at `HEALTH_COUNT_CAP`.
 * `pendingCounted` holds the counters the gate uses; they trail new rows
 * until the next count step. `oldestPendingAt` is the creation time of the
 * oldest pending row. `backoffUntil` is set only while a backoff is active.
 */
export const health = query({
  args: {},
  returns: v.object({
    enabled: v.boolean(),
    accepting: v.boolean(),
    pendingAtLeast: v.number(),
    pendingCounted: v.object({ rows: v.number(), bytes: v.number() }),
    oldestPendingAt: v.optional(v.number()),
    deadLettersAtLeast: v.number(),
    exporter: v.object({
      running: v.boolean(),
      backoffUntil: v.optional(v.number()),
      consecutiveFailures: v.number(),
      lastAcceptedAt: v.optional(v.number()),
      lastError: v.optional(vLastError),
      accepted: v.number(),
      deadLettered: v.number(),
      expired: v.number(),
    }),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const exporter = await getExporter(ctx);
    const pending = await ctx.db.query("outbox").take(HEALTH_COUNT_CAP);
    const deadLetters = await ctx.db
      .query("deadLetters")
      .take(HEALTH_COUNT_CAP);
    const backoffUntil = exporter?.backoffUntil;
    return {
      enabled: exportConfig() !== null,
      accepting: !(await gateClosed(ctx)),
      pendingAtLeast: pending.length,
      pendingCounted: {
        rows: exporter?.pendingRows ?? 0,
        bytes: exporter?.pendingBytes ?? 0,
      },
      oldestPendingAt: pending[0]?._creationTime,
      deadLettersAtLeast: deadLetters.length,
      exporter: {
        running: (exporter?.leaseExpiresAt ?? 0) > now,
        backoffUntil:
          backoffUntil !== undefined && backoffUntil > now
            ? backoffUntil
            : undefined,
        consecutiveFailures: exporter?.consecutiveFailures ?? 0,
        lastAcceptedAt: exporter?.lastAcceptedAt,
        lastError: exporter?.lastError,
        accepted: exporter?.accepted ?? 0,
        deadLettered: exporter?.deadLettered ?? 0,
        expired: exporter?.expired ?? 0,
      },
    };
  },
});

/**
 * Moves up to `limit` (default 100) dead letters, oldest first, back to the
 * outbox and wakes the exporter. A moved row gets a new `seq`, so the next
 * count step counts it. Does nothing while the gate is closed. Run it from the
 * dashboard or CLI after fixing what made Langfuse reject them.
 */
export const retryDeadLetters = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ moved: v.number() }),
  handler: async (ctx, { limit = 100 }) => {
    if (await gateClosed(ctx)) return { moved: 0 };
    const deadLetters = await ctx.db
      .query("deadLetters")
      .withIndex("by_failedAt")
      .take(Math.max(0, Math.floor(limit)));
    const now = Date.now();
    for (const { _id, kind, ref, bytes, payloadId } of deadLetters) {
      await ctx.db.insert("outbox", {
        kind,
        ref,
        bytes,
        payloadId,
        availableAt: now,
        seq: ctx.db.vars.commitTs,
      });
      await ctx.db.delete("deadLetters", _id);
    }
    if (deadLetters.length > 0) await pingExporter(ctx);
    return { moved: deadLetters.length };
  },
});
