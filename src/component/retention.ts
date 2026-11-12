import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation } from "./_generated/server.js";
import {
  DEAD_LETTER_RETENTION_MS,
  MAX_PENDING_AGE_MS,
  RETENTION_BATCH,
  RETENTION_BATCH_BYTES,
  SCORE_KEY_RETENTION_MS,
} from "./constants.js";
import {
  getExporter,
  getOrCreateExporter,
  reconcile,
  scheduleCount,
  withRemoved,
} from "./outbox.js";
import {
  collectSnapshots,
  deleteExpiredPins,
  vSnapshotPass,
} from "./prompts.js";
import { forgetOp } from "./scoreKeys.js";

/**
 * Kinds whose rows and dead letters expire. Trace deletion requests never
 * do: they leave the outbox only when Langfuse accepts them.
 */
const EXPIRING = ["span", "scoreCreate", "scoreDelete"] as const;

/**
 * Hourly sweep. Expires outbox rows of `EXPIRING` kinds older than
 * `MAX_PENDING_AGE_MS`, except the batch in flight, deletes their dead
 * letters older than `DEAD_LETTER_RETENTION_MS`, deletes `scoreKeys` rows
 * without pointers idle for `SCORE_KEY_RETENTION_MS`, deletes expired prompt
 * pins, then prompt snapshots that no label and no pin references (see
 * `prompts.collectSnapshots`). At most `RETENTION_BATCH` of each and
 * `RETENTION_BATCH_BYTES` in total per run, for the payloads it deletes and
 * the snapshots it reads and deletes; a run that reaches a limit schedules
 * the next one at once, which continues the snapshot collection pass in
 * `snapshots`. Expired span and score rows add to the removed totals, and
 * an expired score op leaves no pointer to it. Starts a count chain while
 * rows are pending or receipts are left, then sets the gate from both totals
 * and resets drifted totals once no counted row and no receipt is left
 * (`reconcile`). A run that finds nothing to do writes and schedules nothing.
 */
export const sweep = internalMutation({
  args: { snapshots: v.optional(vSnapshotPass) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();

    // Payload bytes and rows this run deletes. The sizes come from `bytes`,
    // so the selection reads no payload. A row that does not fit into what
    // is left of the budget ends the run, unless it is the first, so every
    // run makes progress.
    let spentBytes = 0;
    let spentRows = 0;
    let overBudget = false;
    const fits = (bytes: number): boolean => {
      if (spentRows > 0 && spentBytes + bytes > RETENTION_BATCH_BYTES) {
        overBudget = true;
        return false;
      }
      spentBytes += bytes;
      spentRows += 1;
      return true;
    };

    let exporter = await getExporter(ctx);
    const claimed = new Set(exporter?.claimed);
    const stale: Doc<"outbox">[] = [];
    for (const kind of EXPIRING) {
      const budget = RETENTION_BATCH - stale.length;
      if (budget === 0) break;
      stale.push(
        ...(await ctx.db
          .query("outbox")
          .withIndex("by_kind", (q) =>
            q.eq("kind", kind).lt("_creationTime", now - MAX_PENDING_AGE_MS),
          )
          .take(budget)),
      );
    }
    const expired: Doc<"outbox">[] = [];
    for (const row of stale) {
      if (claimed.has(row._id)) continue;
      if (!fits(row.bytes)) break;
      await ctx.db.delete("payloads", row.payloadId);
      await ctx.db.delete("outbox", row._id);
      await forgetOp(ctx, row, now);
      expired.push(row);
    }
    if (expired.length > 0) {
      exporter ??= await getOrCreateExporter(ctx);
      await ctx.db.patch("exporter", exporter._id, {
        ...withRemoved(exporter, expired),
        expired: exporter.expired + expired.length,
      });
    }

    // Once the outbox rows spent the budget, the dead letters wait for the
    // next run.
    const deadLetters: Doc<"deadLetters">[] = [];
    for (const kind of overBudget ? [] : EXPIRING) {
      const budget = RETENTION_BATCH - deadLetters.length;
      if (budget === 0) break;
      deadLetters.push(
        ...(await ctx.db
          .query("deadLetters")
          .withIndex("by_kind_failedAt", (q) =>
            q.eq("kind", kind).lt("failedAt", now - DEAD_LETTER_RETENTION_MS),
          )
          .take(budget)),
      );
    }
    for (const deadLetter of deadLetters) {
      if (!fits(deadLetter.bytes)) break;
      await ctx.db.delete("payloads", deadLetter.payloadId);
      await ctx.db.delete("deadLetters", deadLetter._id);
    }

    // A key is idle only while no op of it is pending. A key with a pointer
    // stays and moves to the end of the index, so keys with ops queued
    // during a long outage do not hide idle keys behind them; its op
    // expires within `MAX_PENDING_AGE_MS`. Every key read is deleted or
    // moved, so a full batch can continue without reading it again.
    const oldKeys = await ctx.db
      .query("scoreKeys")
      .withIndex("by_updatedAt", (q) =>
        q.lt("updatedAt", now - SCORE_KEY_RETENTION_MS),
      )
      .take(RETENTION_BATCH);
    for (const key of oldKeys) {
      if (key.queued !== undefined || key.inFlight !== undefined) {
        await ctx.db.patch("scoreKeys", key._id, { updatedAt: now });
      } else {
        await ctx.db.delete("scoreKeys", key._id);
      }
    }

    // The prompt rows read here besides snapshots count against no budget;
    // their size bounds keep them small. This run reads at most
    // `RETENTION_BATCH` expired pins and, per snapshot of the page, one
    // label, one pin, one version pointer and its name's row. A pin holds a
    // scope (`MAX_PROMPT_SCOPE_BYTES`) and a name (`MAX_PROMPT_NAME_BYTES`)
    // of 256 bytes each; a label row a name and a label, which Langfuse
    // limits to 36 characters; a version pointer a name; a name row at most
    // about 10 KiB. With the deletions of pins and pointers, that is below
    // 3 MiB, within the half of 16 MiB that `RETENTION_BATCH_BYTES` leaves.
    const expiredPins = await deleteExpiredPins(ctx, now);
    // Snapshot collection spends what the payloads left of the budget. Once
    // they spent it, collection waits for the next run.
    const snapshots = overBudget
      ? args.snapshots
      : await collectSnapshots(
          ctx,
          now,
          RETENTION_BATCH_BYTES - spentBytes,
          args.snapshots,
        );

    // Receipts stay behind when traffic stops before the next chain is due.
    if (
      (await ctx.db.query("outbox").first()) ||
      (await ctx.db.query("receipts").first())
    ) {
      await scheduleCount(ctx, now);
    }
    await reconcile(ctx);

    if (
      overBudget ||
      stale.length === RETENTION_BATCH ||
      deadLetters.length === RETENTION_BATCH ||
      oldKeys.length === RETENTION_BATCH ||
      expiredPins === RETENTION_BATCH ||
      snapshots !== undefined
    ) {
      await ctx.scheduler.runAfter(0, internal.retention.sweep, { snapshots });
    }
    return null;
  },
});
