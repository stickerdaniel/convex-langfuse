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
  RETRY_DEAD_LETTERS_MAX,
  WORKER_NAME,
} from "./constants.js";
import { promptHealth, vPromptHealth } from "./prompts.js";
import { skillHealth, vSkillHealth } from "./skills.js";
import type { Kind } from "./schema.js";
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
    removedRows: 0,
    removedBytes: 0,
  });
  return (await ctx.db.get("exporter", id))!;
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

/**
 * The kinds whose rows count toward the pending backlog the admission gate
 * decides on: every enqueue of such a row writes a receipt, and every such
 * row that leaves the outbox adds to the removed totals. Trace deletion
 * requests do not count; `traces.remove` bounds them with a quota of its own.
 */
export const COUNTED_KINDS: readonly Kind[] = [
  "span",
  "scoreCreate",
  "scoreDelete",
];

/** The pending backlog the admission gate decides on. */
export type Pending = { pendingRows: number; pendingBytes: number };

/** The removed totals of the exporter document. */
export type Removed = Pick<Doc<"exporter">, "removedRows" | "removedBytes">;

const vAmount = v.object({ rows: v.number(), bytes: v.number() });

/**
 * The removed totals after `rows` left the outbox. Every deleted row of a
 * counted kind counts, whether a count step has consumed its receipt or not.
 * The caller stores the result on the exporter document.
 */
export function withRemoved(removed: Removed, rows: Doc<"outbox">[]): Removed {
  let { removedRows, removedBytes } = removed;
  for (const row of rows) {
    if (!COUNTED_KINDS.includes(row.kind)) continue;
    removedRows += 1;
    removedBytes += row.bytes;
  }
  return { removedRows, removedBytes };
}

/**
 * Moves the admission gate from the pending backlog: closed above either
 * threshold, open again below half of both. Writes the gate only when its
 * value changes.
 */
export async function moveGate(
  ctx: MutationCtx,
  { pendingRows, pendingBytes }: Pending,
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
 * Starts a new count chain unless the current chain scheduled a step less
 * than `MEASURE_INTERVAL_MS` ago. A running chain refreshes `steppedAt` with
 * every step it schedules, so at most one chain is alive; a step of an older
 * chain stops. The steps run in mutations of their own, so the caller stays
 * short.
 */
export async function scheduleCount(
  ctx: MutationCtx,
  now: number,
): Promise<void> {
  let counter = await ctx.db.query("counter").first();
  if (!counter) {
    const id = await ctx.db.insert("counter", {
      addedRows: 0,
      addedBytes: 0,
      chain: 0,
    });
    counter = (await ctx.db.get("counter", id))!;
  }
  const { steppedAt } = counter;
  if (steppedAt !== undefined && now - steppedAt < MEASURE_INTERVAL_MS) return;
  const chain = counter.chain + 1;
  await ctx.db.patch("counter", counter._id, { chain, steppedAt: now });
  await ctx.scheduler.runAfter(0, internal.outbox.count, { chain });
}

/** Whether the outbox holds a row of a counted kind: one lookup per kind. */
async function holdsCounted(ctx: QueryCtx): Promise<boolean> {
  for (const kind of COUNTED_KINDS) {
    const row = await ctx.db
      .query("outbox")
      .withIndex("by_kind", (q) => q.eq("kind", kind))
      .first();
    if (row) return true;
  }
  return false;
}

/**
 * Sets the gate from the pending backlog, `counter.added*` minus
 * `exporter.removed*`. It reads both totals and the gate in this transaction,
 * so every gate move follows from one consistent state.
 *
 * It is also the safety net for drift, for example after rows were deleted
 * by hand. When the totals differ or the gate is closed, it looks for a row
 * of a counted kind in the outbox; it reads the outbox only in that case.
 * Without one, the gate decides on a backlog of zero and opens, whatever the
 * totals say; trace deletion requests do not keep it closed. When in
 * addition no receipt is left, the removed totals are set to the added ones,
 * in either direction. While a receipt is left, the totals are not written:
 * a replacement receipt can be negative, so they may still converge, and the
 * count step that consumes it schedules `reconcileGate` again.
 *
 * It reads the counter and the exporter document, so it runs in the sweep or
 * in `reconcileGate`, never inside a count step or `advance`.
 */
export async function reconcile(ctx: MutationCtx): Promise<void> {
  const counter = await ctx.db.query("counter").first();
  const exporter = await getExporter(ctx);
  const added = {
    rows: counter?.addedRows ?? 0,
    bytes: counter?.addedBytes ?? 0,
  };
  let pending: Pending = {
    pendingRows: added.rows - (exporter?.removedRows ?? 0),
    pendingBytes: added.bytes - (exporter?.removedBytes ?? 0),
  };
  const differ = pending.pendingRows !== 0 || pending.pendingBytes !== 0;
  if ((differ || (await gateClosed(ctx))) && !(await holdsCounted(ctx))) {
    if (differ && !(await ctx.db.query("receipts").first())) {
      const { _id } = exporter ?? (await getOrCreateExporter(ctx));
      await ctx.db.patch("exporter", _id, {
        removedRows: added.rows,
        removedBytes: added.bytes,
      });
    }
    pending = { pendingRows: 0, pendingBytes: 0 };
  }
  await moveGate(ctx, pending);
}

/**
 * `reconcile` in a mutation of its own. A count step schedules it after it
 * raised the added totals, and a deletion schedules it while the gate is
 * closed. The count chain and `advance` therefore never read each other's
 * totals, and a gate move never mixes totals of two points in time.
 */
export const reconcileGate = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await reconcile(ctx);
    return null;
  },
});

/** Schedules `reconcileGate` to run at once. */
export async function scheduleReconcile(ctx: MutationCtx): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.outbox.reconcileGate, {});
}

/**
 * One step of count chain `chain`. Consumes at most `COUNT_BATCH` receipts in
 * commit order: adds them to the added totals, deletes them and schedules
 * `reconcileGate`. The scan ends at this transaction's snapshot, so receipts
 * that enqueues commit later lie outside its read range. The step reads and
 * writes only the counter and its receipts, so it does not conflict with the
 * exporter. A full step continues at the `seq` of its last receipt,
 * inclusive, because one commit can hold more receipts than a step, and
 * schedules the next step at once. A step of a superseded chain does
 * nothing.
 */
export const count = internalMutation({
  args: { chain: v.number() },
  returns: v.null(),
  handler: async (ctx, { chain }) => {
    const counter = await ctx.db.query("counter").first();
    if (!counter || counter.chain !== chain) return null;
    const { countedFrom } = counter;
    const snapshot = ctx.meta.getSnapshotTs();
    const receipts = await ctx.db
      .query("receipts")
      .withIndex("by_seq", (q) =>
        countedFrom === undefined
          ? q.lte("seq", snapshot)
          : q.gte("seq", countedFrom).lte("seq", snapshot),
      )
      .take(COUNT_BATCH);
    let { addedRows, addedBytes } = counter;
    for (const receipt of receipts) {
      addedRows += receipt.rows;
      addedBytes += receipt.bytes;
      await ctx.db.delete("receipts", receipt._id);
    }
    const last = receipts.at(-1);
    const full = receipts.length === COUNT_BATCH && last !== undefined;
    let next = snapshot;
    if (full) {
      if (typeof last.seq !== "bigint") throw new Error("count: uncommitted");
      next = last.seq;
    }
    await ctx.db.patch("counter", counter._id, {
      addedRows,
      addedBytes,
      countedFrom: next,
      ...(full ? { steppedAt: Date.now() } : {}),
    });
    if (receipts.length > 0) await scheduleReconcile(ctx);
    if (full) await ctx.scheduler.runAfter(0, internal.outbox.count, { chain });
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
 * `pendingCounted` is the backlog the gate uses: rows and bytes of spans and
 * score ops from consumed receipts minus those of removed rows, never below
 * zero. It differs from the outbox until a count step consumes the receipts
 * of recent enqueues; once every receipt is consumed it is exact. A
 * replacement of a waiting score op writes a receipt that can lower the
 * bytes, so before it is consumed the bytes can also be too high.
 * `oldestPendingAt` is the
 * creation time of the oldest pending row. `backoffUntil` is set only while a
 * backoff is active. `prompts` and `skills` are the state of the prompt and
 * the skill cache.
 */
export const health = query({
  args: {},
  returns: v.object({
    enabled: v.boolean(),
    accepting: v.boolean(),
    pendingAtLeast: v.number(),
    pendingCounted: vAmount,
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
    prompts: vPromptHealth,
    skills: vSkillHealth,
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const exporter = await getExporter(ctx);
    const counter = await ctx.db.query("counter").first();
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
        rows: Math.max(
          0,
          (counter?.addedRows ?? 0) - (exporter?.removedRows ?? 0),
        ),
        bytes: Math.max(
          0,
          (counter?.addedBytes ?? 0) - (exporter?.removedBytes ?? 0),
        ),
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
      prompts: await promptHealth(ctx),
      skills: await skillHealth(ctx),
    };
  },
});

/**
 * Moves up to `limit` (default 100, at most `RETRY_DEAD_LETTERS_MAX`) span
 * and trace deletion dead letters, oldest first, back to the outbox and
 * wakes the exporter. Writes one receipt for the moved rows of counted
 * kinds, so the next count step counts them once. While the gate is closed it moves trace
 * deletion requests only. Score dead letters stay: the app re-sends the
 * score. Run it from the dashboard or CLI after fixing what made Langfuse
 * reject them.
 */
export const retryDeadLetters = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ moved: v.number() }),
  handler: async (ctx, { limit = 100 }) => {
    const take = Math.min(
      RETRY_DEAD_LETTERS_MAX,
      Math.max(0, Math.floor(limit)),
    );
    const kinds = (await gateClosed(ctx))
      ? (["traceDelete"] as const)
      : (["span", "traceDelete"] as const);
    const candidates: Doc<"deadLetters">[] = [];
    for (const kind of kinds) {
      candidates.push(
        ...(await ctx.db
          .query("deadLetters")
          .withIndex("by_kind_failedAt", (q) => q.eq("kind", kind))
          .take(take)),
      );
    }
    const deadLetters = candidates
      .sort((a, b) => a.failedAt - b.failedAt)
      .slice(0, take);
    const now = Date.now();
    for (const { _id, kind, ref, bytes, payloadId } of deadLetters) {
      await ctx.db.insert("outbox", {
        kind,
        ref,
        bytes,
        payloadId,
        availableAt: now,
      });
      await ctx.db.delete("deadLetters", _id);
    }
    const counted = deadLetters.filter((row) =>
      COUNTED_KINDS.includes(row.kind),
    );
    if (counted.length > 0) {
      await ctx.db.insert("receipts", {
        rows: counted.length,
        bytes: counted.reduce((sum, row) => sum + row.bytes, 0),
        seq: ctx.db.vars.commitTs,
      });
    }
    if (deadLetters.length > 0) await pingExporter(ctx);
    return { moved: deadLetters.length };
  },
});
