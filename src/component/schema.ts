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

export const vPromptType = v.union(v.literal("text"), v.literal("chat"));
export const vPromptSource = v.union(
  v.literal("langfuse"),
  v.literal("fallback"),
);

export const vSkillLabel = v.union(
  v.literal("production"),
  v.literal("latest"),
);
export type SkillLabel = Infer<typeof vSkillLabel>;
export const vSkillPriority = v.union(v.literal(0), v.literal(1));

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
   * One document per mutation that added rows of a counted kind
   * (`COUNTED_KINDS`) to the outbox: their number and summed `bytes`. A
   * replacement of a waiting score op writes zero rows and the byte
   * difference, which can be negative. A count step adds it to the `counter`
   * totals and deletes it, so the backlog is counted without reading outbox
   * rows.
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
     * Totals of every row of a counted kind that left the outbox and of its
     * `bytes`: accepted, dead-lettered, without payload, expired, or a
     * failed score op superseded by its waiting successor.
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
    /**
     * `definitionFingerprint` of the definition the config was synced for.
     * `scores.upsert` attaches `configId` only to a score that passes the
     * same fingerprint.
     */
    fingerprint: v.string(),
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

  /**
   * One resolved prompt with its provenance, immutable once written. Equal
   * content from another version, another source or another resolution
   * graph is another snapshot; the same result again reuses the row.
   */
  promptSnapshots: defineTable({
    /**
     * SHA-256 hex of the JSON array `[name, source, version ?? null, type,
     * prompt, config, resolutionGraph ?? null]`.
     */
    key: v.string(),
    name: v.string(),
    /** Absent for a fallback snapshot. */
    version: v.optional(v.number()),
    source: vPromptSource,
    type: vPromptType,
    /** The text, or canonical JSON of the chat message array. */
    prompt: v.string(),
    /** Canonical JSON. */
    config: v.string(),
    /** Canonical JSON: object keys sorted, dependency lists sorted. */
    resolutionGraph: v.optional(v.string()),
    fetchedAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_fetchedAt", ["fetchedAt"]),

  /** The snapshot a label of a prompt name resolves to, from the last refresh. */
  promptLabels: defineTable({
    name: v.string(),
    label: v.string(),
    snapshotId: v.id("promptSnapshots"),
  })
    .index("by_name_label", ["name", "label"])
    .index("by_snapshot", ["snapshotId"]),

  /**
   * The snapshot a version of a prompt name resolved to in the last refresh
   * that fetched it. A version that references another prompt's label can
   * resolve to other text over time. A pointer keeps no snapshot alive: the
   * retention sweep deletes it with its snapshot.
   */
  promptVersions: defineTable({
    name: v.string(),
    version: v.number(),
    snapshotId: v.id("promptSnapshots"),
  })
    .index("by_name_version", ["name", "version"])
    .index("by_snapshot", ["snapshotId"]),

  /** A tracked prompt name and its refresh fence. */
  promptNames: defineTable({
    /** At most `MAX_PROMPT_NAME_BYTES`. */
    name: v.string(),
    /**
     * Fences refreshes: only the refresh holding this token publishes. Every
     * reservation draws a new random one.
     */
    token: v.string(),
    /**
     * Other prompt names in the resolution graphs of its labels, sorted, at
     * most `MAX_PROMPT_DEPENDENCIES` of at most `MAX_PROMPT_NAME_BYTES` each.
     */
    dependsOn: v.array(v.string()),
    /** Last time a refresh was reserved. */
    attemptedAt: v.number(),
    /**
     * The snapshots the refresh holding `token` stored or reused, at most
     * `MAX_PROMPT_LABELS`, and the time of its first `store`. A reservation
     * and `publish` clear it.
     */
    staged: v.optional(
      v.object({
        at: v.number(),
        snapshotIds: v.array(v.id("promptSnapshots")),
      }),
    ),
    /** Fixed code of the last refresh's first failure. */
    error: v.optional(v.string()),
  })
    .index("by_name", ["name"])
    .index("by_attemptedAt", ["attemptedAt"]),

  /** The snapshot a scope uses for a prompt name until `expiresAt`. */
  promptPins: defineTable({
    /** At most `MAX_PROMPT_SCOPE_BYTES`. */
    scope: v.string(),
    name: v.string(),
    snapshotId: v.id("promptSnapshots"),
    expiresAt: v.number(),
  })
    .index("by_scope_name", ["scope", "name"])
    .index("by_expiresAt", ["expiresAt"])
    .index("by_snapshot", ["snapshotId"]),

  /**
   * Singleton, created by the first `prompts.sync` or webhook. Without it the
   * refresh tick does nothing.
   */
  promptSync: defineTable({
    lastListAt: v.optional(v.number()),
    lastWebhookAt: v.optional(v.number()),
  }),

  /**
   * One row per tracked prompt name, created and deleted with its
   * `promptNames` row and never changed in between. The `MAX_PROMPT_NAMES`
   * bound counts these rows: a count over `promptNames` would read rows that
   * running refreshes write, and conflict with them.
   */
  promptSlots: defineTable({ name: v.string() }).index("by_name", ["name"]),

  /**
   * A tracked skill name and its pending request. A request raises
   * `requested` and sets `eligibleAt`; the refresh that claimed the count it
   * finds clears the request on success.
   */
  skillNames: defineTable({
    name: v.string(),
    /** Raised by every request; a refresh compares it with its claim. */
    requested: v.number(),
    /**
     * When the pending request may be claimed; unset when none is pending.
     * A failure moves it to the retry time, a newer webhook moves it earlier.
     */
    eligibleAt: v.optional(v.number()),
    /** 0 for a webhook or `sync`, 1 for a listing or the daily refresh. */
    priority: vSkillPriority,
    /** When the pending request was first queued; the older goes first. */
    queuedAt: v.optional(v.number()),
    /** The refresh in flight: its run's generation and the count it serves. */
    claimed: v.optional(
      v.object({ generation: v.number(), requested: v.number() }),
    ),
    /** Consecutive failed refreshes, for the backoff. */
    failures: v.number(),
    /** Fixed code of the last refresh's failure. */
    error: v.optional(v.string()),
    /** When the tick queues the next daily refresh. */
    fullDueAt: v.number(),
    /** The last refresh that succeeded. */
    lastFullAt: v.optional(v.number()),
    /** Named by `sync({ names })`: kept while Langfuse has no such skill. */
    watch: v.boolean(),
  })
    .index("by_name", ["name"])
    .index("by_priority_eligibleAt", ["priority", "eligibleAt"])
    .index("by_priority_queuedAt", ["priority", "queuedAt"])
    .index("by_fullDueAt", ["fullDueAt"]),

  /**
   * One row per tracked skill name, created and deleted with its
   * `skillNames` row and never changed in between. The `MAX_SKILL_NAMES`
   * bound counts these rows, as `promptSlots` does for prompts.
   */
  skillSlots: defineTable({ name: v.string() }).index("by_name", ["name"]),

  /**
   * The version a label of a skill name points to. `version` and `remoteId`
   * copy the version's, so the listing compares without reading versions.
   */
  skillLabels: defineTable({
    name: v.string(),
    label: vSkillLabel,
    versionId: v.id("skillVersions"),
    version: v.number(),
    remoteId: v.string(),
  }).index("by_name_label", ["name", "label"]),

  /**
   * One fetched skill version. Its files are written in the same
   * transaction, so a stored version is complete until the sweep marks it
   * `deleting`.
   */
  skillVersions: defineTable({
    name: v.string(),
    /** The Langfuse id of the version; a recreated version has another. */
    remoteId: v.string(),
    version: v.number(),
    description: v.string(),
    /** Canonical JSON of the frontmatter object. */
    frontmatter: v.string(),
    /** Sorted by path. `sha256` is the base64 SHA-256 of the content. */
    files: v.array(v.object({ path: v.string(), sha256: v.string() })),
    /** Hex SHA-256 of the JSON array of `[path, sha256]` pairs. */
    snapshotId: v.string(),
    storedAt: v.number(),
    /** The first time a label pointed to it; orders recreated versions. */
    publishedAt: v.optional(v.number()),
    /** Set while no label points to it. */
    releasedAt: v.optional(v.number()),
    /** Set by the sweep, which deletes its files and then the row. */
    deleting: v.optional(v.boolean()),
  })
    .index("by_remoteId", ["remoteId"])
    .index("by_name_version", ["name", "version"])
    .index("by_releasedAt", ["releasedAt"])
    .index("by_publishedAt_storedAt", ["publishedAt", "storedAt"]),

  /** One file of one skill version. */
  skillFiles: defineTable({
    versionId: v.id("skillVersions"),
    path: v.string(),
    content: v.string(),
  }).index("by_version", ["versionId"]),

  /**
   * Singleton state of the skill fetch loop, created by the first
   * `skills.dispatch`. Only `skills.dispatch` and `skills.advance` write it.
   */
  skillFetcher: defineTable({
    /** Fences runs: only the run with the current generation writes. */
    generation: v.number(),
    leaseExpiresAt: v.optional(v.number()),
    runStartedAt: v.optional(v.number()),
    /** The earliest start of the next request. */
    nextRequestAt: v.number(),
    /** Set after a 429: no request starts before it. */
    cooldownUntil: v.optional(v.number()),
    /** The listing walk in progress. */
    list: v.optional(
      v.object({
        /** The next page to fetch, from 1. */
        page: v.number(),
        startedAt: v.number(),
        /** Tracked names the pages read so far listed. */
        seen: v.array(v.string()),
        /** Set once a page listed a name mode `all` could not track. */
        overflow: v.optional(v.boolean()),
      }),
    ),
    /** When the last walk ended. */
    lastListAt: v.optional(v.number()),
    /** Fixed code of the last walk that ended early. */
    listError: v.optional(v.string()),
    /**
     * Set when a walk in mode `all` listed a name over the bound. Kept by a
     * walk that ended early; cleared by a complete walk that found none.
     */
    overflow: v.optional(v.boolean()),
    /** The last background request, for the background share. */
    lastBackgroundAt: v.optional(v.number()),
    /** What the last background request fetched; the next one alternates. */
    lastBackgroundKind: v.optional(
      v.union(v.literal("list"), v.literal("name")),
    ),
  }),

  /**
   * Singleton, written only by `skills.sync`. `all` tracks every skill of the
   * project, `names` the names `sync` was given. Without it the skill cache
   * is off.
   */
  skillSync: defineTable({
    mode: v.union(v.literal("all"), v.literal("names")),
  }),

  /**
   * Singleton, written only by `skills.wake`. `skills.nextWork` reads it, so
   * a loop transaction that read the work before a wake committed is run
   * again.
   */
  skillWake: defineTable({ at: v.number() }),
});
