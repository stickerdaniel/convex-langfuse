// Bounds of one `tracing.record` call. The component enforces them; the
// client splits and refuses before it calls the component.

const KIB = 1024;
const MIB = 1024 * KIB;

/** Encoded span bytes per outbox row. A document holds at most 1 MiB. */
export const MAX_ROW_BYTES = 900 * KIB;
/** Encoded span bytes per `tracing.record` call, a quarter of a transaction. */
export const MAX_CALL_BYTES = 4 * MIB;
/** Observations per `tracing.record` call. */
export const MAX_CALL_RECORDS = 50;
/**
 * Encoded span bytes the client puts into one call. Below `MAX_CALL_BYTES`,
 * which leaves room for the environment and release the component stamps.
 * The client sends only what the encoder exports, so the arguments of a call
 * stay close to this size and far below Convex's 16 MiB argument limit.
 */
export const CLIENT_CALL_BYTES = 3 * MIB;
/** Tags per trace. Convex accepts 8,192 array elements. */
export const MAX_TAGS = 1_000;
/** Entries of one usage or cost record. Convex accepts 1,024 object fields. */
export const MAX_DETAIL_KEYS = 1_000;
