import { v, type Infer } from "convex/values";

// Shapes that cross the app/component boundary. Fields documented as
// "JSON object string" arrive already serialized by the caller.

export const vObservationType = v.union(
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
);

export const vLevel = v.union(
  v.literal("DEBUG"),
  v.literal("DEFAULT"),
  v.literal("WARNING"),
  v.literal("ERROR"),
);

/** Trace-level context, written on every span of the trace. */
export const vTraceContext = v.object({
  traceId: v.string(),
  name: v.optional(v.string()),
  userId: v.optional(v.string()),
  sessionId: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  /** JSON object string. */
  metadata: v.optional(v.string()),
  environment: v.optional(v.string()),
  release: v.optional(v.string()),
  experiment: v.optional(
    v.object({
      id: v.string(),
      name: v.string(),
      datasetId: v.optional(v.string()),
      itemId: v.optional(v.string()),
      rootObservationId: v.optional(v.string()),
      /** JSON object string. */
      metadata: v.optional(v.string()),
    }),
  ),
});

/** One observation, encoded as one OTLP span. */
export const vObservation = v.object({
  id: v.string(),
  parentId: v.optional(v.string()),
  type: vObservationType,
  name: v.string(),
  /** Epoch milliseconds. */
  startTime: v.number(),
  /** Epoch milliseconds. */
  endTime: v.number(),
  /** Epoch milliseconds. */
  completionStartTime: v.optional(v.number()),
  input: v.optional(v.string()),
  output: v.optional(v.string()),
  /** JSON object string. */
  metadata: v.optional(v.string()),
  level: v.optional(vLevel),
  statusMessage: v.optional(v.string()),
  version: v.optional(v.string()),
  model: v.optional(v.string()),
  /** JSON object string. */
  modelParameters: v.optional(v.string()),
  usage: v.optional(v.record(v.string(), v.number())),
  cost: v.optional(v.record(v.string(), v.number())),
  prompt: v.optional(
    v.object({ name: v.string(), version: v.optional(v.number()) }),
  ),
});

export type TraceContext = Infer<typeof vTraceContext>;
export type Observation = Infer<typeof vObservation>;
export type ObservationType = Infer<typeof vObservationType>;
export type Level = Infer<typeof vLevel>;
