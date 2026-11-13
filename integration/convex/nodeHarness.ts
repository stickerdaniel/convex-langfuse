"use node";

import { v } from "convex/values";
import { Langfuse } from "@stickerdaniel/convex-langfuse";
import { components } from "./_generated/api";
import { action } from "./_generated/server";

const langfuse = new Langfuse(components.convexLangfuse, {
  content: "full",
  onError: "throw",
});

/**
 * Records `count` spans with ids `from` to `from + count - 1` and an input of
 * `inputBytes` ASCII bytes each, in one `trace.record` call from a Node
 * action. The client splits them into component calls by encoded size.
 */
export const recordLarge = action({
  args: {
    traceId: v.string(),
    from: v.number(),
    count: v.number(),
    inputBytes: v.number(),
    startTime: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const { observationIds } = await langfuse
      .trace({ traceId: args.traceId, name: "integration" })
      .record(
        ctx,
        Array.from({ length: args.count }, (_, i) => ({
          id: (args.from + i).toString(16).padStart(16, "0"),
          type: "span" as const,
          name: `span-${args.from + i}`,
          startTime: args.startTime,
          input: "x".repeat(args.inputBytes),
        })),
      );
    return observationIds.length;
  },
});
