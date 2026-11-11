// Bounds and timings of the outbox and the exporter.

const KIB = 1024;
const MIB = 1024 * KIB;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Encoded span bytes per outbox row. A document holds at most 1 MiB. */
export const MAX_ROW_BYTES = 900 * KIB;
/** Encoded span bytes per `tracing.record` call, a quarter of a transaction. */
export const MAX_CALL_BYTES = 4 * MIB;
/** Observations per `tracing.record` call. */
export const MAX_CALL_RECORDS = 50;
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

/** Longest gap between two scheduled count steps while rows are pending. */
export const MEASURE_INTERVAL_MS = MINUTE;
/** Outbox rows one count step reads. */
export const COUNT_BATCH = 1_000;
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

/** Counts in `health` are lower bounds capped at this value. */
export const HEALTH_COUNT_CAP = 1_000;

/** Name of the batch-worker loop that drives the exporter. */
export const WORKER_NAME = "export";
