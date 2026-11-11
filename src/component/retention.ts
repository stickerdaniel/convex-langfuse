import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import {
  DEAD_LETTER_RETENTION_MS,
  MAX_PENDING_AGE_MS,
  RETENTION_BATCH,
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
 * `DEAD_LETTER_RETENTION_MS`, at most `RETENTION_BATCH` of each per run; a
 * run that reaches a limit schedules the next one at once. Expired rows add
 * to the removed totals. Starts a count chain while rows are pending or
 * receipts are left, then sets the gate from both totals and resets drifted
 * totals once the outbox is empty. A run that finds nothing to do writes and
 * schedules nothing.
 */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();

    let exporter = await getExporter(ctx);
    const claimed = new Set(exporter?.claimed);
    const stale = await ctx.db
      .query("outbox")
      .withIndex("by_creation_time", (q) =>
        q.lt("_creationTime", now - MAX_PENDING_AGE_MS),
      )
      .take(RETENTION_BATCH);
    const expired = stale.filter((row) => !claimed.has(row._id));
    for (const row of expired) {
      await ctx.db.delete("payloads", row.payloadId);
      await ctx.db.delete("outbox", row._id);
    }
    if (expired.length > 0) {
      exporter ??= await getOrCreateExporter(ctx);
      await ctx.db.patch("exporter", exporter._id, {
        ...withRemoved(exporter, expired),
        expired: exporter.expired + expired.length,
      });
    }

    const deadLetters = await ctx.db
      .query("deadLetters")
      .withIndex("by_failedAt", (q) =>
        q.lt("failedAt", now - DEAD_LETTER_RETENTION_MS),
      )
      .take(RETENTION_BATCH);
    for (const deadLetter of deadLetters) {
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
      stale.length === RETENTION_BATCH ||
      deadLetters.length === RETENTION_BATCH
    ) {
      await ctx.scheduler.runAfter(0, internal.retention.sweep, {});
    }
    return null;
  },
});
