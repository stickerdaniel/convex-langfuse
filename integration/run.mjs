// Integration run on a real Convex backend.
//
//   npm run build && npm run test:integration
//
// Downloads the `convex-local-backend` binary of RELEASE into
// `integration/.cache/`, starts it on free ports with its state in a temp
// directory, deploys the host app in `integration/convex`, which records
// through the `Langfuse` client, binds the component's env through the app,
// and runs the cases against the fake endpoint in `fake-langfuse.mjs`. Prints a result table and exits non-zero
// when a case fails. Every process it starts is stopped before it exits.

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { CLIENT_CALL_BYTES } from "../dist/shared/limits.js";
import { byteLength, encodeSpan } from "../dist/shared/otlp.js";
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
const nodeApi = anyApi.nodeHarness;
const { convex, streamLogs, linkPackage } = convexCli(HERE);

// ── Cases ──────────────────────────────────────────────────────────────────

const TRACE_IDS = {
  2: "a0000000000000000000000000000002",
  3: "a0000000000000000000000000000003",
  4: "a0000000000000000000000000000004",
  5: "a0000000000000000000000000000005",
  6: "a0000000000000000000000000000006",
  7: "a0000000000000000000000000000007",
  8: "a0000000000000000000000000000008",
  10: "a0000000000000000000000000000010",
};

/** First span id number of a case, so cases never share ids. */
const firstId = (caseNo) => caseNo * 1_000_000 + 1;
const hexId = (n) => n.toString(16).padStart(16, "0");

/**
 * Runs `count` record mutations of `size` spans each, `concurrency` at a
 * time. A mutation fails when the client could not enqueue every span,
 * unless `lenient` lets it log a closed gate instead. With `throttled`, a
 * mutation refused by the backend's write throughput limit is sent again
 * after a pause; that limit belongs to the local backend, not to the
 * component.
 */
async function recordMany(
  client,
  caseNo,
  { count, size, concurrency, throttled = false, lenient = false },
) {
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const i = next++;
      const args = {
        traceId: TRACE_IDS[caseNo],
        from: firstId(caseNo) + i * size,
        count: size,
        lenient,
      };
      for (;;) {
        try {
          await client.mutation(api.record, args, { skipQueue: true });
          break;
        } catch (error) {
          if (!throttled || !/TooManyWrites/.test(String(error))) throw error;
          await sleep(1_000);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

/**
 * Arguments for `nodeHarness.recordLarge` with `count` spans whose encoded
 * sizes, measured with the client's encoder, sum to just under `totalBytes`.
 */
function largeRecord(caseNo, count, totalBytes) {
  const traceId = TRACE_IDS[caseNo];
  const from = firstId(caseNo);
  const startTime = Date.now();
  const encodedBytes = (inputBytes) => {
    let sum = 0;
    for (let n = from; n < from + count; n++) {
      sum += byteLength(
        encodeSpan(
          { traceId, name: "integration" },
          {
            id: hexId(n),
            type: "span",
            name: `span-${n}`,
            startTime,
            endTime: startTime,
            input: "x".repeat(inputBytes),
          },
        ),
      );
    }
    return sum;
  };
  const overhead = encodedBytes(0);
  const inputBytes = Math.floor((totalBytes - 1024 - overhead) / count);
  return {
    args: { traceId, from, count, inputBytes, startTime },
    bytes: encodedBytes(inputBytes),
  };
}

/**
 * Runs record mutations of `size` spans each, `concurrency` at a time, until
 * `stop`, which joins the workers and returns `{ at, from }` of every
 * committed mutation: its commit time and its first span id number. With
 * `paceMs`, a worker starts at most one mutation per `paceMs`. `commits` is
 * the number committed so far. A mutation refused by the local backend's
 * write throughput limit is sent again after a pause, until `stop`. `stop`
 * can be called again and throws the first other failure every time.
 */
function startLoad(client, caseNo, { size, concurrency, paceMs = 0 }) {
  const commits = [];
  let next = 0;
  let running = true;
  let failure;
  const worker = async () => {
    while (running) {
      const startedAt = Date.now();
      const args = {
        traceId: TRACE_IDS[caseNo],
        from: firstId(caseNo) + next++ * size,
        count: size,
      };
      while (running) {
        try {
          // The strict client throws when a span was not enqueued.
          await client.mutation(api.record, args, { skipQueue: true });
          commits.push({ at: Date.now(), from: args.from });
          break;
        } catch (error) {
          if (!/TooManyWrites/.test(String(error))) {
            failure ??= error;
            running = false;
            return;
          }
          await sleep(1_000);
        }
      }
      await sleep(Math.max(0, startedAt + paceMs - Date.now()));
    }
  };
  const workers = Promise.all(Array.from({ length: concurrency }, worker));
  return {
    commits: () => commits.length,
    async stop() {
      running = false;
      await workers;
      if (failure) throw failure;
      return commits;
    },
  };
}

/** Span ids of a case the fake endpoint has accepted with a 2xx. */
function received(stats, caseNo, total) {
  let count = 0;
  for (let n = firstId(caseNo); n < firstId(caseNo) + total; n++) {
    if (stats.accepted[hexId(n)]) count += 1;
  }
  return count;
}

/**
 * Span ids of committed load mutations the fake endpoint has not accepted.
 * A mutation given up at `stop` leaves a gap in the ids, so the committed
 * ranges are checked one by one.
 */
function missing(stats, commits, size) {
  let count = 0;
  for (const { from } of commits) {
    for (let n = from; n < from + size; n++) {
      if (!stats.accepted[hexId(n)]) count += 1;
    }
  }
  return count;
}

/**
 * Span ids whose span bytes differ between deliveries, refused ones
 * included.
 */
function divergent(stats) {
  return Object.entries(stats.spans).filter(
    ([, hashes]) => new Set(hashes).size > 1,
  );
}

/** Requests answered with a 2xx that carried a span id of a case. */
function acceptedDeliveries(stats, caseNo, total) {
  let count = 0;
  for (let n = firstId(caseNo); n < firstId(caseNo) + total; n++) {
    count += stats.accepted[hexId(n)] ?? 0;
  }
  return count;
}

async function main() {
  const binary = await ensureBinary();
  linkPackage();
  const stateDir = mkdtempSync(join(tmpdir(), "convex-langfuse-it-"));
  const backend = new Backend(binary, stateDir);
  const results = [];
  let fake;

  // `node integration/run.mjs 3 5` runs only cases 3 and 5.
  const only = process.argv.slice(2);
  // Failed function executions per case, from the backend's function log.
  const functionErrors = [];
  const runCase = async (name, body) => {
    if (only.length > 0 && !only.includes(name.split(" ")[0])) return;
    const startedAt = Date.now();
    const before = (await fake.stats()).requests;
    let logs = streamLogs(backend);
    const executions = [];
    // Case 3 restarts the backend, which ends the stream.
    const restartLogs = async () => {
      executions.push(...(await logs.stop()));
      logs = streamLogs(backend);
    };
    let finished = false;
    const finish = async () => {
      if (finished) return executions;
      finished = true;
      executions.push(...(await logs.stop()));
      for (const log of executions.filter((entry) => entry.error)) {
        functionErrors.push(
          `${name}: ${log.identifier}: ${String(log.error).split("\n")[0].slice(0, 160)}`,
        );
      }
      return executions;
    };
    try {
      const detail = await body({ finish, restartLogs });
      await finish();
      results.push({
        name,
        ok: true,
        ms: Date.now() - startedAt,
        requests: (await fake.stats()).requests - before,
        detail,
      });
    } catch (error) {
      await finish();
      results.push({
        name,
        ok: false,
        ms: Date.now() - startedAt,
        requests: (await fake.stats()).requests - before,
        detail: String(error?.message ?? error),
      });
    }
  };

  try {
    fake = await startFake();
    await backend.init();
    await backend.start();
    await convex(backend, ["deploy", "--yes"]);
    const keys = {
      LANGFUSE_PUBLIC_KEY: "pk-lf-integration",
      LANGFUSE_SECRET_KEY: "sk-lf-integration",
      LANGFUSE_BASE_URL: fake.url,
    };
    for (const [name, value] of Object.entries(keys)) {
      await convex(backend, ["env", "set", name, value]);
    }
    const client = new ConvexHttpClient(backend.url);

    await runCase("1 env binding", async () => {
      if (!(await client.query(api.enabled, {}))) {
        throw new Error("component disabled with all env values bound");
      }
      await convex(backend, ["env", "remove", "LANGFUSE_BASE_URL"]);
      await waitFor(
        "disabled",
        async () => !(await client.query(api.enabled, {})),
        10_000,
      );
      await convex(backend, [
        "env",
        "set",
        "LANGFUSE_BASE_URL",
        keys.LANGFUSE_BASE_URL,
      ]);
      await waitFor(
        "enabled again",
        async () => await client.query(api.enabled, {}),
        10_000,
      );
      return "enabled with env, disabled without LANGFUSE_BASE_URL";
    });

    await runCase("2 concurrency", async () => {
      const total = 2_000;
      await recordMany(client, 2, { count: 200, size: 10, concurrency: 200 });
      await waitFor(
        "2,000 span ids",
        async () => received(await fake.stats(), 2, total) === total,
        180_000,
      );
      return `200 mutations committed, ${total} distinct span ids`;
    });

    await runCase("3 restart in flight", async ({ restartLogs }) => {
      const total = 300;
      await fake.control({ mode: "delay", delayMs: 15_000 });
      await recordMany(client, 3, { count: 6, size: 50, concurrency: 1 });
      // The request the backend dies in: the fake has received it and holds
      // its answer back, so the exporter never learns that it was accepted.
      const atKill = await waitFor(
        "a request in flight",
        async () => {
          const stats = await fake.stats();
          return stats.inflightLog.length > 0 && stats;
        },
        30_000,
        100,
      );
      const inflight = atKill.inflightLog.map((index) => atKill.log[index]);
      const seenAtKill = atKill.log.length;
      await backend.kill();
      await fake.control({ mode: "healthy" });
      await backend.start();
      await restartLogs();
      const stats = await waitFor(
        "every row after restart",
        async () => {
          const stats = await fake.stats();
          return received(stats, 3, total) === total && stats;
        },
        360_000,
        1_000,
      );
      // Recovery must send the in-flight batch again, with the same bytes.
      // A resend counts whatever its answer, so `stats.spans` holds it.
      const afterKill = stats.log.slice(seenAtKill);
      for (const { bodyHash, spanIds } of inflight) {
        if (!afterKill.some((request) => request.bodyHash === bodyHash)) {
          throw new Error("the in-flight request was not sent again unchanged");
        }
        const once = spanIds.filter((id) => stats.spans[id].length < 2);
        if (once.length > 0) {
          throw new Error(`${once.length} in-flight spans were not resent`);
        }
      }
      await waitFor(
        "an empty outbox",
        async () => (await client.query(api.backlog, {})).pendingAtLeast === 0,
        60_000,
      );
      const diverging = divergent(stats);
      if (diverging.length > 0) {
        throw new Error(`${diverging.length} span ids with different bytes`);
      }
      const resent = inflight.reduce((sum, r) => sum + r.spanIds.length, 0);
      return (
        `${total} span ids, ${acceptedDeliveries(stats, 3, total)} accepted ` +
        `deliveries, ${resent} in-flight spans resent with identical request bytes`
      );
    });

    await runCase("4 redeploy under load", async () => {
      const marker = join(HERE, "convex", "redeploy.ts");
      // Load runs until it is stopped, so the deploy overlaps it by
      // construction: mutations must commit before, during and after it.
      const load = startLoad(client, 4, { size: 10, concurrency: 8 });
      let deployStart;
      let deployEnd;
      try {
        await waitFor(
          "load before the deploy",
          () => load.commits() >= 20,
          30_000,
          50,
        );
        writeFileSync(
          marker,
          `import { query } from "./_generated/server";\n` +
            `export const marker = query({ args: {}, handler: async () => ${Date.now()} });\n`,
        );
        deployStart = Date.now();
        await convex(backend, [
          "deploy",
          "--yes",
          "--codegen",
          "disable",
          "--typecheck",
          "disable",
        ]);
        deployEnd = Date.now();
        const atEnd = load.commits();
        await waitFor(
          "load after the deploy",
          () => load.commits() >= atEnd + 20,
          30_000,
          50,
        );
      } finally {
        rmSync(marker, { force: true });
        // Joins the workers also after a failed deploy, so none of them
        // enqueues into the later cases. A load failure is thrown below.
        await load.stop().catch(() => {});
      }
      const commits = await load.stop();
      const before = commits.filter(({ at }) => at < deployStart).length;
      const during = commits.filter(
        ({ at }) => at >= deployStart && at <= deployEnd,
      ).length;
      const after = commits.filter(({ at }) => at > deployEnd).length;
      if (before === 0 || during === 0 || after === 0) {
        throw new Error(
          `commits before/during/after the deploy: ${before}/${during}/${after}`,
        );
      }
      const total = commits.length * 10;
      await waitFor(
        "every span id after the redeploy",
        async () => missing(await fake.stats(), commits, 10) === 0,
        180_000,
      );
      return (
        `${before}/${during}/${after} mutations committed before/during/after ` +
        `the deploy, ${total} distinct span ids`
      );
    });

    await runCase("5 gate closes", async ({ finish }) => {
      await fake.control({ mode: "down" });
      await recordMany(client, 5, {
        count: 500,
        size: 50,
        concurrency: 4,
        throttled: true,
        lenient: true,
      });
      await client.mutation(api.record, {
        traceId: TRACE_IDS[5],
        from: firstId(5) + 25_000,
        count: 1,
        lenient: true,
      });
      const backlog = await waitFor(
        "the gate to close",
        async () => {
          const backlog = await client.query(api.backlog, {});
          return !backlog.accepting && backlog;
        },
        240_000,
        1_000,
      );
      const refused = await client
        .mutation(api.record, {
          traceId: TRACE_IDS[5],
          from: firstId(5) + 25_001,
          count: 1,
        })
        .then(
          () => "committed",
          (error) => String(error),
        );
      if (!/\bbacklog\b/.test(refused)) {
        throw new Error(`record did not refuse: ${refused.slice(0, 200)}`);
      }
      const counts = (await finish()).filter((log) =>
        /outbox(\.js)?:count/.test(log.identifier),
      );
      const failed = counts.filter((log) => log.error);
      if (counts.length === 0) throw new Error("no outbox:count in the log");
      if (failed.length > 0) {
        throw new Error(`outbox:count failed: ${failed[0].error}`);
      }
      const longestMs = Math.max(
        ...counts.map((log) => log.executionTime * 1_000),
      );
      if (longestMs > 5_000) {
        throw new Error(`outbox:count took ${longestMs.toFixed(0)} ms`);
      }
      return (
        `closed at ${backlog.pendingCounted} counted rows, record throws ` +
        `backlog; ${counts.length} count steps, longest ${longestMs.toFixed(0)} ms`
      );
    });

    await runCase("6 progress under sustained enqueue", async ({ finish }) => {
      const logOffset = backend.logSize();
      await fake.control({ mode: "healthy" });
      // Start from an empty outbox: with few rows waiting, a claim reads up
      // to the newest row, which is where enqueues write.
      await waitFor(
        "an open gate and an empty outbox",
        async () => {
          const backlog = await client.query(api.backlog, {});
          return backlog.accepting && backlog.pendingAtLeast === 0;
        },
        900_000,
        2_000,
      );
      const acceptedAt = async () =>
        (await client.query(api.backlog, {})).accepted;
      const requestsAt = async () => (await fake.stats()).requests;
      const WINDOWS = 3;
      const WINDOW_MS = 5_000;
      const PACE_MS = 100;
      const load6 = { commits: () => 0, windows: [] };
      let drainedAt;

      // Diagnostics for the detail and for the error message.
      const diagnostics = async () => {
        const executions = await finish();
        const during = (pattern, from, to) =>
          executions.filter(
            (log) =>
              pattern.test(log.identifier) &&
              log.timestamp * 1_000 >= from &&
              log.timestamp * 1_000 <= to,
          );
        const medianMs = (logs) => {
          const ms = logs.map((log) => log.executionTime * 1_000);
          ms.sort((a, b) => a - b);
          return ms.length === 0 ? "n/a" : ms[ms.length >> 1].toFixed(0);
        };
        const advance = /exporter(\.js)?:advance/;
        const { loadStart, loadEnd, requestsStart, requestsEnd } = load6;
        const counts = executions.filter((log) =>
          /outbox(\.js)?:count/.test(log.identifier),
        );
        const longestCount = Math.max(
          0,
          ...counts.map((log) => log.executionTime * 1_000),
        );
        const occ = backend
          .logLinesSince(logOffset)
          .filter((line) => /occ error|Optimistic concurrency/i.test(line));
        const rate =
          loadEnd === undefined
            ? "n/a"
            : (
                (requestsEnd - requestsStart) /
                ((loadEnd - loadStart) / 1_000)
              ).toFixed(1);
        const drain =
          drainedAt === undefined
            ? "not all arrived"
            : `${((drainedAt - loadEnd) / 1_000).toFixed(1)} s`;
        const seconds =
          loadEnd === undefined
            ? "n/a"
            : ((loadEnd - loadStart) / 1_000).toFixed(1);
        return {
          executions,
          text:
            `${load6.commits()} mutations in ${seconds} s, ${rate} requests/s ` +
            `during the load, every span id ${drain} after the load; ` +
            `advance median ${medianMs(during(advance, loadStart, loadStart + 5_000))} ms ` +
            `in the first 5 s, ${medianMs(during(advance, loadEnd - 5_000, loadEnd))} ms ` +
            `in the last 5 s; ${counts.length} count steps, longest ` +
            `${longestCount.toFixed(0)} ms; ${occ.length} OCC log lines`,
        };
      };

      let load;
      try {
        // Eight workers enqueue throughout, so the exporter always claims
        // next to a live insert range and competes with the enqueues for the
        // backend. The load runs for WINDOWS windows of WINDOW_MS. Each
        // worker starts at most one mutation of 10 spans per PACE_MS, so
        // about 12,400 rows arrive in all, below the gate's threshold of
        // 25,000 even if none were exported, and no mutation is refused on
        // any machine.
        load6.requestsStart = await requestsAt();
        load6.loadStart = Date.now();
        load = startLoad(client, 6, {
          size: 10,
          concurrency: 8,
          paceMs: PACE_MS,
        });
        load6.commits = load.commits;
        let last = await acceptedAt();
        let windowStart = Date.now();
        while (load6.windows.length < WINDOWS) {
          await sleep(100);
          if (Date.now() - windowStart < WINDOW_MS) continue;
          const now = await acceptedAt();
          load6.windows.push(now - last);
          last = now;
          windowStart = Date.now();
        }
        const commits = await load.stop();
        load6.loadEnd = Date.now();
        load6.requestsEnd = await requestsAt();
        // The exporter must keep accepting rows in every window of the load.
        if (load6.windows.some((accepted) => accepted === 0)) {
          throw new Error(
            `rows accepted per window: ${load6.windows.join(", ")}`,
          );
        }
        const total = commits.length * 10;
        await waitFor(
          "every span id",
          async () => missing(await fake.stats(), commits, 10) === 0,
          300_000,
        );
        drainedAt = Date.now();
        // The last answers must be applied before the log is read: an
        // exporter execution that fails after the last request counts too.
        await waitFor(
          "an empty outbox",
          async () =>
            (await client.query(api.backlog, {})).pendingAtLeast === 0,
          60_000,
        );
        const { executions, text } = await diagnostics();
        const failed = executions.filter(
          (log) =>
            log.error &&
            /exporter(\.js)?:(advance|dispatch|run)$/.test(log.identifier),
        );
        if (failed.length > 0) {
          throw new Error(
            `${failed.length} failed exporter executions, first ` +
              `${failed[0].identifier}: ${String(failed[0].error).split("\n")[0].slice(0, 120)}`,
          );
        }
        return (
          `${text}; accepted per window: ${load6.windows.join(", ")}; ` +
          `${total} distinct span ids`
        );
      } catch (error) {
        // A failure while the load runs must not leave it running.
        await load?.stop().catch(() => {});
        const { text } = await diagnostics();
        throw new Error(`${error?.message ?? error}; ${text}`);
      }
    });

    // One `trace.record` call from a Node action, `count` spans of
    // `totalBytes` encoded bytes in all. Every span must be exported.
    const recordFromNode = async (caseNo, count, totalBytes) => {
      const { args, bytes } = largeRecord(caseNo, count, totalBytes);
      const recorded = await client.action(nodeApi.recordLarge, args);
      if (recorded !== count) throw new Error(`recorded ${recorded}`);
      await waitFor(
        `${count} span ids`,
        async () => received(await fake.stats(), caseNo, count) === count,
        180_000,
      );
      return `${count} spans, ${bytes} encoded bytes in one trace.record call, all exported`;
    };

    await runCase("7 node action at the split budget", () =>
      recordFromNode(7, 30, CLIENT_CALL_BYTES),
    );

    await runCase("8 node action at twice the split budget", () =>
      recordFromNode(8, 60, 2 * CLIENT_CALL_BYTES),
    );

    await runCase("9 prompt webhook under httpPrefix", async () => {
      const name = "integration/greeting";
      const secret = `lf-whsec_${randomBytes(32).toString("hex")}`;
      await convex(backend, ["env", "set", "LANGFUSE_WEBHOOK_SECRET", secret]);
      const url = `${backend.siteUrl}/langfuse/prompt-webhook`;
      const post = (body, signature) =>
        fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(signature ? { "x-langfuse-signature": signature } : {}),
          },
          body,
        });
      // Signed as `generateWebhookSignature` in Langfuse's `signature.ts`.
      const sign = (body) => {
        const t = Math.floor(Date.now() / 1_000);
        const hex = createHmac("sha256", secret)
          .update(`${t}.${body}`, "utf8")
          .digest("hex");
        return `t=${t},v1=${hex}`;
      };
      const event = (version) =>
        JSON.stringify({
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          type: "prompt-version",
          apiVersion: "v1",
          action: version === 1 ? "created" : "updated",
          prompt: { name, version, labels: ["production"] },
        });
      // The route answers 404 until the component sees the secret.
      const deliver = async (version) => {
        const body = event(version);
        const response = await waitFor(
          "a signed delivery to be answered",
          async () => {
            const response = await post(body, sign(body));
            return response.status !== 404 && response;
          },
          30_000,
        );
        const text = await response.text();
        if (response.status !== 200 || text !== "") {
          throw new Error(
            `signed delivery answered ${response.status} with ${text.length} bytes`,
          );
        }
      };
      const cached = (version) =>
        waitFor(
          `version ${version} in the cache`,
          async () => {
            const prompt = await client.query(api.prompt, { name });
            return prompt?.version === version && prompt;
          },
          30_000,
        );

      await fake.addPrompt({
        name,
        prompt: "Hello v1",
        labels: ["production"],
      });
      await deliver(1);
      const first = await cached(1);
      const body = event(1);
      const unsigned = await post(body);
      const zeros = `t=${Math.floor(Date.now() / 1_000)},v1=${"0".repeat(64)}`;
      const wrong = await post(body, zeros);
      if (unsigned.status !== 401 || wrong.status !== 401) {
        throw new Error(
          `unsigned ${unsigned.status}, wrongly signed ${wrong.status}`,
        );
      }

      await fake.addPrompt({
        name,
        prompt: "Hello v2",
        labels: ["production"],
      });
      await deliver(2);
      const second = await cached(2);
      if (first.text !== "Hello v1" || second.text !== "Hello v2") {
        throw new Error(`cached ${first.text} and ${second.text}`);
      }
      const fetched = (await fake.stats()).api["GET /v2/prompts/{name}"] ?? 0;
      return (
        `signed deliveries 200 with an empty body, unsigned and wrongly ` +
        `signed 401; versions 1 and 2 cached after ${fetched} prompt fetches`
      );
    });

    await runCase("10 a name cut inside an emoji", async () => {
      await client.mutation(api.recordCut, {
        traceId: TRACE_IDS[10],
        id: firstId(10),
      });
      await waitFor(
        "the span",
        async () => received(await fake.stats(), 10, 1) === 1,
        60_000,
      );
      const response = await fetch(
        `${fake.url}/api/public/v2/observations?traceId=${TRACE_IDS[10]}`,
        {
          headers: {
            authorization: `Basic ${btoa("pk-lf-integration:sk-lf-integration")}`,
          },
        },
      );
      const [observation] = (await response.json()).data;
      if (
        observation?.name !== "cut \ufffd" ||
        observation.input !== "whole 😀"
      ) {
        throw new Error(
          `received name ${JSON.stringify(observation?.name)}, input ${JSON.stringify(observation?.input)}`,
        );
      }
      return "the span arrived with U+FFFD in place of the lone surrogate";
    });

    const final = await fake.stats();
    const diverging = divergent(final);
    results.push({
      name: "the span bytes of every delivery of an id identical",
      ok: diverging.length === 0,
      ms: 0,
      requests: 0,
      detail: `${diverging.length} span ids with different bytes`,
    });
    results.push({
      name: "every request with credentials and the required headers",
      ok: final.badHeaders === 0,
      ms: 0,
      requests: 0,
      detail: `${final.badHeaders} without`,
    });
  } catch (error) {
    results.push({
      name: "setup",
      ok: false,
      ms: 0,
      requests: 0,
      detail: String(error?.message ?? error),
    });
  } finally {
    const failed = results.some((result) => !result.ok);
    console.log(
      `\nbackend ${RELEASE} (${releaseTarget()}), state ${stateDir}\n`,
    );
    console.table(
      results.map(({ name, ok, ms, requests, detail }) => ({
        case: name,
        result: ok ? "pass" : "FAIL",
        seconds: (ms / 1000).toFixed(1),
        requests,
        detail,
      })),
    );
    if (functionErrors.length > 0) {
      console.log(`failed function executions:\n${functionErrors.join("\n")}`);
    }
    if (failed) {
      console.log(`backend warnings and errors:\n${backend.logProblems()}`);
    }
    stopAll();
    await sleep(200);
    rmSync(stateDir, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
  }
}

await main();
