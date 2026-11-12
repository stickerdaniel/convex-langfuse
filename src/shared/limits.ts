// Bounds of the component's enqueue calls. The component enforces them; the
// client splits and refuses before it calls the component.

const KIB = 1024;
const MIB = 1024 * KIB;

/** Encoded span bytes per outbox row. A document holds at most 1 MiB. */
export const MAX_ROW_BYTES = 900 * KIB;
/**
 * Encoded span bytes per `tracing.record` call, measured without the
 * environment and release the component stamps. With the largest defaults a
 * call stores about 6.7 MB, below the 16 MiB a transaction writes.
 */
export const MAX_CALL_BYTES = 4 * MIB;
/** Observations per `tracing.record` call. */
export const MAX_CALL_RECORDS = 50;
/**
 * Encoded span bytes the client puts into one call, below `MAX_CALL_BYTES`.
 * The client sends only what the encoder exports, so the arguments of a call
 * stay close to this size and far below Convex's 16 MiB argument limit.
 */
export const CLIENT_CALL_BYTES = 3 * MIB;
/** Tags per trace: the elements Convex accepts in an array. */
export const MAX_TAGS = 8_192;
/** Entries of one usage or cost record: the fields Convex accepts in an object. */
export const MAX_DETAIL_KEYS = 1_024;

/** UTF-8 bytes of a score id. */
export const MAX_SCORE_ID_BYTES = 128;
/** Trace ids per `traces.remove` call, and so per deletion request. */
export const MAX_DELETE_IDS = 100;
