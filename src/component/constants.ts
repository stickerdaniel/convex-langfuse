// Bounds and timings of the outbox and the exporter.

const KIB = 1024;
const MIB = 1024 * KIB;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export {
  MAX_CALL_BYTES,
  MAX_CALL_RECORDS,
  MAX_DELETE_IDS,
  MAX_ROW_BYTES,
  MAX_SCORE_ID_BYTES,
} from "../shared/limits.js";
/** UTF-8 bytes of an outbox `ref`. */
export const MAX_REF_BYTES = 128;

/** Spans per export request. */
export const BATCH_MAX_SPANS = 50;
/** Summed span bytes per export request. A larger single row is sent alone. */
export const BATCH_MAX_BYTES = 512 * KIB;
/** Outbox rows one claim reads. */
export const CLAIM_WINDOW = 100;

/** How long a claim stays valid without a renewing `advance`. */
export const LEASE_MS = 2 * MINUTE;
/** Wall time after which a run stops claiming and hands back to the loop. */
export const RUN_BUDGET_MS = MINUTE;
/** Timeout of one export request. */
export const REQUEST_TIMEOUT_MS = 20 * SECOND;

export const BACKOFF_BASE_MS = SECOND;
/** Backoff cap after a transient failure. */
export const BACKOFF_CAP_MS = 5 * MINUTE;
/** Backoff cap after a configuration failure. */
export const CONFIG_BACKOFF_CAP_MS = 30 * MINUTE;
/** Consecutive dead-lettered spans after which a rejection counts as config. */
export const BREAKER_REJECTED_SPANS = 20;

/**
 * Shortest time between the starts of two count chains. While the exporter
 * loop runs, the first `dispatch` after this interval starts the next chain.
 */
export const MEASURE_INTERVAL_MS = MINUTE;
/**
 * Receipts one count step consumes. One receipt stands for the rows of one
 * enqueue, up to `MAX_CALL_RECORDS` rows or `RETRY_DEAD_LETTERS_MAX` moved
 * dead letters.
 */
export const COUNT_BATCH = 1_000;
/** Most dead letters one `retryDeadLetters` call moves back to the outbox. */
export const RETRY_DEAD_LETTERS_MAX = 500;
/** The gate closes above this many pending rows. */
export const PENDING_ROWS_THRESHOLD = 25_000;
/** The gate closes above this many pending payload bytes. */
export const PENDING_BYTES_THRESHOLD = 256 * MIB;

/** Pending rows older than this expire. */
export const MAX_PENDING_AGE_MS = 72 * HOUR;
/** Dead letters older than this are deleted. */
export const DEAD_LETTER_RETENTION_MS = 7 * 24 * HOUR;
/** Rows per table one retention sweep deletes. */
export const RETENTION_BATCH = 200;
/**
 * Bytes one retention sweep spends: the payloads of outbox rows and dead
 * letters it deletes, and the prompt snapshots it reads and deletes. Convex
 * reads a document to delete it and charges its size to the transaction's
 * reads, at most 16 MiB. Half of that leaves room for the rows the sweep
 * reads besides payloads and snapshots and for the document overhead that
 * `bytes` does not count.
 */
export const RETENTION_BATCH_BYTES = 8 * MIB;

/** Counts in `health` are lower bounds capped at this value. */
export const HEALTH_COUNT_CAP = 1_000;

/**
 * Shortest time between two submissions for one score id. Around midnight
 * UTC Langfuse queues a score it accepted for 15 s before it applies it
 * (`LANGFUSE_INGESTION_QUEUE_DELAY_MS`), and applying it can take longer;
 * a deletion is queued without that delay, so a deletion sent soon after a
 * write can overtake it. The 30 s are load shaping that lowers the chance of
 * an overlap, not a guarantee of order.
 */
export const SCORE_SETTLE_MS = 30 * SECOND;
/** Timeout of one API op request. */
export const API_TIMEOUT_MS = 10 * SECOND;
/** How far a route error (404, 405, 3xx) moves an API op ahead. */
export const DEFERRED_MS = 30 * MINUTE;
/**
 * Trace deletion requests in the outbox and the dead letters together at
 * which `traces.remove` throws.
 */
export const MAX_PENDING_DELETES = 1_000;
/** `scoreKeys` rows without pointers are deleted after this idle time. */
export const SCORE_KEY_RETENTION_MS = 24 * HOUR;
/** A synced score config is attached for this long after its sync. */
export const CONFIG_FRESH_MS = 3 * HOUR;
/**
 * A config sync that started this recently makes another call return
 * `running`. A sync starts a request only before `CONFIG_SYNC_DEADLINE_MS`,
 * and a request ends within `API_TIMEOUT_MS`: 4 min + 10 s is shorter than
 * this lease, so no creation of an old sync overlaps a successor and
 * Langfuse gets no duplicate configs from two syncs.
 */
export const CONFIG_SYNC_LEASE_MS = 5 * MINUTE;
/** Pages of `CONFIG_PAGE_LIMIT` configs one sync reads at most. */
export const CONFIG_SYNC_MAX_PAGES = 50;
/** Configs per page of `GET /api/public/score-configs`, the server maximum. */
export const CONFIG_PAGE_LIMIT = 100;
/**
 * Wall time after which one sync starts no request: no page read and no
 * config creation. A sync that reaches it returns `incomplete`.
 */
export const CONFIG_SYNC_DEADLINE_MS = 4 * MINUTE;
/** Score definitions per config sync. */
export const MAX_SCORE_DEFINITIONS = 500;

/** Name of the batch-worker loop that drives the exporter. */
export const WORKER_NAME = "export";

/**
 * A tracked prompt name is due for a refresh once its last attempt is this
 * old. The tick runs every 5 minutes and reserves every due name, so a name
 * is reserved and scheduled no later than the first tick after it became
 * due plus `MAX_PROMPT_NAMES` × `PROMPT_REFRESH_SPACING_MS` (99.8 s).
 */
export const PROMPT_REFRESH_INTERVAL_MS = 13 * MINUTE;
/** Time between the starts of two refreshes one tick schedules. */
export const PROMPT_REFRESH_SPACING_MS = 200;
/**
 * Longest a refresh action can run: the action timeout of the Convex
 * backend (`V8_ACTION_USER_TIMEOUT`). Until then, a reserved refresh that
 * has not published counts as running.
 */
export const PROMPT_REFRESH_MAX_MS = 30 * MINUTE;
/** The tick lists the project's prompts again once the last listing is this old. */
export const PROMPT_LIST_INTERVAL_MS = HOUR;
/** Pages of `PROMPT_PAGE_LIMIT` names one listing reads at most. */
export const PROMPT_LIST_MAX_PAGES = 50;
/** Names per page of `GET /api/public/v2/prompts`, the server maximum. */
export const PROMPT_PAGE_LIMIT = 100;
/** Prompt names the cache tracks at most. */
export const MAX_PROMPT_NAMES = 500;
/**
 * UTF-8 bytes of a tracked prompt name and of a name in `dependsOn`. With
 * `MAX_PROMPT_DEPENDENCIES`, a `promptNames` row has at most about 9 KiB, so
 * the tick and the webhook can read all `MAX_PROMPT_NAMES` rows.
 */
export const MAX_PROMPT_NAME_BYTES = 256;
/** Names in the `dependsOn` of one tracked name. */
export const MAX_PROMPT_DEPENDENCIES = 32;
/** Labels of one prompt name a refresh fetches at most, in sorted order. */
export const MAX_PROMPT_LABELS = 50;
/** Labels a refresh fetches at once and stores in one mutation. */
export const PROMPT_STEP_LABELS = 4;
/** Summed UTF-8 bytes of prompt, config and resolution graph of a snapshot. */
export const MAX_SNAPSHOT_BYTES = 900 * KIB;
/**
 * Bytes of a snapshot document: `MAX_SNAPSHOT_BYTES` of content plus its
 * key, its name of at most `MAX_PROMPT_NAME_BYTES` and the small fields.
 */
export const MAX_SNAPSHOT_DOCUMENT_BYTES = MAX_SNAPSHOT_BYTES + KIB;
/** Default lifetime of a pin. */
export const PIN_TTL_MS = 7 * 24 * HOUR;
/** Unreferenced snapshots younger than this survive the retention sweep. */
export const SNAPSHOT_GRACE_MS = HOUR;
/** Largest distance between a webhook's signed timestamp and now. */
export const WEBHOOK_TOLERANCE_MS = 5 * MINUTE;
/** Timeout of one prompt API request. */
export const PROMPT_TIMEOUT_MS = 10 * SECOND;
