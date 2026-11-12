import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server.js";
import { MAX_DELETE_IDS, MAX_PENDING_DELETES } from "./constants.js";
import { pingExporter } from "./outbox.js";
import { exportConfig } from "./settings.js";
import { isTraceId } from "../shared/ids.js";
import { byteLength } from "../shared/otlp.js";

/** Codes `remove` throws as `ConvexError` data. */
export type TraceDeleteErrorCode =
  | "invalid_trace_count"
  | "invalid_trace_id"
  | "too_many_pending_deletes";

function refuse(code: TraceDeleteErrorCode): never {
  throw new ConvexError(code);
}

/**
 * Records a request to delete traces in Langfuse, in the caller's
 * transaction, for `DELETE /api/public/traces`. The request is submitted at
 * least once, after the observations and score writes enqueued before it;
 * completed erasure is not verified. It ignores the admission gate, and
 * neither retention nor the dead-letter sweep ever removes it.
 *
 * Returns `reason: "disabled"` without writing when the component has no
 * export configuration. Throws a `ConvexError` with a `TraceDeleteErrorCode`
 * for 0 or more than `MAX_DELETE_IDS` ids, an invalid trace id, or when
 * `MAX_PENDING_DELETES` requests are pending already, so the caller's
 * mutation rolls back and can run again later. Pending requests are those
 * in the outbox and the rejected ones in the dead letters, which never
 * expire, so repeated rejections cannot grow without bound and
 * `retryDeadLetters` keeps the sum unchanged.
 */
export const remove = mutation({
  args: { traceIds: v.array(v.string()) },
  returns: v.object({
    enqueued: v.boolean(),
    reason: v.optional(v.literal("disabled")),
  }),
  handler: async (ctx, { traceIds }) => {
    if (exportConfig() === null) {
      return { enqueued: false, reason: "disabled" as const };
    }
    if (traceIds.length === 0 || traceIds.length > MAX_DELETE_IDS) {
      refuse("invalid_trace_count");
    }
    if (!traceIds.every(isTraceId)) refuse("invalid_trace_id");
    // Reads only `traceDelete` rows and dead letters, which span and score
    // enqueues never write, so it does not conflict with them.
    const queued = await ctx.db
      .query("outbox")
      .withIndex("by_kind", (q) => q.eq("kind", "traceDelete"))
      .take(MAX_PENDING_DELETES);
    const rejected =
      queued.length < MAX_PENDING_DELETES
        ? await ctx.db
            .query("deadLetters")
            .withIndex("by_kind_failedAt", (q) => q.eq("kind", "traceDelete"))
            .take(MAX_PENDING_DELETES - queued.length)
        : [];
    if (queued.length + rejected.length >= MAX_PENDING_DELETES) {
      refuse("too_many_pending_deletes");
    }
    const data = JSON.stringify({ traceIds });
    const payloadId = await ctx.db.insert("payloads", { data });
    await ctx.db.insert("outbox", {
      kind: "traceDelete",
      ref: traceIds[0]!,
      bytes: byteLength(data),
      availableAt: Date.now(),
      payloadId,
    });
    await pingExporter(ctx);
    return { enqueued: true };
  },
});
