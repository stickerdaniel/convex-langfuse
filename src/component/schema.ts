import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  traces: defineTable({
    traceId: v.string(),
    name: v.string(),
    userId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    metadata: v.optional(v.string()),
    release: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_traceId", ["traceId"])
    .index("by_userId", ["userId"])
    .index("by_sessionId", ["sessionId"]),

  observations: defineTable({
    observationId: v.string(),
    traceId: v.string(),
    type: v.union(
      v.literal("span"),
      v.literal("generation"),
      v.literal("event"),
      v.literal("embedding"),
      v.literal("agent"),
      v.literal("tool"),
      v.literal("chain"),
      v.literal("retriever"),
      v.literal("guardrail"),
      v.literal("evaluator"),
    ),
    name: v.string(),
    input: v.optional(v.string()),
    output: v.optional(v.string()),
    model: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    level: v.union(
      v.literal("DEBUG"),
      v.literal("DEFAULT"),
      v.literal("WARNING"),
      v.literal("ERROR"),
    ),
    statusMessage: v.optional(v.string()),
    metadata: v.optional(v.string()),
    startedAt: v.number(),
    endedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_observationId", ["observationId"])
    .index("by_traceId", ["traceId"]),

  scores: defineTable({
    scoreId: v.string(),
    traceId: v.string(),
    name: v.string(),
    value: v.number(),
    comment: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_scoreId", ["scoreId"])
    .index("by_traceId", ["traceId"]),

  // Pending exports. The payload lives in its own table, so claims, backlog
  // counting and retention read only these small rows. Every deletion of
  // an `outbox` or `deadLetters` row deletes its `payloads` row in the same
  // mutation.
  outbox: defineTable({
    kind: v.union(v.literal("span")),
    /** `<traceId>:<spanId>`, at most `MAX_REF_BYTES`. */
    ref: v.string(),
    /** UTF-8 bytes of the payload. */
    bytes: v.number(),
    availableAt: v.number(),
    payloadId: v.id("payloads"),
    /** Commit timestamp of the insert; the backlog is counted in this order. */
    seq: v.commitTs(),
  })
    .index("by_availableAt", ["availableAt"])
    .index("by_seq", ["seq"]),

  /** One encoded OTLP span, stored once and sent byte-identically. */
  payloads: defineTable({ data: v.string() }),

  deadLetters: defineTable({
    kind: v.union(v.literal("span")),
    ref: v.string(),
    bytes: v.number(),
    payloadId: v.id("payloads"),
    /** Fixed code, never response text. */
    reason: v.string(),
    status: v.optional(v.number()),
    failedAt: v.number(),
  }).index("by_failedAt", ["failedAt"]),

  /** Singleton exporter state, created by the first `dispatch`. */
  exporter: defineTable({
    /** Fences runs: only the run with the current generation writes. */
    generation: v.number(),
    leaseExpiresAt: v.optional(v.number()),
    runStartedAt: v.optional(v.number()),
    /** Outbox rows of the batch in flight. */
    claimed: v.array(v.id("outbox")),
    backoffUntil: v.optional(v.number()),
    consecutiveFailures: v.number(),
    consecutiveRejected: v.number(),
    /** Rows still to be sent one at a time after a rejected batch. */
    isolateRemaining: v.number(),
    /** When the last count step was scheduled. */
    measuredAt: v.optional(v.number()),
    /** Outbox rows with `seq` up to this value are in the pending counters. */
    countedThrough: v.optional(v.int64()),
    /** Counted pending span rows and their payload bytes. */
    pendingRows: v.number(),
    pendingBytes: v.number(),
    lastAcceptedAt: v.optional(v.number()),
    lastError: v.optional(
      v.object({
        at: v.number(),
        class: v.string(),
        status: v.optional(v.number()),
      }),
    ),
    accepted: v.number(),
    deadLettered: v.number(),
    expired: v.number(),
  }),

  /** Singleton admission gate. A missing document means accepting. */
  gate: defineTable({ accepting: v.boolean(), changedAt: v.number() }),
});
