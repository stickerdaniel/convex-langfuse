import { ConvexError, v } from "convex/values";
import { env, mutation } from "./_generated/server.js";
import {
  MAX_CALL_BYTES,
  MAX_CALL_RECORDS,
  MAX_ROW_BYTES,
} from "./constants.js";
import { gateClosed, pingExporter } from "./outbox.js";
import { exportConfig } from "./settings.js";
import {
  isEnvironmentName,
  isObservationId,
  isTraceId,
} from "../shared/ids.js";
import { byteLength, encodeSpan } from "../shared/otlp.js";
import {
  vObservation,
  vTraceContext,
  type Observation,
  type TraceContext,
} from "../shared/validators.js";

/** Codes `record` throws as `ConvexError` data. They carry no user content. */
export type RecordErrorCode =
  | "invalid_trace_id"
  | "invalid_observation_id"
  | "invalid_parent_id"
  | "invalid_environment"
  | "too_many_records"
  | "row_too_large"
  | "call_too_large";

function refuse(code: RecordErrorCode): never {
  throw new ConvexError(code);
}

function validate(trace: TraceContext, observations: Observation[]): void {
  if (observations.length > MAX_CALL_RECORDS) refuse("too_many_records");
  if (!isTraceId(trace.traceId)) refuse("invalid_trace_id");
  if (
    trace.environment !== undefined &&
    !isEnvironmentName(trace.environment)
  ) {
    refuse("invalid_environment");
  }
  for (const { id, parentId } of observations) {
    if (!isObservationId(id)) refuse("invalid_observation_id");
    if (parentId !== undefined && !isObservationId(parentId)) {
      refuse("invalid_parent_id");
    }
  }
}

/** Fills environment and release from the component env when absent. */
function withDefaults(trace: TraceContext): TraceContext {
  const environment = trace.environment ?? env.LANGFUSE_TRACING_ENVIRONMENT;
  const release = trace.release ?? env.LANGFUSE_RELEASE;
  return {
    ...trace,
    ...(environment ? { environment } : {}),
    ...(release ? { release } : {}),
  };
}

/**
 * Enqueues observations of one trace for export, in the caller's transaction.
 * Each observation is encoded once into an OTLP span and stored with one
 * outbox row; the exporter later sends exactly these bytes. One receipt
 * holds the number of rows and their bytes for the backlog count.
 *
 * Returns `reason: "disabled"` without writing when the component has no
 * export configuration, and `reason: "backlog"` without writing while the
 * admission gate is closed. Throws a `ConvexError` with a `RecordErrorCode`
 * for invalid ids, more than `MAX_CALL_RECORDS` observations, a span over
 * `MAX_ROW_BYTES` or spans over `MAX_CALL_BYTES` in total.
 *
 * Reads only the gate document and the batch-worker state, never the
 * exporter document, so it does not conflict with the running exporter.
 */
export const record = mutation({
  args: { trace: vTraceContext, observations: v.array(vObservation) },
  returns: v.object({
    enqueued: v.number(),
    dropped: v.optional(v.number()),
    reason: v.optional(v.union(v.literal("disabled"), v.literal("backlog"))),
  }),
  handler: async (ctx, { trace, observations }) => {
    if (exportConfig() === null) {
      return { enqueued: 0, reason: "disabled" as const };
    }
    if (await gateClosed(ctx)) {
      return {
        enqueued: 0,
        dropped: observations.length,
        reason: "backlog" as const,
      };
    }
    validate(trace, observations);
    if (observations.length === 0) return { enqueued: 0 };

    const stamped = withDefaults(trace);
    const spans = observations.map((observation) => {
      const data = encodeSpan(stamped, observation);
      const bytes = byteLength(data);
      if (bytes > MAX_ROW_BYTES) refuse("row_too_large");
      return { ref: `${trace.traceId}:${observation.id}`, data, bytes };
    });
    const total = spans.reduce((sum, span) => sum + span.bytes, 0);
    if (total > MAX_CALL_BYTES) refuse("call_too_large");

    const availableAt = Date.now();
    for (const { ref, data, bytes } of spans) {
      const payloadId = await ctx.db.insert("payloads", { data });
      await ctx.db.insert("outbox", {
        kind: "span",
        ref,
        bytes,
        availableAt,
        payloadId,
      });
    }
    await ctx.db.insert("receipts", {
      rows: spans.length,
      bytes: total,
      seq: ctx.db.vars.commitTs,
    });
    await pingExporter(ctx);
    return { enqueued: spans.length };
  },
});
