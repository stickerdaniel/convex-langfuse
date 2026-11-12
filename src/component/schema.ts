import { defineSchema, defineTable } from "convex/server";
import { v, type Infer } from "convex/values";

/**
 * What an outbox row holds. `span` rows go out in OTLP batches; every other
 * kind is an API op that goes out alone, as one request.
 */
const apiKinds = [
  v.literal("scoreCreate"),
  v.literal("scoreDelete"),
  v.literal("traceDelete"),
] as const;
export const vApiKind = v.union(...apiKinds);
export const vKind = v.union(v.literal("span"), ...apiKinds);
export type Kind = Infer<typeof vKind>;

export const vScoreDataType = v.union(
  v.literal("BOOLEAN"),
  v.literal("NUMERIC"),
  v.literal("CATEGORICAL"),
);

export default defineSchema({
  // Pending exports. The payload lives in its own table, so claims and
  // retention read only these small rows. Every deletion of an `outbox` or
  // `deadLetters` row deletes its `payloads` row in the same mutation.
  outbox: defineTable({
    kind: vKind,
    /**
     * At most `MAX_REF_BYTES`: `<traceId>:<spanId>` for a span, the score id
     * for a score op, the first trace id for a trace deletion request.
     */
    ref: v.string(),
    /** UTF-8 bytes of the payload. */
    bytes: v.number(),
    availableAt: v.number(),
    payloadId: v.id("payloads"),
  })
    .index("by_availableAt", ["availableAt"])
    .index("by_kind", ["kind"]),

  /**
   * The bytes one outbox row sends: an encoded OTLP span, a score request
   * body, a trace deletion request body, or "" for a score deletion. Stored
   * once and sent byte-identically.
   */
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
    kind: vKind,
    ref: v.string(),
    bytes: v.number(),
    payloadId: v.id("payloads"),
    /** Fixed code, never response text. */
    reason: v.string(),
    status: v.optional(v.number()),
    failedAt: v.number(),
  }).index("by_kind_failedAt", ["kind", "failedAt"]),

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

  /**
   * Per score id: the pending ops of that id, so they are coalesced and
   * submitted one at a time. Enqueues replace `queued`; `advance` moves an op
   * from `queued` to `inFlight` when it claims it and clears `inFlight` with
   * the outcome.
   */
  scoreKeys: defineTable({
    scoreId: v.string(),
    /** The one replaceable op waiting to be sent. */
    queued: v.optional(v.id("outbox")),
    /** The op of the batch in flight; never replaced. */
    inFlight: v.optional(v.id("outbox")),
    lastAcceptedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_scoreId", ["scoreId"])
    .index("by_updatedAt", ["updatedAt"]),

  /** The Langfuse score config each defined name uses, from the last sync. */
  scoreConfigs: defineTable({
    name: v.string(),
    configId: v.string(),
    dataType: vScoreDataType,
    syncedAt: v.number(),
  }).index("by_name", ["name"]),

  /** Singleton state of the score config sync, created by the first sync. */
  scoreConfigSync: defineTable({
    /** Fences syncs: only the sync with the current generation applies. */
    generation: v.number(),
    /** Set while a sync runs. */
    startedAt: v.optional(v.number()),
    /** JSON of the definitions of the last sync call, for the hourly resync. */
    definitions: v.string(),
    lastResult: v.optional(v.union(v.literal("ok"), v.literal("incomplete"))),
  }),
});
