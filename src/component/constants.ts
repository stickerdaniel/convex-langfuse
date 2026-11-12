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
 * Payload bytes one retention sweep deletes, outbox and dead letters
 * together. Convex reads a document to delete it and charges its size to the
 * transaction's reads, at most 16 MiB. Half of that leaves room for the rows
 * the sweep reads besides the payloads and for the document overhead that
 * `bytes` does not count.
 */
export const RETENTION_BATCH_BYTES = 8 * MIB;

/** Counts in `health` are lower bounds capped at this value. */
export const HEALTH_COUNT_CAP = 1_000;

/**
 * Shortest time between two submissions for one score id. Langfuse applies a
 * score up to 15 s after it accepted it (`LANGFUSE_INGESTION_QUEUE_DELAY_MS`,
 * used for scores around the UTC date boundary) but a deletion at once, so a
 * deletion sent sooner can overtake the write it follows.
 */
export const SCORE_SETTLE_MS = 30 * SECOND;
/** Timeout of one API op request. */
export const API_TIMEOUT_MS = 10 * SECOND;
/** How far a route error (404, 405, 3xx) moves an API op ahead. */
export const DEFERRED_MS = 30 * MINUTE;
/** Pending trace deletion requests at which `traces.remove` throws. */
export const MAX_PENDING_DELETES = 1_000;
/** `scoreKeys` rows without pointers are deleted after this idle time. */
export const SCORE_KEY_RETENTION_MS = 24 * HOUR;
/** A synced score config is attached for this long after its sync. */
export const CONFIG_FRESH_MS = 3 * HOUR;
/** A config sync that started this recently makes another call return `running`. */
export const CONFIG_SYNC_LEASE_MS = 5 * MINUTE;
/** Pages of `CONFIG_PAGE_LIMIT` configs one sync reads at most. */
export const CONFIG_SYNC_MAX_PAGES = 50;
/** Configs per page of `GET /api/public/score-configs`, the server maximum. */
export const CONFIG_PAGE_LIMIT = 100;
/** Wall time within which one sync must read every page. */
export const CONFIG_SYNC_DEADLINE_MS = 4 * MINUTE;
/** Score definitions per config sync. */
export const MAX_SCORE_DEFINITIONS = 500;

/** Name of the batch-worker loop that drives the exporter. */
export const WORKER_NAME = "export";
