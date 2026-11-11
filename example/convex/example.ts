import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { env, mutation, query } from "./_generated/server.js";
import { Langfuse } from "../../src/client/index.js";

const langfuse = new Langfuse(components.convexLangfuse, { content: "full" });

/** One trace per conversation: every completion and step lands in it. */
const conversation = (conversationId: string, userId?: string) =>
  langfuse.trace({
    seed: `conversation:${conversationId}`,
    name: "chat",
    sessionId: conversationId,
    userId,
  });

const vRecorded = v.object({ traceId: v.string(), observationId: v.string() });

// Saves the completion as a note and records it as a generation in the same
// transaction: the generation is exported only if the note commits.
export const recordChatCompletion = mutation({
  args: {
    conversationId: v.string(),
    userId: v.string(),
    prompt: v.string(),
    completion: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
  },
  returns: vRecorded,
  handler: async (ctx, args) => {
    const noteId = await ctx.db.insert("notes", { body: args.completion });
    const trace = conversation(args.conversationId, args.userId);
    return await trace.generation(ctx, {
      key: `completion:${noteId}`,
      name: "chat-completion",
      model: args.model,
      input: args.prompt,
      output: args.completion,
      usage: { input: args.inputTokens, output: args.outputTokens },
    });
  },
});

// Adds a non-LLM step, such as a retrieval or a tool call, to the
// conversation's trace, nested under a generation.
export const recordStep = mutation({
  args: {
    conversationId: v.string(),
    parentObservationId: v.string(),
    name: v.string(),
    input: v.optional(v.string()),
    output: v.optional(v.string()),
  },
  returns: vRecorded,
  handler: async (ctx, args) => {
    return await conversation(args.conversationId).span(ctx, {
      key: `step:${args.parentObservationId}:${args.name}:${Date.now()}`,
      parent: { id: args.parentObservationId },
      name: args.name,
      input: args.input,
      output: args.output,
    });
  },
});

export const health = query({
  args: {},
  handler: async (ctx) => await langfuse.health(ctx),
});

export const getDashboardUrl = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async () => env.LANGFUSE_BASE_URL ?? null,
});
