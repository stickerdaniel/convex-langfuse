// End-to-end check of scores and trace deletion against a Langfuse instance.
//
//   npm run build
//   LANGFUSE_BASE_URL=... LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... \
//     node e2e/scores.mjs [--characterize] [--out results.json]
//   node e2e/scores.mjs --fake [--characterize]
//
// Deploys the host app in `e2e/convex` to a Convex backend: the one named by
// CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY, or else a local
// backend started like the integration run. Binds the Langfuse env and the
// environment `convex-langfuse-e2e` through the app. `--fake` runs against
// `integration/fake-langfuse.mjs` instead of the env values.
//
// Gate: a score with a synced `configId` is read back through
// `GET /api/public/v3/scores?id=` within 90 s, and a trace deletion request
// built by the component is accepted with a 2xx. The acceptance is read from
// the exporter's counters, so it is checked only on a backend the script
// started; on another backend, other writers move the same counters, and the
// gate reports the request as enqueued.
//
// `--characterize` also runs, once idle and once while `--load` (2,000)
// unrelated scores are posted through the component, `--reps` (20)
// repetitions of create then create with another value, create then delete,
// and delete then create, `--gap-ms` (3,000) apart. It waits until the
// component's outbox is empty, then reads each score 30 s and 90 s later. It records whether a deleted trace
// disappears from `GET /api/public/v2/observations?traceId=`, prints a table
// and writes every result as JSON to `--out`. It exits non-zero when an idle
// repetition is wrong at the second read. A control first deletes a score
// through the public API: Langfuse applies score deletions at one per 120 s
// with its default limit, so while the control's deletion is not applied
// within 60 s, repetitions that end with a deletion are not evaluated.
//
// Every trace the run creates is deleted at the end, and its scores with it.
// Score configs
// stay: Langfuse has no deletion for them, and the next run reuses them.

import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { convexCli, sleep, stopAll, waitFor } from "../integration/backend.mjs";
import {
  connectBackend,
  ENVIRONMENT,
  langfuseSettings,
  publicApi,
} from "./shared.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const api = anyApi.e2e;
const { convex, setEnv, linkPackage } = convexCli(HERE);

const { values: options } = parseArgs({
  options: {
    characterize: { type: "boolean", default: false },
    fake: { type: "boolean", default: false },
    out: { type: "string" },
    reps: { type: "string", default: "20" },
    load: { type: "string", default: "2000" },
    "gap-ms": { type: "string", default: "3000" },
  },
});
const REPS = Number(options.reps);
const LOAD = Number(options.load);
const GAP_MS = Number(options["gap-ms"]);

const randomTraceId = () => randomBytes(16).toString("hex");
/** The score config of the host app, `RATING` in `e2e/convex/e2e.ts`. */
const RATING = "convex-langfuse-e2e-rating";
const newScoreId = () => `${ENVIRONMENT}-${randomUUID()}`;
const chunks = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

/** Reads from the Langfuse public API with the key pair. */
function langfuseApi(settings) {
  const { get, send } = publicApi(settings);
  return {
    /** Creates a score through the public API, without the component. */
    async createScore(score) {
      return (await send("POST", "/api/public/scores", score)).status;
    },
    /** Deletes a score through the public API, without the component. */
    async deleteScore(id) {
      const path = `/api/public/scores/${encodeURIComponent(id)}`;
      return (await send("DELETE", path)).status;
    },
    /** The score with this id, or `null`. */
    async score(id) {
      const { data } = await get(
        `/api/public/v3/scores?id=${encodeURIComponent(id)}&fields=core,details`,
      );
      return data.find((score) => score.id === id) ?? null;
    },
    /** The number of observations Langfuse holds for a trace. */
    async observations(traceId) {
      const { data } = await get(
        `/api/public/v2/observations?traceId=${traceId}`,
      );
      return data.length;
    },
  };
}

/** Waits until the component's outbox is empty. */
async function drained(client, timeoutMs) {
  await waitFor(
    "an empty outbox",
    async () => (await client.query(api.health, {})).pendingAtLeast === 0,
    timeoutMs,
    1_000,
  );
}

/**
 * Control for the repetitions that end with a deletion: creates a score
 * through the public API, waits until it is readable, deletes it through the
 * public API and waits up to 60 s for it to disappear. When the server does
 * not apply its own accepted deletion, the component cannot be judged on one.
 */
async function directDeletion(langfuse, traceId) {
  const id = newScoreId();
  await langfuse.createScore({
    id,
    timestamp: new Date().toISOString(),
    name: RATING,
    value: 1,
    dataType: "NUMERIC",
    traceId,
    environment: ENVIRONMENT,
  });
  const poll = async (present) => {
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      if (((await langfuse.score(id)) !== null) === present) {
        return (Date.now() - start) / 1_000;
      }
      await sleep(2_000);
    }
    return null;
  };
  const readableAfter = await poll(true);
  if (readableAfter === null) return { id, readableAfter, applied: false };
  const status = await langfuse.deleteScore(id);
  const goneAfter = await poll(false);
  return { id, readableAfter, status, goneAfter, applied: goneAfter !== null };
}

/** What a repetition writes, and the value the score must end with. */
const PATTERNS = {
  "create, create": {
    ops: [
      { op: "create", value: 1 },
      { op: "create", value: 2 },
    ],
    expected: 2,
  },
  "create, delete": {
    ops: [{ op: "create", value: 1 }, { op: "delete" }],
    expected: null,
  },
  "delete, create": {
    ops: [{ op: "delete" }, { op: "create", value: 3 }],
    expected: 3,
  },
};

async function main() {
  const settings = await langfuseSettings(options.fake);
  const langfuse = langfuseApi(settings);

  linkPackage();
  const { backend, owned, cleanup } = await connectBackend();
  const createdScores = [];
  const createdTraces = [];
  let client;
  try {
    await convex(backend, ["deploy", "--yes"]);
    const env = {
      LANGFUSE_PUBLIC_KEY: settings.publicKey,
      LANGFUSE_SECRET_KEY: settings.secretKey,
      LANGFUSE_BASE_URL: settings.baseUrl,
      LANGFUSE_TRACING_ENVIRONMENT: ENVIRONMENT,
    };
    for (const [name, value] of Object.entries(env)) {
      await setEnv(backend, name, value);
    }
    client = new ConvexHttpClient(backend.url);

    const score = async (ids, traceId, value, timestamp = Date.now()) => {
      createdScores.push(...ids);
      await client.mutation(api.score, { ids, traceId, value, timestamp });
    };
    const recordTrace = async () => {
      const traceId = randomTraceId();
      createdTraces.push(traceId);
      await client.mutation(api.recordTrace, { traceId });
      return traceId;
    };

    // ── Gate ───────────────────────────────────────────────────────────────
    const gate = [];
    const sync = await client.action(api.syncConfigs, {});
    if (sync.status !== "ok" || !sync.configId) {
      throw new Error(`score config sync: ${JSON.stringify(sync)}`);
    }
    const traceId = await recordTrace();
    const id = newScoreId();
    const sentAt = Date.now();
    await score([id], traceId, 7);
    const read = await waitFor(
      "the score in GET /api/public/v3/scores",
      async () => {
        const found = await langfuse.score(id);
        return found?.value === 7 && found;
      },
      90_000,
      2_000,
    );
    if (read.configId !== sync.configId || read.environment !== ENVIRONMENT) {
      throw new Error(
        `score read back with configId ${read.configId} and environment ${read.environment}`,
      );
    }
    gate.push(
      `score read back after ${((Date.now() - sentAt) / 1_000).toFixed(1)} s ` +
        `with the synced configId`,
    );

    await drained(client, 120_000);
    const before = await client.query(api.health, {});
    const deletion = await client.mutation(api.deleteTraces, {
      traceIds: [traceId],
    });
    if (!deletion.enqueued) throw new Error("trace deletion not enqueued");
    if (owned) {
      // Only this script writes to a backend it started, so the exporter's
      // counters moved for its deletion request alone.
      await drained(client, 120_000);
      const after = await client.query(api.health, {});
      if (
        after.accepted !== before.accepted + 1 ||
        after.deadLettersAtLeast !== before.deadLettersAtLeast ||
        after.lastErrorAt !== before.lastErrorAt
      ) {
        throw new Error(
          `trace deletion request not accepted: ${JSON.stringify({ before, after })}`,
        );
      }
      gate.push("trace deletion request accepted with a 2xx");
    } else {
      gate.push(
        "trace deletion request enqueued; acceptance not checked on a " +
          "backend this script did not start",
      );
    }
    console.log(`gate passed: ${gate.join("; ")}`);

    if (options.characterize) {
      await characterize({ client, langfuse, score, recordTrace });
    }
  } finally {
    if (client) {
      try {
        // Deleting a trace deletes its scores. One request per 100 traces
        // replaces one score deletion per score, which Langfuse applies at
        // one per 120 s with its default limit.
        for (const traceIds of chunks(createdTraces, 100)) {
          await client.mutation(api.deleteTraces, { traceIds });
        }
        await drained(client, 30 * 60_000);
        console.log(
          `cleanup: ${createdTraces.length} traces with ` +
            `${new Set(createdScores).size} scores deleted`,
        );
      } catch (error) {
        console.error(`cleanup failed: ${error?.message ?? error}`);
        process.exitCode = 1;
      }
    }
    stopAll();
    await sleep(200);
    cleanup();
  }
}

/**
 * Runs the repetitions once idle and once under load, and the trace
 * deletion read-back. Prints the table and writes the JSON results.
 */
async function characterize({ client, langfuse, score, recordTrace }) {
  const results = { reps: REPS, load: LOAD, gapMs: GAP_MS, phases: [] };

  const deletedTrace = await recordTrace();
  const visible = await waitFor(
    "the trace in GET /api/public/v2/observations",
    async () => (await langfuse.observations(deletedTrace)) > 0,
    120_000,
    2_000,
  ).then(
    () => true,
    () => false,
  );
  await client.mutation(api.deleteTraces, { traceIds: [deletedTrace] });
  const deletedAt = Date.now();

  results.directDeletion = await directDeletion(langfuse, await recordTrace());
  const deletionsApplied = results.directDeletion.applied;

  for (const phase of ["idle", "load"]) {
    const traceId = await recordTrace();
    let load = Promise.resolve();
    if (phase === "load") {
      const ids = Array.from({ length: LOAD }, newScoreId);
      load = (async () => {
        for (const batch of chunks(ids, 50)) await score(batch, traceId, 5);
      })();
    }
    const reps = Object.entries(PATTERNS).flatMap(([pattern, spec]) =>
      Array.from({ length: REPS }, (_, rep) => ({ pattern, spec, rep })),
    );
    // Every repetition enqueues its operations. The reads wait until the
    // component has sent them all: under load, an operation waits behind
    // the load's own, so a read at a fixed time would see the queue, not
    // what Langfuse stored.
    const written = await Promise.all(
      reps.map(async ({ pattern, spec, rep }) => {
        const id = newScoreId();
        const timestamp = Date.now();
        for (const [i, step] of spec.ops.entries()) {
          if (i > 0) await sleep(GAP_MS);
          if (step.op === "create") {
            await score([id], traceId, step.value, timestamp);
          } else {
            await client.mutation(api.deleteScores, { ids: [id] });
          }
        }
        return { pattern, spec, rep, id };
      }),
    );
    await load;
    await drained(client, 60 * 60_000);
    const drainedAt = Date.now();
    const readAll = async (seconds) => {
      await sleep(Math.max(0, drainedAt + seconds * 1_000 - Date.now()));
      return await Promise.all(
        written.map(
          async ({ id }) => (await langfuse.score(id))?.value ?? null,
        ),
      );
    };
    const [first, second] = [await readAll(30), await readAll(90)];
    const outcomes = written.map(({ pattern, spec, rep, id }, i) => {
      const ok = (value) => value === spec.expected;
      return {
        pattern,
        rep,
        id,
        expected: spec.expected,
        at30: first[i],
        at90: second[i],
        // A repetition that ends with a deletion says nothing about the
        // component while the server does not apply its own deletions.
        evaluated: spec.expected !== null || deletionsApplied,
        // The second read is the final state. Langfuse applies score
        // deletions in batches, so a deleted score can still show at the
        // first read.
        correct: ok(second[i]),
      };
    });
    results.phases.push({ phase, outcomes });
  }

  const sinceDeletion = async (seconds) => {
    await sleep(Math.max(0, deletedAt + seconds * 1_000 - Date.now()));
    return await langfuse.observations(deletedTrace);
  };
  results.traceDeletion = {
    visibleBeforeDeletion: visible,
    observationsAt30: await sinceDeletion(30),
    observationsAt90: await sinceDeletion(90),
  };

  console.table(
    results.phases.flatMap(({ phase, outcomes }) =>
      Object.keys(PATTERNS).map((pattern) => {
        const rows = outcomes.filter((o) => o.pattern === pattern);
        return {
          phase,
          pattern,
          repetitions: rows.length,
          "right at 30 s": rows.filter((o) => o.at30 === o.expected).length,
          "right at 90 s": rows.filter((o) => o.at90 === o.expected).length,
          correct: rows.filter((o) => o.correct).length,
          evaluated: rows.filter((o) => o.evaluated).length,
        };
      }),
    ),
  );
  const { readableAfter, goneAfter, status } = results.directDeletion;
  console.log(
    deletionsApplied
      ? `direct deletion through the public API: readable after ${readableAfter} s, gone ${goneAfter} s after the DELETE`
      : `direct deletion through the public API: HTTP ${status}, not applied within 60 s; repetitions that end with a deletion are not evaluated`,
  );
  console.log(
    `deleted trace: visible before ${results.traceDeletion.visibleBeforeDeletion}, ` +
      `observations at 30 s ${results.traceDeletion.observationsAt30}, ` +
      `at 90 s ${results.traceDeletion.observationsAt90}`,
  );
  if (options.out) {
    writeFileSync(options.out, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`results written to ${options.out}`);
  }
  const wrongIdle = results.phases
    .find(({ phase }) => phase === "idle")
    .outcomes.filter((o) => o.evaluated && !o.correct);
  if (wrongIdle.length > 0) {
    console.log(
      `STOP: ${wrongIdle.length} evaluated idle repetitions in the wrong state at 90 s`,
    );
    process.exitCode = 2;
  }
}

try {
  await main();
} catch (error) {
  console.error(`e2e failed: ${error?.message ?? error}`);
  process.exitCode = 1;
  stopAll();
}
