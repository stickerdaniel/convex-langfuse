// The exporter: one fenced run at a time drains the outbox to Langfuse.
//
// A batch-worker loop named `WORKER_NAME` calls `nextWork` on a stale
// snapshot and hands its batch to `dispatch`. `dispatch` starts a run by
// bumping `generation` and taking a lease, or tells the loop how long to wait.
// The run action alternates between `advance`, which applies the previous
// request's outcome and claims the next batch, and one HTTP request per batch.
// A run that dies leaves its lease to expire; the next generation then claims
// the same rows and sends the same bytes again.

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
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BATCH_MAX_BYTES,
  BATCH_MAX_SPANS,
  BREAKER_REJECTED_SPANS,
  CLAIM_WINDOW,
  CONFIG_BACKOFF_CAP_MS,
  LEASE_MS,
  REQUEST_TIMEOUT_MS,
  RUN_BUDGET_MS,
  WORKER_NAME,
} from "./constants.js";
import {
  getExporter,
  getOrCreateExporter,
  moveGate,
  pingExporter,
  resetCountersIfEmpty,
  scheduleCount,
  withoutRows,
  type Counters,
} from "./outbox.js";
import { exportConfig, type ExportConfig } from "./settings.js";
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
  outcome: v.union(
    v.literal("accepted"),
    v.literal("rejected"),
    v.literal("transient"),
    v.literal("config"),
  ),
  status: v.optional(v.number()),
  retryAfterMs: v.optional(v.number()),
});
/** Outcome of one export request. */
export type Report = Infer<typeof vReport>;

const vStep = v.union(
  v.object({ done: v.literal(true) }),
  v.object({ done: v.literal(false), spans: v.array(v.string()) }),
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
 * The worker mutation of the batch-worker loop. Re-reads the state, because
 * `nextWork` saw a stale snapshot. Always returns a `debounceMs`, so the loop
 * stays `running` and an enqueue `ping` stays read-only.
 */
export const dispatch = internalMutation({
  args: vMutationArgs,
  returns: vMutationReturns,
  handler: async (ctx, { op, ms }) => {
    const now = Date.now();
    const exporter = await getOrCreateExporter(ctx);
    if (op === "wait") {
      await scheduleCount(ctx, exporter, now);
      return { debounceMs: ms ?? LEASE_POLL_MS };
    }
    if (leaseActive(exporter, now)) return { debounceMs: LEASE_POLL_MS };
    const backoff = backoffRemaining(exporter, now);
    if (backoff > 0) {
      return { debounceMs: Math.min(backoff, BACKOFF_POLL_MS) };
    }
    const available = await ctx.db
      .query("outbox")
      .withIndex("by_availableAt", (q) => q.lte("availableAt", now))
      .first();
    if (!available) return { debounceMs: 100 };
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
      // Keys removed after rows were enqueued: back off like a 401 would.
      report = config ? await send(config, step.spans) : { outcome: "config" };
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
 */
export const advance = internalMutation({
  args: { generation: v.number(), report: v.optional(vReport) },
  returns: vStep,
  handler: async (ctx, { generation, report }): Promise<Step> => {
    const exporter = await getExporter(ctx);
    if (!exporter || exporter.generation !== generation) return { done: true };
    const now = Date.now();
    // Outbox rows this call deletes; counted ones leave the pending counters.
    const removed: Doc<"outbox">[] = [];
    const settle = async (): Promise<Partial<Counters>> => {
      if (removed.length === 0) return {};
      const counters = withoutRows(exporter, removed);
      await moveGate(ctx, counters);
      return counters;
    };
    const endRun = async (
      patch: Partial<Doc<"exporter">>,
      counters?: Partial<Counters>,
    ) => {
      await ctx.db.patch("exporter", exporter._id, {
        ...patch,
        ...(counters ?? (await settle())),
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
      let outcome = report.outcome;
      if (
        outcome === "rejected" &&
        rows.length === 1 &&
        consecutiveRejected >= BREAKER_REJECTED_SPANS
      ) {
        // Breaker: a systemic rejection must not dead-letter the backlog.
        outcome = "config";
      }
      switch (outcome) {
        case "accepted":
          for (const row of rows) {
            await ctx.db.delete("payloads", row.payloadId);
            await ctx.db.delete("outbox", row._id);
          }
          removed.push(...rows);
          consecutiveRejected = 0;
          isolateRemaining = Math.max(0, isolateRemaining - rows.length);
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
            consecutiveRejected += 1;
            isolateRemaining = Math.max(0, isolateRemaining - 1);
            patch.deadLettered = exporter.deadLettered + 1;
          }
          break;
        case "transient":
        case "config": {
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

    const window = await ctx.db
      .query("outbox")
      .withIndex("by_availableAt", (q) => q.lte("availableAt", now))
      .take(CLAIM_WINDOW);
    // The longest prefix within the span and byte budgets, at least one row;
    // exactly one row while isolating the rows of a rejected batch.
    const claimed: Doc<"outbox">["_id"][] = [];
    const spans: string[] = [];
    let bytes = 0;
    for (const row of window) {
      if (
        claimed.length > 0 &&
        (isolateRemaining > 0 ||
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
        continue;
      }
      claimed.push(row._id);
      spans.push(payload.data);
      bytes += row.bytes;
    }
    if (window.length === CLAIM_WINDOW) {
      await scheduleCount(ctx, exporter, now);
    }
    if (claimed.length === 0) {
      const counters = await settle();
      const reset = await resetCountersIfEmpty(ctx, {
        ...exporter,
        ...counters,
      });
      return await endRun(patch, reset ?? counters);
    }

    await ctx.db.patch("exporter", exporter._id, {
      ...patch,
      ...(await settle()),
      claimed,
      leaseExpiresAt: now + LEASE_MS,
    });
    return { done: false, spans };
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

/** Maps an HTTP status to the exporter's outcome classes. */
export function classify(
  status: number,
  retryAfter: string | null,
  now: number,
): Report {
  if (status >= 200 && status < 300) return { outcome: "accepted", status };
  const retryAfterMs = parseRetryAfter(retryAfter, now);
  const timing = retryAfterMs === undefined ? {} : { retryAfterMs };
  // Status 0 is an opaque redirect in runtimes that hide 3xx responses.
  if (
    status === 0 ||
    (status >= 300 && status < 400) ||
    [401, 403, 404, 405].includes(status)
  ) {
    return { outcome: "config", status, ...timing };
  }
  if ([408, 425, 429].includes(status) || status >= 500) {
    return { outcome: "transient", status, ...timing };
  }
  if (status >= 400) return { outcome: "rejected", status };
  return { outcome: "transient", status, ...timing };
}

function basicAuth({ publicKey, secretKey }: ExportConfig): string {
  const bytes = new TextEncoder().encode(`${publicKey}:${secretKey}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

/**
 * Sends one batch of encoded spans. Never throws and never reads the response
 * body: network errors and the `REQUEST_TIMEOUT_MS` timeout are `transient`.
 */
export async function send(
  config: ExportConfig,
  spans: string[],
): Promise<Report> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${config.baseUrl}/api/public/otel/v1/traces`,
      {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Authorization: basicAuth(config),
          "Content-Type": "application/json",
          "x-langfuse-ingestion-version": "4",
        },
        body: buildExportBody(spans, VERSION),
      },
    );
    return classify(
      response.status,
      response.headers.get("Retry-After"),
      Date.now(),
    );
  } catch {
    return { outcome: "transient" };
  } finally {
    clearTimeout(timeout);
  }
}
