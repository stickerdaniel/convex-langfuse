// Load, outage, threshold and prompt refresh drivers on the pinned local
// backend.
//
//   npm run build && npm run test:load
//   node integration/load.mjs [load | outage | threshold [--kill] | prompts] [--out results.json]
//
// Without a driver name it runs `load`, `outage`, `threshold`,
// `threshold --kill` and `prompts` in that order. Every driver starts its own
// backends and fake endpoints on free ports, deploys the host app in
// `integration/convex`, prints a result table, and stops what it started.
// `--out` writes every result as JSON. The script exits non-zero when a bound
// fails. It runs for tens of minutes and is not part of CI or
// `npm run test:integration`.
//
// - `load`: 53,000 spans in 53 bursts of 1,000 while the fake endpoint
//   answers 5 % of the export requests with 500, 1 % with 429 and delays 1 %
//   by 5 s. Every span id must arrive, every delivery of an id with the same
//   bytes; the outbox ends empty, without dead letters and without a failed
//   `exporter:advance`, `exporter:dispatch` or `outbox:count` execution.
// - `outage`: three runs on fresh backends. Each measures the server-side
//   execution time of 2,000 enqueue mutations with the endpoint healthy and
//   2,000 with the endpoint down. The outage p95 must stay within
//   `max(2 × healthy p95, healthy p95 + 50 ms)`, and the backlog must drain
//   after the endpoint recovers.
// - `threshold`: 60,000 records offered at 6,000 per minute with the endpoint
//   down. At most 37,000 may be enqueued, every call after the gate closed must
//   be refused with `backlog`, and after recovery and `exporter.kick` the
//   backlog must drain and a new record must be enqueued. With `--kill`, the
//   backend is killed while the first export request is in flight and
//   restarted before the records are offered.
// - `prompts`: 500 prompt names, the most the cache tracks, cached at version
//   1 through `prompts.sync`, then moved to version 2 on the fake endpoint
//   without a webhook. It waits for real cron ticks, so it runs for about 20
//   minutes. Every name must return version 2 within 25 minutes after that
//   version exists, the first and the last refresh of the tick must start 99 s
//   to 130 s apart, and no `prompts:*` execution may fail. The per-name times
//   are kept in `prompts.json` of the diagnostics folder.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import {
  Backend,
  convexCli,
  ensureBinary,
  RELEASE,
  releaseTarget,
  sleep,
  startFake,
  stopAll,
  waitFor,
} from "./backend.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const api = anyApi.harness;
const { convex, setEnv, streamLogs, linkPackage } = convexCli(HERE);

const TRACE_ID = "b0000000000000000000000000000001";
const hexId = (n) => n.toString(16).padStart(16, "0");

/** Exporter executions that must never fail. */
const WATCHED =
  /(exporter(\.js)?:(advance|dispatch)|outbox(\.js)?:(count|reconcileGate))$/;
/** The host app's enqueue mutations, as the function log names them. */
const ENQUEUE = /harness(\.js)?:record$/;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Nearest-rank percentile of `values` in milliseconds. */
function percentile(values, p) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

const seconds = (ms) => Number((ms / 1_000).toFixed(1));
const millis = (ms) => Number(ms.toFixed(1));

/**
 * Runs one mutation. A mutation refused by the local backend's write
 * throughput limit is sent again after a pause; that limit belongs to the
 * backend, not to the component.
 */
async function mutate(client, fn, args) {
  for (;;) {
    try {
      return await client.mutation(fn, args, { skipQueue: true });
    } catch (error) {
      if (!/TooManyWrites/.test(String(error))) throw error;
      await sleep(1_000);
    }
  }
}

/** Runs `count` tasks, `concurrency` at a time. */
async function pool(count, concurrency, task) {
  let next = 0;
  const worker = async () => {
    while (next < count) await task(next++);
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

/**
 * A fresh backend with the host app deployed and bound to a fresh fake
 * endpoint, and a stream of its function log. `teardown` stops all of it.
 */
async function setup(binary) {
  const scratch = join(HERE, "..", "scratch");
  mkdirSync(scratch, { recursive: true });
  const stateDir = mkdtempSync(join(scratch, "load-"));
  const backend = new Backend(binary, stateDir);
  const fake = await startFake();
  try {
    await backend.init();
    await backend.start();
    await convex(backend, ["deploy", "--yes"]);
    const keys = {
      LANGFUSE_PUBLIC_KEY: "pk-lf-load",
      LANGFUSE_SECRET_KEY: "sk-lf-load",
      LANGFUSE_BASE_URL: fake.url,
    };
    for (const [name, value] of Object.entries(keys)) {
      await setEnv(backend, name, value);
    }
  } catch (error) {
    await fake.stop();
    if (
      backend.process?.exitCode === null &&
      backend.process.signalCode === null
    ) {
      await backend.kill();
    }
    throw error;
  }
  console.log(`diagnostics: ${stateDir}`);
  const client = new ConvexHttpClient(backend.url);
  let logs = streamLogs(backend);
  // Give the log stream time to attach before the first measured call.
  await sleep(2_000);
  const executions = [];
  const alive = () =>
    backend.process.exitCode === null && backend.process.signalCode === null;
  return {
    backend,
    fake,
    client,
    stateDir,
    backlog: () => client.query(api.backlog, {}),
    /** Clears the exporter's backoff and wakes its loop. */
    kick: () =>
      convex(backend, [
        "run",
        "--component",
        "convexLangfuse",
        "exporter:kick",
        "{}",
      ]),
    /** Kills the backend and starts it again on the same state. */
    async restart(between = async () => {}) {
      await backend.kill();
      executions.push(...(await logs.stop()));
      await between();
      await backend.start();
      logs = streamLogs(backend);
      await sleep(2_000);
    },
    /** Every completed execution so far; ends the log stream. */
    async executions() {
      if (logs) executions.push(...(await logs.stop()));
      logs = undefined;
      return executions;
    },
    async teardown() {
      try {
        if (logs) executions.push(...(await logs.stop()));
        logs = undefined;
        writeFileSync(
          join(stateDir, "executions.json"),
          JSON.stringify(executions),
        );
        writeFileSync(
          join(stateDir, "fake.json"),
          JSON.stringify(await fake.stats()),
        );
      } finally {
        await fake.stop();
        if (alive()) await backend.kill();
        // Keep the logs, not the database and its payloads.
        for (const file of [
          "storage",
          "backend.sqlite3",
          "backend.sqlite3-wal",
          "backend.sqlite3-shm",
        ]) {
          rmSync(join(stateDir, file), { recursive: true, force: true });
        }
      }
    },
  };
}

/** Failed exporter executions, or required functions missing from the log. */
function failedExporter(executions) {
  // dispatch shares batch-worker's loop transaction. Its uncaught errors
  // appear under loop:loop, not as a separate dispatch completion.
  const dispatch = (log) =>
    log.componentPath === "convexLangfuse/batchWorker" &&
    /^loop(\.js)?:loop$/.test(log.identifier);
  const failures = executions
    .filter(
      (log) => log.error && (WATCHED.test(log.identifier) || dispatch(log)),
    )
    .map(
      (log) =>
        `${log.identifier}: ${String(log.error).split("\n")[0].slice(0, 160)}`,
    );
  if (!executions.some(dispatch))
    failures.push("no batch-worker loop execution logged");
  for (const name of ["exporter:advance", "outbox:count"]) {
    if (
      !executions.some((log) => log.identifier.replace(".js:", ":") === name)
    ) {
      failures.push(`no ${name} execution logged`);
    }
  }
  return failures;
}

/** A named check of a driver. */
const check = (name, ok, detail) => ({ check: name, ok: Boolean(ok), detail });

// ── load ───────────────────────────────────────────────────────────────────

const LOAD_SPANS = 53_000;
const BURST = 1_000;
const LOAD_CALL_SPANS = 50;
/** Keeps burst starts below the local backend's 4 MiB/s write limit. */
const BURST_INTERVAL_MS = 1_000;
/**
 * Most spans that may be pending when a burst starts. A burst adds 1,000, so
 * at most 12,000 are ever pending, below half of the gate's threshold of
 * 25,000. The gate counts at most the pending spans: its added total trails
 * the enqueues, its removed total counts every deleted row. So it can neither
 * close nor stay closed.
 */
const LOAD_PENDING_BEFORE_BURST = 11_000;

async function loadDriver(binary) {
  const env = await setup(binary);
  const { client, fake } = env;
  let longestBackoffMs = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const backlog = await env.backlog();
      longestBackoffMs = Math.max(longestBackoffMs, backlog.backoffMs);
      await sleep(250);
    }
  })();
  try {
    const faults = {
      mode: "faults",
      p500: 0.05,
      p429: 0.01,
      pDelay: 0.01,
      delayMs: 5_000,
      seed: 1,
    };
    await fake.control(faults);
    const startedAt = Date.now();
    let enqueued = 0;
    let boundWaitMs = 0;
    let maxPending = 0;
    let nextBurstAt = startedAt;
    for (let burst = 0; burst < LOAD_SPANS / BURST; burst++) {
      await sleep(Math.max(0, nextBurstAt - Date.now()));
      const waitStart = Date.now();
      await waitFor(
        "room for the next burst",
        async () => {
          const backlog = await env.backlog();
          const pending = enqueued - backlog.accepted - backlog.deadLettered;
          maxPending = Math.max(maxPending, pending);
          return backlog.accepting && pending <= LOAD_PENDING_BEFORE_BURST;
        },
        600_000,
        250,
      );
      boundWaitMs += Date.now() - waitStart;
      const first = 1 + burst * BURST;
      nextBurstAt = Date.now() + BURST_INTERVAL_MS;
      // The strict client throws when a span was not enqueued.
      await pool(BURST / LOAD_CALL_SPANS, 10, (i) =>
        mutate(client, api.record, {
          traceId: TRACE_ID,
          from: first + i * LOAD_CALL_SPANS,
          count: LOAD_CALL_SPANS,
        }),
      );
      enqueued += BURST;
    }
    const enqueuedAt = Date.now();
    const backlog = await waitFor(
      "an empty outbox",
      async () => {
        const backlog = await env.backlog();
        return backlog.pendingAtLeast === 0 && backlog;
      },
      30 * 60_000,
      1_000,
    );
    const finishedAt = Date.now();
    const stats = await fake.stats();
    const executions = await env.executions();

    let missing = 0;
    for (let n = 1; n <= LOAD_SPANS; n++) {
      if (!stats.spans[hexId(n)]) missing += 1;
    }
    const ids = Object.keys(stats.spans);
    const divergent = ids.filter(
      (id) => new Set(stats.spans[id]).size > 1,
    ).length;
    const deliveries = ids.reduce((sum, id) => sum + stats.spans[id].length, 0);
    // The time from an injected 500 or 429 to the next export request: the
    // backoff plus the loop's reaction time.
    let longestRetryGapMs = 0;
    stats.log.forEach((request, i) => {
      const next = stats.log[i + 1];
      if ((request.status === 500 || request.status === 429) && next) {
        longestRetryGapMs = Math.max(longestRetryGapMs, next.at - request.at);
      }
    });
    const failed = failedExporter(executions);
    const metrics = {
      spans: LOAD_SPANS,
      bursts: LOAD_SPANS / BURST,
      seconds: seconds(finishedAt - startedAt),
      enqueueSeconds: seconds(enqueuedAt - startedAt),
      boundWaitSeconds: seconds(boundWaitMs),
      maxPendingAtBurstCheck: maxPending,
      exportRequests: stats.requests,
      distinctSpanIds: ids.length,
      deliveries,
      resends: deliveries - LOAD_SPANS,
      injected500: stats.faults[500],
      injected429: stats.faults[429],
      injectedDelays: stats.faults.delay,
      longestSampledBackoffSeconds: seconds(longestBackoffMs),
      longestRetryGapSeconds: seconds(longestRetryGapMs),
      badHeaders: stats.badHeaders,
    };
    return {
      diagnostics: env.stateDir,
      metrics,
      checks: [
        check("every span id received", missing === 0, `${missing} missing`),
        check(
          "every delivery of an id identical",
          divergent === 0,
          `${divergent} ids with different bytes`,
        ),
        check(
          "outbox empty",
          backlog.pendingAtLeast === 0,
          `${backlog.pendingAtLeast} pending`,
        ),
        check(
          "no dead letters",
          backlog.deadLettered === 0 && backlog.deadLettersAtLeast === 0,
          `${backlog.deadLettered} dead-lettered`,
        ),
        check(
          "no failed exporter execution",
          failed.length === 0,
          failed[0] ?? `${executions.length} executions logged`,
        ),
      ],
    };
  } finally {
    sampling = false;
    await sampler;
    await env.teardown();
  }
}

// ── outage ─────────────────────────────────────────────────────────────────

const OUTAGE_RUNS = 3;
const OUTAGE_CALLS = 2_000;
/** 2 × 2,000 × 5 = 20,000 rows per run, below the gate's 25,000. */
const OUTAGE_CALL_SPANS = 5;
const OUTAGE_CONCURRENCY = 4;

/** Runs `OUTAGE_CALLS` enqueue mutations and returns the phase window. */
async function enqueuePhase(client, first) {
  const from = Date.now();
  await pool(OUTAGE_CALLS, OUTAGE_CONCURRENCY, (i) =>
    mutate(client, api.record, {
      traceId: TRACE_ID,
      from: first + i * OUTAGE_CALL_SPANS,
      count: OUTAGE_CALL_SPANS,
    }),
  );
  return { from, to: Date.now() };
}

async function outageRun(binary, run) {
  const env = await setup(binary);
  const { client, fake } = env;
  try {
    const healthy = await enqueuePhase(client, 1);
    await waitFor(
      "the healthy backlog to drain",
      async () => (await env.backlog()).pendingAtLeast === 0,
      300_000,
      1_000,
    );
    // Keeps the log windows of the two phases apart.
    await sleep(3_000);
    await fake.control({ mode: "down" });
    const down = await enqueuePhase(
      client,
      1 + OUTAGE_CALLS * OUTAGE_CALL_SPANS,
    );
    await fake.control({ mode: "healthy" });
    const recoveredAt = Date.now();
    const total = 2 * OUTAGE_CALLS * OUTAGE_CALL_SPANS;
    const drained = await waitFor(
      "the backlog to drain after recovery",
      async () =>
        (await fake.summary()).distinct >= total &&
        (await env.backlog()).pendingAtLeast === 0,
      600_000,
      1_000,
    ).then(
      () => Date.now(),
      () => undefined,
    );
    const executions = await env.executions();
    // The log has one entry per attempt; an attempt that lost an OCC
    // conflict is retried under the same request id. A mutation's time is
    // the sum of its attempts.
    const phase = ({ from, to }) => {
      const byRequest = new Map();
      let retries = 0;
      for (const log of executions) {
        const at = log.timestamp * 1_000;
        if (!ENQUEUE.test(log.identifier) || log.error) continue;
        if (at < from - 1_000) continue;
        if (at > to + 1_000) continue;
        if (log.willRetry) retries += 1;
        const ms = byRequest.get(log.requestId) ?? 0;
        byRequest.set(log.requestId, ms + log.executionTime * 1_000);
      }
      return { ms: [...byRequest.values()], retries };
    };
    const { ms: healthyMs, retries: healthyRetries } = phase(healthy);
    const { ms: downMs, retries: downRetries } = phase(down);
    const healthyP95 = percentile(healthyMs, 0.95);
    const downP95 = percentile(downMs, 0.95);
    const limit = Math.max(2 * healthyP95, healthyP95 + 50);
    const failed = failedExporter(executions);
    return {
      diagnostics: env.stateDir,
      metrics: {
        run,
        healthyCalls: healthyMs.length,
        healthyP50: millis(percentile(healthyMs, 0.5)),
        healthyP95: millis(healthyP95),
        healthyOccRetries: healthyRetries,
        outageCalls: downMs.length,
        outageP50: millis(percentile(downMs, 0.5)),
        outageP95: millis(downP95),
        outageOccRetries: downRetries,
        limitP95: millis(limit),
        drainSeconds:
          drained === undefined ? null : seconds(drained - recoveredAt),
      },
      checks: [
        check(
          `run ${run}: at least ${OUTAGE_CALLS} measured per phase`,
          healthyMs.length >= OUTAGE_CALLS && downMs.length >= OUTAGE_CALLS,
          `${healthyMs.length} healthy, ${downMs.length} down`,
        ),
        check(
          `run ${run}: outage p95 within the bound`,
          downP95 <= limit,
          `${millis(downP95)} ms against ${millis(limit)} ms`,
        ),
        check(
          `run ${run}: backlog drains after recovery`,
          drained !== undefined,
          drained === undefined
            ? "not drained within 600 s"
            : `${seconds(drained - recoveredAt)} s`,
        ),
        check(
          `run ${run}: no failed exporter execution`,
          failed.length === 0,
          failed[0] ?? "none",
        ),
      ],
    };
  } finally {
    await env.teardown();
  }
}

async function outageDriver(binary) {
  const runs = [];
  for (let run = 1; run <= OUTAGE_RUNS; run++) {
    const result = await outageRun(binary, run);
    runs.push(result);
    if (result.checks.some((c) => !c.ok)) break;
  }
  return {
    diagnostics: runs.map((r) => r.diagnostics),
    metrics: runs.map((r) => r.metrics),
    checks: runs.flatMap((r) => r.checks),
  };
}

// ── threshold ──────────────────────────────────────────────────────────────

const OFFERED = 60_000;
const THRESHOLD_CALL_RECORDS = 10;
/** 10 records every 100 ms: 6,000 records per minute. */
const OFFER_INTERVAL_MS = 100;
/** The gate's threshold of 25,000 plus two minutes of intake. */
const ENQUEUED_BOUND = 37_000;
/** Calls in flight at most; a slower backend lowers the offered rate. */
const MAX_IN_FLIGHT = 50;

async function thresholdDriver(binary, { kill }) {
  const env = await setup(binary);
  const { client, fake } = env;
  const calls = [];
  const offer = async (i) => {
    const call = { i, sentAt: Date.now() };
    calls.push(call);
    try {
      call.result = await mutate(client, api.recordCounted, {
        traceId: TRACE_ID,
        from: 1 + i * THRESHOLD_CALL_RECORDS,
        count: THRESHOLD_CALL_RECORDS,
      });
    } catch (error) {
      call.error = String(error?.message ?? error).slice(0, 200);
    }
    call.receivedAt = Date.now();
  };
  // Samples of the gate and the counted backlog while records are offered.
  const samples = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        samples.push({ at: Date.now(), ...(await env.backlog()) });
      } catch {
        // The backend restarts.
      }
      await sleep(5_000);
    }
  })();
  try {
    let next = 0;
    const firstAt = Date.now();
    if (kill) {
      // The first export request is held, so the backend dies with it in
      // flight and never learns its answer.
      await fake.control({ mode: "delay", delayMs: 30_000 });
      await offer(next++);
      await waitFor(
        "an export request in flight",
        async () => (await fake.summary()).inflight > 0,
        30_000,
        100,
      );
      await env.restart(() => fake.control({ mode: "down" }));
    } else {
      await fake.control({ mode: "down" });
    }
    const pending = new Set();
    const paced = next;
    const pacedAt = Date.now();
    const paceStart = pacedAt - next * OFFER_INTERVAL_MS;
    while (next < OFFERED / THRESHOLD_CALL_RECORDS) {
      const due = paceStart + next * OFFER_INTERVAL_MS;
      if (due > Date.now()) await sleep(due - Date.now());
      while (pending.size >= MAX_IN_FLIGHT) await Promise.race(pending);
      const promise = offer(next++).finally(() => pending.delete(promise));
      pending.add(promise);
    }
    await Promise.all(pending);
    const pacedSeconds = (Date.now() - pacedAt) / 1_000;
    sampling = false;
    await sampler;

    const answered = calls.filter((call) => call.result);
    const errors = calls.filter((call) => call.error);
    const enqueued = answered.reduce((sum, c) => sum + c.result.enqueued, 0);
    const refused = answered.filter((c) => c.result.reason === "backlog");
    const otherReason = answered.filter(
      (c) => c.result.reason !== undefined && c.result.reason !== "backlog",
    );
    const firstRefusal = [...refused].sort(
      (a, b) => a.receivedAt - b.receivedAt,
    )[0];
    // A call sent after a refusal was answered must be refused too.
    const acceptedAfterClosure = firstRefusal
      ? answered.filter(
          (c) =>
            c.sentAt > firstRefusal.receivedAt && c.result.reason !== "backlog",
        )
      : [];
    const invalidResults = answered.filter(({ result }) =>
      result.reason === "backlog"
        ? result.enqueued !== 0 || result.dropped !== THRESHOLD_CALL_RECORDS
        : result.enqueued !== THRESHOLD_CALL_RECORDS,
    );
    // Nothing drains before recovery, so the final enqueue count includes
    // every commit before closure, even if its response arrived later.
    const enqueuedAtClosure = enqueued;
    const maxCounted = Math.max(0, ...samples.map((s) => s.pendingCounted));

    // Recovery.
    await fake.control({ mode: "healthy" });
    const kickedAt = Date.now();
    await env.kick();
    const drained = await waitFor(
      "the backlog to drain and the gate to open",
      async () => {
        const backlog = await env.backlog();
        return backlog.pendingAtLeast === 0 && backlog.accepting;
      },
      900_000,
      1_000,
    ).then(
      () => Date.now(),
      () => undefined,
    );
    const after = await mutate(client, api.recordCounted, {
      traceId: TRACE_ID,
      from: 1 + OFFERED,
      count: 1,
    });
    const arrived = await waitFor(
      "every enqueued record at the endpoint",
      async () => (await fake.summary()).distinct >= enqueued + after.enqueued,
      300_000,
      1_000,
    ).then(
      () => true,
      () => false,
    );
    const summary = await fake.summary();
    const failed = failedExporter(await env.executions());
    return {
      diagnostics: env.stateDir,
      metrics: {
        variant: kill ? "threshold --kill" : "threshold",
        offered: calls.length * THRESHOLD_CALL_RECORDS,
        offeredPerMinute: Math.round(
          ((calls.length - paced) * THRESHOLD_CALL_RECORDS * 60) / pacedSeconds,
        ),
        enqueued,
        refusedRecords: refused.reduce((sum, c) => sum + c.result.dropped, 0),
        enqueuedAtClosure,
        closureSeconds: firstRefusal
          ? seconds(firstRefusal.receivedAt - firstAt)
          : null,
        maxPendingCounted: maxCounted,
        drainSeconds:
          drained === undefined ? null : seconds(drained - kickedAt),
        exportRequests: summary.requests,
        distinctSpanIds: summary.distinct,
      },
      checks: [
        check(
          "every call answered",
          errors.length === 0 && otherReason.length === 0,
          errors[0]?.error ??
            (otherReason[0]
              ? `reason ${otherReason[0].result.reason}`
              : `${answered.length} calls`),
        ),
        check(
          "every record enqueued or refused",
          enqueued + refused.reduce((sum, c) => sum + c.result.dropped, 0) ===
            OFFERED && invalidResults.length === 0,
          `${invalidResults.length} invalid results`,
        ),
        check(
          "the gate closed",
          firstRefusal !== undefined,
          firstRefusal ? `${enqueuedAtClosure} enqueued` : "no refusal",
        ),
        check(
          `at most ${ENQUEUED_BOUND} records enqueued`,
          enqueued <= ENQUEUED_BOUND,
          `${enqueued} enqueued`,
        ),
        check(
          "every call after the closure refused with backlog",
          acceptedAfterClosure.length === 0,
          `${acceptedAfterClosure.length} calls enqueued after the closure`,
        ),
        check(
          "backlog drains after recovery and kick",
          drained !== undefined,
          drained === undefined
            ? "not drained within 900 s"
            : `${seconds(drained - kickedAt)} s`,
        ),
        check(
          "a new record is enqueued after recovery",
          after.enqueued === 1,
          JSON.stringify(after),
        ),
        check(
          "every enqueued record exported once recovered",
          arrived && summary.divergent === 0,
          `${summary.distinct} distinct ids, ${summary.divergent} divergent`,
        ),
        check(
          "no failed exporter execution",
          failed.length === 0,
          failed[0] ?? "none",
        ),
      ],
    };
  } finally {
    sampling = false;
    await sampler;
    writeFileSync(join(env.stateDir, "calls.json"), JSON.stringify(calls));
    writeFileSync(join(env.stateDir, "gate.json"), JSON.stringify(samples));
    await env.teardown();
  }
}

// ── prompts ────────────────────────────────────────────────────────────────

/** As many names as the cache tracks, `MAX_PROMPT_NAMES`. */
const PROMPT_NAMES = Array.from(
  { length: 500 },
  (_, i) => `load/prompt-${String(i).padStart(3, "0")}`,
);
/**
 * Each name returns version 2 within this time after it exists: 13 min until
 * the name is due, at most 5 min to the next tick, 99.8 s of spacing, and the
 * rest for the refreshes themselves.
 */
const APPLY_BOUND_MS = 25 * 60_000;
/** The spacing of 499 × 200 ms plus the scheduler's delay. */
const START_SPAN_MS = { min: 99_000, max: 130_000 };
/** Names per `promptVersions` query. */
const VERSION_QUERY_NAMES = 50;
/** The listing of one name, the first request of every refresh. */
const REFRESH_START = "GET /v2/prompts";
const PROMPT_FUNCTION = /^prompts(\.js)?:/;

/** A text prompt of 300 bytes. */
const promptText = (name, version) =>
  `You answer for ${name}, version ${version}. `.padEnd(
    300,
    "Cite the context and keep it short. ",
  );

async function promptsDriver(binary) {
  const env = await setup(binary);
  const { client, fake } = env;
  const chunks = [];
  for (let i = 0; i < PROMPT_NAMES.length; i += VERSION_QUERY_NAMES) {
    chunks.push(PROMPT_NAMES.slice(i, i + VERSION_QUERY_NAMES));
  }
  /** The cached `production` version of every name, `null` on a miss. */
  const cachedVersions = async () =>
    (
      await Promise.all(
        chunks.map((names) => client.query(api.promptVersions, { names })),
      )
    ).flat();
  const addVersion = (name, version) =>
    fake.addPrompt({
      name,
      prompt: promptText(name, version),
      labels: ["production"],
    });
  /** Per name: when version 2 existed, its refresh started and it applied. */
  const records = PROMPT_NAMES.map((name) => ({ name }));
  try {
    await pool(PROMPT_NAMES.length, 10, (i) => addVersion(PROMPT_NAMES[i], 1));
    const syncedFrom = Date.now();
    const sync = await client.action(api.syncPrompts, {});
    if (sync.status !== "ok" || sync.tracked !== PROMPT_NAMES.length) {
      throw new Error(`prompts.sync returned ${JSON.stringify(sync)}`);
    }
    await waitFor(
      "every name cached at version 1",
      async () =>
        (await client.query(api.promptHealth, {})).tracked ===
          PROMPT_NAMES.length &&
        (await cachedVersions()).every((version) => version === 1),
      10 * 60_000,
      1_000,
    );
    const syncedAt = Date.now();
    const syncRequests = (await fake.stats()).promptRequests.length;
    console.log(
      `${PROMPT_NAMES.length} names cached at version 1 after ` +
        `${seconds(syncedAt - syncedFrom)} s; waiting about 20 min for the tick`,
    );

    // Version 2 of every name, without a webhook: only the tick refreshes.
    await pool(PROMPT_NAMES.length, 10, async (i) => {
      records[i].createdAt = (await addVersion(PROMPT_NAMES[i], 2)).createdAt;
    });
    const deadline =
      Math.max(...records.map((r) => r.createdAt)) + APPLY_BOUND_MS;
    while (
      records.some((r) => r.appliedAt === undefined) &&
      Date.now() <= deadline
    ) {
      const versions = await cachedVersions();
      const at = Date.now();
      versions.forEach((version, i) => {
        if (version === 2) records[i].appliedAt ??= at;
      });
      await sleep(1_000);
    }
    const stoppedAt = Date.now();

    const byName = new Map(records.map((r) => [r.name, r]));
    let refreshRequests = 0;
    for (const request of (await fake.stats()).promptRequests) {
      const record = byName.get(request.name);
      if (request.route !== REFRESH_START || !record) continue;
      if (request.at < record.createdAt) continue;
      refreshRequests += 1;
      record.refreshAt ??= request.at;
    }
    const starts = records.flatMap((r) => r.refreshAt ?? []);
    const applied = records.flatMap((r) => r.appliedAt ?? []);
    const firstStart = starts.length > 0 ? Math.min(...starts) : undefined;
    const span =
      firstStart === undefined ? undefined : Math.max(...starts) - firstStart;
    const notApplied = records.filter((r) => r.appliedAt === undefined);
    // A name not applied reached at least its age when the driver stopped.
    const maxAge = Math.max(
      ...records.map((r) => (r.appliedAt ?? stoppedAt) - r.createdAt),
    );
    const promptRuns = (await env.executions()).filter((log) =>
      PROMPT_FUNCTION.test(log.identifier),
    );
    const failed = promptRuns
      .filter((log) => log.error)
      .map(
        (log) =>
          `${log.identifier}: ${String(log.error).split("\n")[0].slice(0, 160)}`,
      );
    const refreshRuns = promptRuns.filter((log) =>
      /:refresh$/.test(log.identifier),
    ).length;
    writeFileSync(join(env.stateDir, "prompts.json"), JSON.stringify(records));
    return {
      diagnostics: env.stateDir,
      metrics: {
        names: PROMPT_NAMES.length,
        syncSeconds: seconds(syncedAt - syncedFrom),
        syncRequests,
        tickAt:
          firstStart === undefined ? null : new Date(firstStart).toISOString(),
        tickAfterSyncSeconds:
          firstStart === undefined ? null : seconds(firstStart - syncedFrom),
        refreshRequests,
        startSpanSeconds: span === undefined ? null : seconds(span),
        lastAppliedSeconds:
          firstStart === undefined || applied.length === 0
            ? null
            : seconds(Math.max(...applied) - firstStart),
        maxAgeSeconds: seconds(maxAge),
        notApplied: notApplied.length,
        failedPromptExecutions: failed.length,
      },
      checks: [
        check(
          "every name applied within 25 min of version 2",
          notApplied.length === 0 && maxAge <= APPLY_BOUND_MS,
          `${notApplied.length} not applied` +
            (notApplied[0] ? `, first ${notApplied[0].name}` : "") +
            `, largest age ${seconds(maxAge)} s`,
        ),
        check(
          "refresh starts span 99 s to 130 s",
          span !== undefined &&
            span >= START_SPAN_MS.min &&
            span <= START_SPAN_MS.max,
          span === undefined
            ? "no refresh started"
            : `${seconds(span)} s over ${starts.length} names`,
        ),
        check(
          "no failed prompts:* execution",
          failed.length === 0 && refreshRuns > 0,
          failed[0] ??
            `${promptRuns.length} executions logged, ${refreshRuns} refreshes`,
        ),
      ],
    };
  } finally {
    await env.teardown();
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    kill: { type: "boolean", default: false },
    out: { type: "string" },
  },
});

const DRIVERS = {
  load: (binary) => loadDriver(binary),
  outage: (binary) => outageDriver(binary),
  threshold: (binary) => thresholdDriver(binary, { kill: false }),
  "threshold --kill": (binary) => thresholdDriver(binary, { kill: true }),
  prompts: (binary) => promptsDriver(binary),
};

async function main() {
  const [name] = positionals;
  if (name !== undefined && !(name in DRIVERS)) {
    throw new Error(
      `unknown driver ${name}; use load, outage, threshold or prompts`,
    );
  }
  const selected =
    name === undefined
      ? Object.keys(DRIVERS)
      : [name === "threshold" && options.kill ? "threshold --kill" : name];
  const binary = await ensureBinary();
  linkPackage();
  const results = {};
  let failed = false;
  for (const driver of selected) {
    const startedAt = Date.now();
    console.log(`\n${driver}: started ${new Date(startedAt).toISOString()}`);
    let result;
    try {
      result = await DRIVERS[driver](binary);
    } catch (error) {
      result = {
        metrics: {},
        checks: [check("driver ran", false, String(error?.message ?? error))],
      };
    }
    result.seconds = seconds(Date.now() - startedAt);
    results[driver] = result;
    failed ||= result.checks.some((c) => !c.ok);
    console.log(
      `\n${driver} on ${RELEASE} (${releaseTarget()}), ${result.seconds} s`,
    );
    console.table(
      Array.isArray(result.metrics) ? result.metrics : [result.metrics],
    );
    console.table(
      result.checks.map((c) => ({
        check: c.check,
        result: c.ok ? "pass" : "FAIL",
        detail: c.detail,
      })),
    );
    if (failed) break;
  }
  if (options.out) {
    writeFileSync(options.out, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`results written to ${options.out}`);
  }
  process.exitCode = failed ? 1 : 0;
}

try {
  await main();
} catch (error) {
  console.error(`load failed: ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  stopAll();
}
