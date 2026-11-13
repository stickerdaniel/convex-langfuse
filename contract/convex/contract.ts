// Host app of the contract suite. Every function passes its arguments to the
// public `Langfuse` client unchanged and returns the client's result, so a
// case writes through the client and reads the client's answer. The
// functions declare no return validator: a validator here would restate the
// client's result types, which are what the cases check.

import { v } from "convex/values";
import { defineScores, Langfuse } from "@stickerdaniel/convex-langfuse";
import { components } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";

/** The score names the cases write, and their Langfuse score configs. */
const scores = defineScores({
  "contract-rating": { dataType: "NUMERIC", min: 0, max: 10 },
  "contract-helpful": { dataType: "BOOLEAN" },
  "contract-tone": {
    dataType: "CATEGORICAL",
    categories: ["formal", "casual"],
  },
});

/**
 * One client per content setting. Each throws on every failure, so a
 * mutation that did not enqueue fails the case. `redacting` replaces both
 * names and the input, removes the user id and keeps only `traceKept` of
 * the trace metadata and `kept` of the observation metadata; `dropping`
 * drops every record.
 */
const clients = {
  full: new Langfuse(components.convexLangfuse, {
    content: "full",
    onError: "throw",
    scores,
  }),
  none: new Langfuse(components.convexLangfuse, {
    content: "none",
    onError: "throw",
  }),
  redacting: new Langfuse(components.convexLangfuse, {
    content: "full",
    onError: "throw",
    redact: (record) =>
      record.kind === "observation"
        ? {
            ...record,
            trace: {
              ...record.trace,
              name: "redacted-trace",
              userId: undefined,
              metadata: { traceKept: record.trace.metadata?.traceKept },
            },
            observation: {
              ...record.observation,
              name: "redacted-observation",
              input: "[redacted]",
              metadata: { kept: record.observation.metadata?.kept },
            },
          }
        : record,
  }),
  dropping: new Langfuse(components.convexLangfuse, {
    content: "full",
    onError: "throw",
    redact: () => null,
  }),
};

const vClient = v.union(
  v.literal("full"),
  v.literal("none"),
  v.literal("redacting"),
  v.literal("dropping"),
);
const vJsonObject = v.record(v.string(), v.any());
const vRef = v.union(
  v.object({ key: v.string() }),
  v.object({ id: v.string() }),
);
const vTraceRef = v.union(
  v.object({ seed: v.string() }),
  v.object({ traceId: v.string() }),
);

const traceFields = {
  name: v.optional(v.string()),
  userId: v.optional(v.string()),
  sessionId: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  metadata: v.optional(vJsonObject),
  environment: v.optional(v.string()),
  release: v.optional(v.string()),
  experiment: v.optional(
    v.object({
      id: v.string(),
      name: v.string(),
      datasetId: v.optional(v.string()),
      itemId: v.optional(v.string()),
      rootObservation: v.optional(vRef),
      metadata: v.optional(vJsonObject),
    }),
  ),
};

const observationFields = {
  type: v.union(
    v.literal("span"),
    v.literal("generation"),
    v.literal("event"),
    v.literal("agent"),
    v.literal("tool"),
    v.literal("chain"),
    v.literal("retriever"),
    v.literal("evaluator"),
    v.literal("embedding"),
    v.literal("guardrail"),
  ),
  parent: v.optional(vRef),
  name: v.string(),
  startTime: v.optional(v.number()),
  endTime: v.optional(v.number()),
  completionStartTime: v.optional(v.number()),
  input: v.optional(v.any()),
  output: v.optional(v.any()),
  metadata: v.optional(vJsonObject),
  level: v.optional(
    v.union(
      v.literal("DEBUG"),
      v.literal("DEFAULT"),
      v.literal("WARNING"),
      v.literal("ERROR"),
    ),
  ),
  statusMessage: v.optional(v.string()),
  version: v.optional(v.string()),
  model: v.optional(v.string()),
  modelParameters: v.optional(vJsonObject),
  usage: v.optional(v.record(v.string(), v.number())),
  cost: v.optional(v.record(v.string(), v.number())),
  prompt: v.optional(v.object({ name: v.string(), version: v.number() })),
};

/** `trace(init).record(observations)` of one client; returns the ids. */
export const record = mutation({
  args: {
    client: vClient,
    trace: v.union(
      v.object({ seed: v.string(), ...traceFields }),
      v.object({ traceId: v.string(), ...traceFields }),
    ),
    observations: v.array(
      v.union(
        v.object({ key: v.string(), ...observationFields }),
        v.object({ id: v.string(), ...observationFields }),
      ),
    ),
  },
  handler: async (ctx, { client, trace, observations }) =>
    await clients[client].trace(trace).record(ctx, observations),
});

/** `score` of the full client, with an id and its timestamp. */
export const score = mutation({
  args: {
    score: v.union(
      v.object({ name: v.literal("contract-rating"), value: v.number() }),
      v.object({ name: v.literal("contract-helpful"), value: v.boolean() }),
      v.object({
        name: v.literal("contract-tone"),
        value: v.union(v.literal("formal"), v.literal("casual")),
      }),
    ),
    id: v.string(),
    timestamp: v.number(),
    trace: vTraceRef,
    observation: v.optional(vRef),
    comment: v.optional(v.string()),
    metadata: v.optional(vJsonObject),
  },
  handler: async (ctx, { score, ...target }) =>
    await clients.full.score(ctx, { ...score, ...target }),
});

export const deleteScore = mutation({
  args: { id: v.string() },
  handler: async (ctx, args) => await clients.full.deleteScore(ctx, args),
});

export const deleteTraces = mutation({
  args: { traces: v.array(vTraceRef) },
  handler: async (ctx, args) => await clients.full.deleteTraces(ctx, args),
});

export const syncScoreConfigs = action({
  args: {},
  handler: async (ctx) => await clients.full.syncScoreConfigs(ctx),
});

export const health = query({
  args: {},
  handler: async (ctx) => await clients.full.health(ctx),
});

export const syncPrompts = action({
  args: { names: v.array(v.string()) },
  handler: async (ctx, args) => await clients.full.prompts.sync(ctx, args),
});

export const getPrompt = query({
  args: { name: v.string() },
  handler: async (ctx, args) => await clients.full.prompts.get(ctx, args),
});

export const pinPrompt = mutation({
  args: {
    scope: v.string(),
    name: v.string(),
    fallback: v.optional(
      v.object({ type: v.literal("text"), prompt: v.string() }),
    ),
  },
  handler: async (ctx, args) => await clients.full.prompts.pin(ctx, args),
});
