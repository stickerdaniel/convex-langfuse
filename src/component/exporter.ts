// The exporter: one fenced run at a time drains the outbox to Langfuse.
//
// A batch-worker loop named `WORKER_NAME` calls `nextWork` on a stale
// snapshot and hands its batch to `dispatch`. `dispatch` starts a run by
// bumping `generation` and taking a lease, or tells the loop how long to wait.
// The run action alternates between `advance`, which applies the previous
// request's outcome and claims the next batch, and one HTTP request per batch.
// A batch is either a run of consecutive span rows, sent as one OTLP request,
// or exactly one API op (score upsert, score deletion, trace deletion), sent
// as one request to the Langfuse public API. A run that dies leaves its lease
// to expire; the next generation then claims the same rows and sends the
// same bytes again.

import { defineBatchWorkerValidators } from "@convex-dev/batch-worker";
import { v, type Infer } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server.js";
import {
  API_TIMEOUT_MS,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BATCH_MAX_BYTES,
  BATCH_MAX_SPANS,
  BREAKER_REJECTED_SPANS,
  CLAIM_WINDOW,
  CONFIG_BACKOFF_CAP_MS,
  DEFERRED_MS,
  LEASE_MS,
  REQUEST_TIMEOUT_MS,
  RUN_BUDGET_MS,
  WORKER_NAME,
} from "./constants.js";
import {
  forgetOp,
  markAccepted,
  markFailed,
  markInFlight,
} from "./scoreKeys.js";
import { vApiKind } from "./schema.js";
import {
  getExporter,
  getOrCreateExporter,
  gateClosed,
  pingExporter,
  scheduleCount,
  scheduleReconcile,
  withRemoved,
  type Removed,
} from "./outbox.js";
import { basicAuth, exportConfig, type ExportConfig } from "./settings.js";
import { buildExportBody } from "../shared/otlp.js";
import { VERSION } from "../shared/version.js";

/** Poll interval of the loop while a run holds the lease. */
const LEASE_POLL_MS = 2_000;
/** Longest wait of the loop during a backoff, so counting keeps running. */
const BACKOFF_POLL_MS = 60_000;

const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } =
  defineBatchWorkerValidators({
    batch: {
      op: v.union(v.literal("start"), v.literal("wait")),
      ms: v.optional(v.number()),
    },
  });

export const vReport = v.object({
  /** `deferred` is a route error of an API op; spans never get it. */
  outcome: v.union(
    v.literal("accepted"),
    v.literal("rejected"),
    v.literal("transient"),
    v.literal("config"),
    v.literal("deferred"),
  ),
  status: v.optional(v.number()),
  retryAfterMs: v.optional(v.number()),
});
/** Outcome of one export request. */
export type Report = Infer<typeof vReport>;

const vOp = v.object({
  kind: vApiKind,
  /** The score id of a score op. */
  ref: v.string(),
  /** The request body; empty for a score deletion. */
  body: v.string(),
});
/** One API op, as `advance` hands it to the run. */
export type Op = Infer<typeof vOp>;

const vStep = v.union(
  v.object({ done: v.literal(true) }),
  v.object({ done: v.literal(false), spans: v.array(v.string()) }),
  v.object({ done: v.literal(false), op: vOp }),
);
type Step = Infer<typeof vStep>;

function leaseActive(exporter: Doc<"exporter"> | null, now: number): boolean {
  return (exporter?.leaseExpiresAt ?? 0) > now;
}

function backoffRemaining(
  exporter: Doc<"exporter"> | null,
  now: number,
): number {
  return Math.max(0, (exporter?.backoffUntil ?? 0) - now);
}

/** The work query of the batch-worker loop. Runs on a stale snapshot. */
export const nextWork = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx) => {
    const now = Date.now();
    const exporter = await getExporter(ctx);
    if (leaseActive(exporter, now)) {
      return { batch: { op: "wait" as const, ms: LEASE_POLL_MS } };
    }
    const first = await ctx.db
      .query("outbox")
      .withIndex("by_availableAt")
      .first();
    if (!first) return { kind: "idle" as const };
    const backoff = backoffRemaining(exporter, now);
    if (backoff > 0) {
      return {
        batch: {
          op: "wait" as const,
          ms: Math.min(backoff, BACKOFF_POLL_MS),
        },
      };
    }
    if (first.availableAt <= now) return { batch: { op: "start" as const } };
    return { kind: "idle" as const, timeoutMs: first.availableAt - now };
  },
});

/**
 * Ids of the first `CLAIM_WINDOW` rows that are available at `now`. `advance`
 * runs it on a stale snapshot and reads the rows by id afterwards. A range
 * read inside `advance` would end at its own `Date.now()`, and every enqueue
 * that commits into that range would force a retry with a later bound.
 */
export const claimable = internalQuery({
  args: { now: v.number() },
  returns: v.array(v.id("outbox")),
  handler: async (ctx, { now }) => {
    const rows = await ctx.db
      .query("outbox")
      .withIndex("by_availableAt", (q) => q.lte("availableAt", now))
      .take(CLAIM_WINDOW);
    return rows.map((row) => row._id);
  },
});

/**
 * The worker mutation of the batch-worker loop. Starts a count chain when
 * none stepped within `MEASURE_INTERVAL_MS`, then re-reads the exporter
 * state, because `nextWork` saw a stale snapshot. It reads no outbox range,
 * so enqueues do not conflict with the loop. Always returns a `debounceMs`,
 * so the loop stays `running` and an enqueue `ping` stays read-only.
 *
 * A start after a run died treats a score op still listed in `claimed` like
 * a transient failure, so no `inFlight` marker survives into the new
 * generation.
 */
export const dispatch = internalMutation({
  args: vMutationArgs,
  returns: vMutationReturns,
  handler: async (ctx, { op, ms }) => {
    const now = Date.now();
    await scheduleCount(ctx, now);
    if (op === "wait") return { debounceMs: ms ?? LEASE_POLL_MS };
    const exporter = await getOrCreateExporter(ctx);
    if (leaseActive(exporter, now)) return { debounceMs: LEASE_POLL_MS };
    const backoff = backoffRemaining(exporter, now);
    if (backoff > 0) {
      return { debounceMs: Math.min(backoff, BACKOFF_POLL_MS) };
    }
    for (const id of exporter.claimed) {
      const row = await ctx.db.get("outbox", id);
      if (row) await markFailed(ctx, row, now);
    }
    // `nextWork` saw an available row. If it is gone, the run ends at once.
    const generation = exporter.generation + 1;
    await ctx.db.patch("exporter", exporter._id, {
      generation,
      leaseExpiresAt: now + LEASE_MS,
      runStartedAt: now,
      claimed: [],
    });
    await ctx.scheduler.runAfter(0, internal.exporter.run, { generation });
    return { debounceMs: LEASE_POLL_MS };
  },
});

/**
 * One exporter run. Every state change happens in `advance`, fenced by
 * `generation`; a superseded run gets `done` and stops.
 */
export const run = internalAction({
  args: { generation: v.number() },
  returns: v.null(),
  handler: async (ctx, { generation }) => {
    const config = exportConfig();
    let report: Report | undefined;
    for (;;) {
      const step: Step = await ctx.runMutation(internal.exporter.advance, {
        generation,
        report,
      });
      if (step.done) return null;
      if (!config) {
        // Keys removed after rows were enqueued: back off like a 401 would.
        report = { outcome: "config" };
      } else if ("op" in step) {
        report = await sendOp(config, step.op);
      } else {
        report = await send(config, step.spans);
      }
    }
  },
});

/** Full-jitter exponential backoff, or `Retry-After`, limited to `cap`. */
function backoffDelay(report: Report, failures: number, cap: number): number {
  if (report.retryAfterMs !== undefined) {
    return Math.min(report.retryAfterMs, cap);
  }
  return Math.random() * Math.min(cap, BACKOFF_BASE_MS * 2 ** failures);
}

/**
 * Applies the outcome of the previous request to the claimed rows, then claims
 * the next batch and renews the lease. Returns `done` when the generation is
 * superseded, the request failed, the run budget is spent or nothing is
 * available.
 *
 * An API op differs from a span batch: it never counts toward the removed
 * totals or the breaker, a rejected op becomes a dead letter at once, and a
 * `deferred` op moves `DEFERRED_MS` ahead while the run goes on. Score ops
 * also move through their `scoreKeys` state on claim and with the outcome.
 */
export const advance = internalMutation({
  args: { generation: v.number(), report: v.optional(vReport) },
  returns: vStep,
  handler: async (ctx, { generation, report }): Promise<Step> => {
    const exporter = await getExporter(ctx);
    if (!exporter || exporter.generation !== generation) return { done: true };
    const now = Date.now();
    // Outbox rows this call deletes; each one adds to the removed totals.
    const removed: Doc<"outbox">[] = [];
    // Only a closed gate can change through a deletion or the end of a run:
    // both ask `reconcileGate`, which decides from both totals. This mutation
    // never reads the counter, so it does not conflict with a count step.
    let reconciling = false;
    const reopen = async () => {
      if (reconciling || !(await gateClosed(ctx))) return;
      reconciling = true;
      await scheduleReconcile(ctx);
    };
    const settle = async (): Promise<Removed> => {
      // Only spans count toward the backlog the gate decides on.
      if (removed.some((row) => row.kind === "span")) await reopen();
      return withRemoved(exporter, removed);
    };
    const endRun = async (patch: Partial<Doc<"exporter">>) => {
      // After the run nothing may be left to delete, so a gate that is
      // closed over an empty outbox would stay closed.
      await reopen();
      await ctx.db.patch("exporter", exporter._id, {
        ...patch,
        ...(await settle()),
        leaseExpiresAt: undefined,
        runStartedAt: undefined,
        claimed: [],
      });
      return { done: true as const };
    };

    let { consecutiveRejected, isolateRemaining } = exporter;
    const patch: Partial<Doc<"exporter">> = {};
    if (report) {
      const rows = (
        await Promise.all(
          exporter.claimed.map((id) => ctx.db.get("outbox", id)),
        )
      ).filter((row) => row !== null);
      // An API op is always claimed alone. The breaker and the isolation of
      // rejected batches concern spans only.
      const op =
        rows.length === 1 && rows[0]!.kind !== "span" ? rows[0]! : null;
      let outcome = report.outcome;
      if (
        outcome === "rejected" &&
        rows.length === 1 &&
        !op &&
        consecutiveRejected >= BREAKER_REJECTED_SPANS
      ) {
        // Breaker: a systemic rejection must not dead-letter the backlog.
        outcome = "config";
      }
      if (outcome === "deferred" && !op && rows.length > 0) outcome = "config";
      switch (outcome) {
        case "accepted":
          for (const row of rows) {
            await ctx.db.delete("payloads", row.payloadId);
            await ctx.db.delete("outbox", row._id);
          }
          removed.push(...rows);
          if (op) {
            await markAccepted(ctx, op, now);
          } else {
            consecutiveRejected = 0;
            isolateRemaining = Math.max(0, isolateRemaining - rows.length);
          }
          Object.assign(patch, {
            accepted: exporter.accepted + rows.length,
            lastAcceptedAt: now,
            consecutiveFailures: 0,
            backoffUntil: undefined,
          });
          break;
        case "rejected":
          if (rows.length > 1) {
            isolateRemaining = rows.length;
          } else if (rows.length === 1) {
            const { _id, kind, ref, bytes, payloadId } = rows[0]!;
            await ctx.db.insert("deadLetters", {
              kind,
              ref,
              bytes,
              payloadId,
              reason: "rejected",
              status: report.status,
              failedAt: now,
            });
            await ctx.db.delete("outbox", _id);
            removed.push(rows[0]!);
            if (op) {
              await forgetOp(ctx, op, now);
            } else {
              consecutiveRejected += 1;
              isolateRemaining = Math.max(0, isolateRemaining - 1);
            }
            patch.deadLettered = exporter.deadLettered + 1;
          }
          break;
        case "deferred":
          // A route error of one endpoint: only this op waits, the run goes
          // on with the rows behind it.
          if (op && !(await markFailed(ctx, op, now))) {
            await ctx.db.patch("outbox", op._id, {
              availableAt: now + DEFERRED_MS,
            });
          }
          patch.lastError = {
            at: now,
            class: "config",
            ...(report.status === undefined ? {} : { status: report.status }),
          };
          break;
        case "transient":
        case "config": {
          if (op) await markFailed(ctx, op, now);
          const consecutiveFailures = exporter.consecutiveFailures + 1;
          const cap =
            outcome === "transient" ? BACKOFF_CAP_MS : CONFIG_BACKOFF_CAP_MS;
          return await endRun({
            consecutiveFailures,
            backoffUntil: now + backoffDelay(report, consecutiveFailures, cap),
            lastError: {
              at: now,
              class: outcome,
              ...(report.status === undefined ? {} : { status: report.status }),
            },
          });
        }
      }
    }
    patch.consecutiveRejected = consecutiveRejected;
    patch.isolateRemaining = isolateRemaining;

    if (now - (exporter.runStartedAt ?? now) > RUN_BUDGET_MS) {
      return await endRun(patch);
    }

    // Candidates come from a stale snapshot, so this mutation takes no read
    // dependency on the range that enqueues write into. Each row is read by
    // id; one that is gone or not available any more is skipped.
    const window = await ctx.runQuery(
      internal.exporter.claimable,
      { now },
      { useStaleSnapshot: true },
    );
    // Either the longest prefix of span rows within the span and byte
    // budgets, at least one row, or exactly one API op when the first row is
    // one. Exactly one row while isolating the rows of a rejected batch.
    const claimed: Doc<"outbox">["_id"][] = [];
    const spans: string[] = [];
    let op: Op | undefined;
    let bytes = 0;
    for (const id of window) {
      const row = await ctx.db.get("outbox", id);
      if (!row || row.availableAt > now) continue;
      if (
        claimed.length > 0 &&
        (row.kind !== "span" ||
          isolateRemaining > 0 ||
          claimed.length >= BATCH_MAX_SPANS ||
          bytes + row.bytes > BATCH_MAX_BYTES)
      ) {
        break;
      }
      const payload = await ctx.db.get("payloads", row.payloadId);
      if (!payload) {
        // A row without its payload can never be sent.
        await ctx.db.delete("outbox", row._id);
        removed.push(row);
        await forgetOp(ctx, row, now);
        continue;
      }
      claimed.push(row._id);
      if (row.kind !== "span") {
        op = { kind: row.kind, ref: row.ref, body: payload.data };
        await markInFlight(ctx, row, now);
        break;
      }
      spans.push(payload.data);
      bytes += row.bytes;
    }
    if (claimed.length === 0) return await endRun(patch);

    await ctx.db.patch("exporter", exporter._id, {
      ...patch,
      ...(await settle()),
      claimed,
      leaseExpiresAt: now + LEASE_MS,
    });
    return op ? { done: false, op } : { done: false, spans };
  },
});

/**
 * Clears a pending backoff and restarts the loop at once. For operators,
 * after fixing the configuration.
 */
export const kick = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const exporter = await getExporter(ctx);
    if (exporter?.backoffUntil !== undefined) {
      await ctx.db.patch("exporter", exporter._id, {
        backoffUntil: undefined,
      });
    }
    await pingExporter(ctx);
    // A ping does not interrupt a running loop's wait; this does.
    await ctx.runMutation(components.batchWorker.lib.kick, {
      name: WORKER_NAME,
    });
    return null;
  },
});

/** Parses `Retry-After`, given in seconds or as an HTTP date. */
export function parseRetryAfter(
  value: string | null,
  now: number,
): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Maps an HTTP status to the exporter's outcome classes. A route error (404,
 * 405, any 3xx) is `config` for the OTLP request and `deferred` for an API
 * op, so one wrong API route does not stop the spans.
 */
export function classify(
  status: number,
  retryAfter: string | null,
  now: number,
  target: "otlp" | "api" = "otlp",
): Report {
  if (status >= 200 && status < 300) return { outcome: "accepted", status };
  const retryAfterMs = parseRetryAfter(retryAfter, now);
  const timing = retryAfterMs === undefined ? {} : { retryAfterMs };
  if (status === 401 || status === 403) {
    return { outcome: "config", status, ...timing };
  }
  // Status 0 is an opaque redirect in runtimes that hide 3xx responses.
  if (
    status === 0 ||
    (status >= 300 && status < 400) ||
    status === 404 ||
    status === 405
  ) {
    return target === "api"
      ? { outcome: "deferred", status }
      : { outcome: "config", status, ...timing };
  }
  if ([408, 425, 429].includes(status) || status >= 500) {
    return { outcome: "transient", status, ...timing };
  }
  if (status >= 400) return { outcome: "rejected", status };
  return { outcome: "transient", status, ...timing };
}

/**
 * One request with `redirect: "manual"`, Basic auth and a JSON body, aborted
 * after `timeoutMs`. Never throws and never reads the response body: network
 * errors and the timeout are `transient`.
 */
async function request(
  config: ExportConfig,
  init: {
    method: "POST" | "DELETE";
    path: string;
    body?: string;
    headers?: Record<string, string>;
    timeoutMs: number;
    target: "otlp" | "api";
  },
): Promise<Report> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}${init.path}`, {
      method: init.method,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Authorization: basicAuth(config),
        "Content-Type": "application/json",
        ...init.headers,
      },
      body: init.body,
    });
    return classify(
      response.status,
      response.headers.get("Retry-After"),
      Date.now(),
      init.target,
    );
  } catch {
    return { outcome: "transient" };
  } finally {
    clearTimeout(timeout);
  }
}

/** Sends one batch of encoded spans, with a `REQUEST_TIMEOUT_MS` timeout. */
export async function send(
  config: ExportConfig,
  spans: string[],
): Promise<Report> {
  return await request(config, {
    method: "POST",
    path: "/api/public/otel/v1/traces",
    headers: { "x-langfuse-ingestion-version": "4" },
    body: buildExportBody(spans, VERSION),
    timeoutMs: REQUEST_TIMEOUT_MS,
    target: "otlp",
  });
}

/** Sends one API op, with an `API_TIMEOUT_MS` timeout. */
export async function sendOp(config: ExportConfig, op: Op): Promise<Report> {
  const api = { timeoutMs: API_TIMEOUT_MS, target: "api" as const };
  switch (op.kind) {
    case "scoreCreate":
      return await request(config, {
        method: "POST",
        path: "/api/public/scores",
        body: op.body,
        ...api,
      });
    case "scoreDelete":
      return await request(config, {
        method: "DELETE",
        path: `/api/public/scores/${encodeURIComponent(op.ref)}`,
        ...api,
      });
    case "traceDelete":
      return await request(config, {
        method: "DELETE",
        path: "/api/public/traces",
        body: op.body,
        ...api,
      });
  }
}
