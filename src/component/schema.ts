import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Pending exports. The payload lives in its own table, so claims and
  // retention read only these small rows. Every deletion of an `outbox` or
  // `deadLetters` row deletes its `payloads` row in the same mutation.
  outbox: defineTable({
    kind: v.union(v.literal("span")),
    /** `<traceId>:<spanId>`, at most `MAX_REF_BYTES`. */
    ref: v.string(),
    /** UTF-8 bytes of the payload. */
    bytes: v.number(),
    availableAt: v.number(),
    payloadId: v.id("payloads"),
  }).index("by_availableAt", ["availableAt"]),

  /** One encoded OTLP span, stored once and sent byte-identically. */
  payloads: defineTable({ data: v.string() }),

  /**
   * One document per mutation that added span rows to the outbox: their
   * number and summed `bytes`. A count step adds it to the `counter` totals
   * and deletes it, so the backlog is counted without reading outbox rows.
   */
  receipts: defineTable({
    rows: v.number(),
    bytes: v.number(),
    /** Commit timestamp of the insert; receipts are consumed in this order. */
    seq: v.commitTs(),
  }).index("by_seq", ["seq"]),

  /**
   * Singleton state of the count chain, created by the first `scheduleCount`.
   * Only `scheduleCount` and the count steps write it, never `advance`.
   * The pending backlog is `addedRows` minus `exporter.removedRows`,
   * and the same for bytes.
   */
  counter: defineTable({
    /** Totals of every consumed receipt. */
    addedRows: v.number(),
    addedBytes: v.number(),
    /** Receipts with a smaller `seq` are consumed; a step scans from here. */
    countedFrom: v.optional(v.int64()),
    /** Number of the current count chain. A step of another chain stops. */
    chain: v.number(),
    /** When the current chain last scheduled a step. */
    steppedAt: v.optional(v.number()),
  }),

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
    /**
     * Totals of every span row that left the outbox and of its `bytes`:
     * accepted, dead-lettered, without payload or expired.
     */
    removedRows: v.number(),
    removedBytes: v.number(),
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
