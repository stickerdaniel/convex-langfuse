import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

/** Observation id `n`, as 16 hex characters. `n` starts at 1. */
function spanId(n: number): string {
  return n.toString(16).padStart(16, "0");
}

/** Records `count` spans with ids `from` to `from + count - 1` in one trace. */
export const record = mutation({
  args: { traceId: v.string(), from: v.number(), count: v.number() },
  returns: v.object({
    enqueued: v.number(),
    dropped: v.optional(v.number()),
    reason: v.optional(v.union(v.literal("disabled"), v.literal("backlog"))),
  }),
  handler: async (ctx, { traceId, from, count }) => {
    const now = Date.now();
    return await ctx.runMutation(components.convexLangfuse.tracing.record, {
      trace: { traceId, name: "integration" },
      observations: Array.from({ length: count }, (_, i) => ({
        id: spanId(from + i),
        type: "span" as const,
        name: `span-${from + i}`,
        startTime: now,
        endTime: now,
      })),
    });
  },
});

/** Whether the component sees a complete export configuration. */
export const enabled = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) =>
    (await ctx.runQuery(components.convexLangfuse.outbox.health, {})).enabled,
});

/** Admission gate and backlog, as the component reports them. */
export const backlog = query({
  args: {},
  returns: v.object({
    accepting: v.boolean(),
    pendingAtLeast: v.number(),
    pendingCounted: v.number(),
    accepted: v.number(),
  }),
  handler: async (ctx) => {
    const health = await ctx.runQuery(
      components.convexLangfuse.outbox.health,
      {},
    );
    return {
      accepting: health.accepting,
      pendingAtLeast: health.pendingAtLeast,
      pendingCounted: health.pendingCounted.rows,
      accepted: health.exporter.accepted,
    };
  },
});
