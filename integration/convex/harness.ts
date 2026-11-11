import { v } from "convex/values";
import { Langfuse } from "convex-langfuse";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

/** Throws on every failure, so a mutation that did not enqueue fails. */
const strict = new Langfuse(components.convexLangfuse, {
  content: "full",
  onError: "throw",
});
/** Logs failures and a closed gate instead of throwing. */
const lenient = new Langfuse(components.convexLangfuse, { content: "full" });

/** Observation id `n`, as 16 hex characters. `n` starts at 1. */
function spanId(n: number): string {
  return n.toString(16).padStart(16, "0");
}

/**
 * Records `count` spans with ids `from` to `from + count - 1` in one trace.
 * With `lenient`, a closed gate is logged instead of thrown.
 */
export const record = mutation({
  args: {
    traceId: v.string(),
    from: v.number(),
    count: v.number(),
    lenient: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    await (args.lenient ? lenient : strict)
      .trace({ traceId: args.traceId, name: "integration" })
      .record(
        ctx,
        Array.from({ length: args.count }, (_, i) => ({
          id: spanId(args.from + i),
          type: "span" as const,
          name: `span-${args.from + i}`,
          startTime: now,
        })),
      );
    return null;
  },
});

/** Whether the component sees a complete export configuration. */
export const enabled = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => (await strict.health(ctx)).enabled,
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
    const health = await strict.health(ctx);
    return {
      accepting: health.accepting,
      pendingAtLeast: health.pendingAtLeast,
      pendingCounted: health.pendingCounted.rows,
      accepted: health.exporter.accepted,
    };
  },
});
