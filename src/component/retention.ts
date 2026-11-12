import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation } from "./_generated/server.js";
import {
  DEAD_LETTER_RETENTION_MS,
  MAX_PENDING_AGE_MS,
  RETENTION_BATCH,
  RETENTION_BATCH_BYTES,
} from "./constants.js";
import {
  getExporter,
  getOrCreateExporter,
  reconcile,
  scheduleCount,
  withRemoved,
} from "./outbox.js";

/**
 * Hourly sweep. Expires outbox rows older than `MAX_PENDING_AGE_MS`, except
 * the batch in flight, and deletes dead letters older than
 * `DEAD_LETTER_RETENTION_MS`, at most `RETENTION_BATCH` of each and
 * `RETENTION_BATCH_BYTES` of payloads in total per run; a run that reaches a
 * limit schedules the next one at once. Expired rows add to the removed
 * totals. Starts a count chain while rows are pending or receipts are left,
 * then sets the gate from both totals and resets drifted totals once the
 * outbox is empty. A run that finds nothing to do writes and schedules
 * nothing.
 */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
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
    const stale = await ctx.db
      .query("outbox")
      .withIndex("by_creation_time", (q) =>
        q.lt("_creationTime", now - MAX_PENDING_AGE_MS),
      )
      .take(RETENTION_BATCH);
    const expired: Doc<"outbox">[] = [];
    for (const row of stale) {
      if (claimed.has(row._id)) continue;
      if (!fits(row.bytes)) break;
      await ctx.db.delete("payloads", row.payloadId);
      await ctx.db.delete("outbox", row._id);
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
    const deadLetters = overBudget
      ? []
      : await ctx.db
          .query("deadLetters")
          .withIndex("by_failedAt", (q) =>
            q.lt("failedAt", now - DEAD_LETTER_RETENTION_MS),
          )
          .take(RETENTION_BATCH);
    for (const deadLetter of deadLetters) {
      if (!fits(deadLetter.bytes)) break;
      await ctx.db.delete("payloads", deadLetter.payloadId);
      await ctx.db.delete("deadLetters", deadLetter._id);
    }

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
      deadLetters.length === RETENTION_BATCH
    ) {
      await ctx.scheduler.runAfter(0, internal.retention.sweep, {});
    }
    return null;
  },
});
