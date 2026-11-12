import { v } from "convex/values";
import { defineScores, Langfuse } from "convex-langfuse";
import { components } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";

/** The score config name the end-to-end run syncs and writes. */
export const RATING = "convex-langfuse-e2e-rating";

/** Throws on every failure, so a mutation that did not enqueue fails. */
const langfuse = new Langfuse(components.convexLangfuse, {
  content: "full",
  onError: "throw",
  scores: defineScores({
    [RATING]: { dataType: "NUMERIC", min: 0, max: 10 },
  }),
});

/** Syncs the score config of `RATING` and returns its id. */
export const syncConfigs = action({
  args: {},
  returns: v.object({
    status: v.string(),
    configId: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    const result = await langfuse.syncScoreConfigs(ctx);
    const config = result.configs.find(({ name }) => name === RATING);
    return { status: result.status, configId: config?.configId };
  },
});

/** Writes `RATING` scores of one trace, one per id. */
export const score = mutation({
  args: {
    ids: v.array(v.string()),
    traceId: v.string(),
    value: v.number(),
    timestamp: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { ids, traceId, value, timestamp }) => {
    for (const id of ids) {
      await langfuse.score(ctx, {
        name: RATING,
        value,
        trace: { traceId },
        id,
        timestamp,
      });
    }
    return null;
  },
});

/** Deletes scores, one request per id. */
export const deleteScores = mutation({
  args: { ids: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { ids }) => {
    for (const id of ids) await langfuse.deleteScore(ctx, { id });
    return null;
  },
});

/** Records one span in a trace, so the trace exists in Langfuse. */
export const recordTrace = mutation({
  args: { traceId: v.string() },
  returns: v.null(),
  handler: async (ctx, { traceId }) => {
    await langfuse
      .trace({ traceId, name: "convex-langfuse-e2e" })
      .span(ctx, { key: "e2e", name: "e2e" });
    return null;
  },
});

/** Requests the deletion of traces. */
export const deleteTraces = mutation({
  args: { traceIds: v.array(v.string()) },
  returns: v.object({
    enqueued: v.boolean(),
    reason: v.optional(v.literal("disabled")),
  }),
  handler: async (ctx, { traceIds }) =>
    await langfuse.deleteTraces(ctx, {
      traces: traceIds.map((traceId) => ({ traceId })),
    }),
});

/** Backlog, dead letters and the exporter's counters and last error. */
export const health = query({
  args: {},
  returns: v.object({
    pendingAtLeast: v.number(),
    deadLettersAtLeast: v.number(),
    accepted: v.number(),
    lastErrorAt: v.optional(v.number()),
  }),
  handler: async (ctx) => {
    const health = await langfuse.health(ctx);
    return {
      pendingAtLeast: health.pendingAtLeast,
      deadLettersAtLeast: health.deadLettersAtLeast,
      accepted: health.exporter.accepted,
      lastErrorAt: health.exporter.lastError?.at,
    };
  },
});
