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
 * which leaves room for the environment and release the component stamps,
 * and below the 5 MiB argument limit of a Node action.
 */
export const CLIENT_CALL_BYTES = 3 * MIB;
