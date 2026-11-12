import { v } from "convex/values";
import { Langfuse } from "convex-langfuse";
import { components } from "./_generated/api";
import { mutation } from "./_generated/server";

/** Throws on every failure, so a mutation that did not enqueue fails. */
const langfuse = new Langfuse(components.convexLangfuse, {
  content: "full",
  onError: "throw",
});

const vMetadata = v.record(v.string(), v.union(v.string(), v.number()));

/**
 * Records a root span and a generation nested under it, in one trace with
 * every trace field. Returns the ids of both observations.
 */
export const recordTrace = mutation({
  args: {
    traceId: v.string(),
    name: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    tags: v.array(v.string()),
    release: v.string(),
    traceMetadata: vMetadata,
    rootMetadata: vMetadata,
    generation: v.object({
      model: v.string(),
      usage: v.record(v.string(), v.number()),
      cost: v.record(v.string(), v.number()),
      prompt: v.object({ name: v.string(), version: v.number() }),
      metadata: vMetadata,
    }),
  },
  returns: v.object({ rootId: v.string(), generationId: v.string() }),
  handler: async (ctx, args) => {
    const start = Date.now();
    const { observationIds } = await langfuse
      .trace({
        traceId: args.traceId,
        name: args.name,
        userId: args.userId,
        sessionId: args.sessionId,
        tags: args.tags,
        release: args.release,
        metadata: args.traceMetadata,
      })
      .record(ctx, [
        {
          key: "root",
          type: "span",
          name: "root",
          startTime: start,
          endTime: start + 1_000,
          input: "question",
          output: "answer",
          metadata: args.rootMetadata,
        },
        {
          key: "generation",
          parent: { key: "root" },
          type: "generation",
          name: "generation",
          startTime: start + 100,
          endTime: start + 900,
          input: "prompt",
          output: "completion",
          ...args.generation,
        },
      ]);
    return { rootId: observationIds[0]!, generationId: observationIds[1]! };
  },
});

/**
 * Records the observations of one experiment item: the item's root span and
 * a generation under it, both with the experiment on the trace. Returns the
 * id of the root span.
 */
export const recordExperimentItem = mutation({
  args: {
    traceId: v.string(),
    name: v.string(),
    experimentId: v.string(),
    experimentName: v.string(),
    itemId: v.string(),
  },
  returns: v.object({ rootId: v.string() }),
  handler: async (ctx, args) => {
    const start = Date.now();
    const { observationIds } = await langfuse
      .trace({
        traceId: args.traceId,
        name: args.name,
        experiment: {
          id: args.experimentId,
          name: args.experimentName,
          itemId: args.itemId,
          rootObservation: { key: "item" },
        },
      })
      .record(ctx, [
        {
          key: "item",
          type: "span",
          name: "item",
          startTime: start,
          endTime: start + 1_000,
          input: "item input",
          output: "item output",
        },
        {
          key: "task",
          parent: { key: "item" },
          type: "generation",
          name: "task",
          startTime: start + 100,
          endTime: start + 900,
        },
      ]);
    return { rootId: observationIds[0]! };
  },
});
