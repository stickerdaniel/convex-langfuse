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

/**
 * Records `count` spans like `record`, through the component's
 * `tracing.record` directly, and returns its result unchanged, so a caller
 * can count enqueued and refused records exactly.
 */
export const recordCounted = mutation({
  args: { traceId: v.string(), from: v.number(), count: v.number() },
  returns: v.object({
    enqueued: v.number(),
    dropped: v.optional(v.number()),
    reason: v.optional(v.union(v.literal("disabled"), v.literal("backlog"))),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.runMutation(components.convexLangfuse.tracing.record, {
      trace: { traceId: args.traceId, name: "integration" },
      observations: Array.from({ length: args.count }, (_, i) => ({
        id: spanId(args.from + i),
        type: "span" as const,
        name: `span-${args.from + i}`,
        startTime: now,
        endTime: now,
      })),
    });
  },
});

/**
 * Records one span whose name ends inside an emoji, as `slice` cuts it. The
 * cut leaves a lone surrogate, which Convex refuses in a function argument.
 */
export const recordCut = mutation({
  args: { traceId: v.string(), id: v.number() },
  returns: v.null(),
  handler: async (ctx, { traceId, id }) => {
    await strict.trace({ traceId, name: "integration" }).span(ctx, {
      id: spanId(id),
      name: "cut 😀".slice(0, -1),
      input: "whole 😀",
    });
    return null;
  },
});

/** Whether the component sees a complete export configuration. */
export const enabled = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => (await strict.health(ctx)).enabled,
});

/** The cached `production` prompt of `name`, as the client decodes it. */
export const prompt = query({
  args: { name: v.string() },
  returns: v.union(
    v.null(),
    v.object({ version: v.optional(v.number()), text: v.string() }),
  ),
  handler: async (ctx, { name }) => {
    const cached = await strict.prompts.get(ctx, { name });
    if (!cached) return null;
    return {
      version: cached.version,
      text:
        cached.type === "text" ? cached.prompt : JSON.stringify(cached.prompt),
    };
  },
});

/** Admission gate and backlog, as the component reports them. */
export const backlog = query({
  args: {},
  returns: v.object({
    accepting: v.boolean(),
    pendingAtLeast: v.number(),
    pendingCounted: v.number(),
    accepted: v.number(),
    deadLettered: v.number(),
    deadLettersAtLeast: v.number(),
    backoffMs: v.number(),
  }),
  handler: async (ctx) => {
    const health = await strict.health(ctx);
    return {
      accepting: health.accepting,
      pendingAtLeast: health.pendingAtLeast,
      pendingCounted: health.pendingCounted.rows,
      accepted: health.exporter.accepted,
      deadLettered: health.exporter.deadLettered,
      deadLettersAtLeast: health.deadLettersAtLeast,
      backoffMs:
        health.exporter.backoffUntil !== undefined && health.exporter.lastError
          ? health.exporter.backoffUntil - health.exporter.lastError.at
          : 0,
    };
  },
});
