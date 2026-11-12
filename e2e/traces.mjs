// End-to-end check of traces and experiment items against a Langfuse
// instance.
//
//   npm run build
//   LANGFUSE_BASE_URL=... LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... \
//     node e2e/traces.mjs [--out results.json]
//   node e2e/traces.mjs --fake
//
// Deploys the host app in `e2e/convex` to the backend named by
// CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY, or to a local
// backend, and binds the Langfuse env and the environment
// `convex-langfuse-e2e` through the app. `--fake` runs against
// `integration/fake-langfuse.mjs` instead of the env values.
//
// Creates a text prompt through the public API and records one trace through
// the client: a root span and a generation nested under it, with usage of
// three keys, cost, a link to the prompt, tags, user id, session id,
// release, trace metadata and observation metadata. Reads both observations
// back through `GET /api/public/v2/observations?traceId=` and checks type,
// parent, usage, cost and total cost, prompt name and version, environment,
// release, tags, user id, session id, and that no metadata key starts with
// `attributes`. Then records the observations of one experiment item and
// waits for the item in `GET /api/public/experiment-items`. Both reads poll
// for up to `--timeout-s` (180) seconds, because Langfuse ingests
// asynchronously. Prints a table of the checks and exits non-zero when one
// fails.
//
// The run deletes its traces through the component and its prompt through
// `DELETE /api/public/v2/prompts/{name}` at the end.

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
const { convex, setEnv, linkPackage } = convexCli(HERE);

const { values: options } = parseArgs({
  options: {
    fake: { type: "boolean", default: false },
    out: { type: "string" },
    "timeout-s": { type: "string", default: "180" },
  },
});
const TIMEOUT_MS = Number(options["timeout-s"]) * 1_000;

const randomTraceId = () => randomBytes(16).toString("hex");
const suffix = randomUUID();

/** The field groups of `GET /api/public/v2/observations` the checks read. */
const FIELDS = "core,basic,metadata,model,usage,prompt,trace_context";

/** The trace the run records, apart from its ids and the prompt version. */
const FIXTURE = {
  name: ENVIRONMENT,
  userId: `${ENVIRONMENT}-user`,
  sessionId: `${ENVIRONMENT}-session-${suffix}`,
  tags: [`${ENVIRONMENT}`, `${ENVIRONMENT}-traces`],
  release: `${ENVIRONMENT}-release`,
  traceMetadata: { suite: "traces" },
  rootMetadata: { step: "root" },
  generation: {
    model: `${ENVIRONMENT}-model`,
    usage: { input: 120, output: 45, cache_read_input_tokens: 30 },
    cost: { input: 0.0012, output: 0.0009, cache_read_input_tokens: 0.0003 },
    metadata: { step: "generation", attempt: 1 },
  },
};

const close = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-9;
const sorted = (values) => [...(values ?? [])].sort().join(",");

/**
 * What differs between the read observations and the recorded ones, as a
 * list of messages; empty when every check holds.
 */
function compare(observations, { rootId, generationId, prompt }) {
  const root = observations.find((o) => o.id === rootId);
  const generation = observations.find((o) => o.id === generationId);
  if (!root || !generation) {
    return [`${observations.length} of 2 observations readable`];
  }
  const problems = [];
  const expect = (what, ok, actual) => {
    if (!ok) problems.push(`${what}: ${JSON.stringify(actual)}`);
  };
  expect("root type", root.type?.toUpperCase() === "SPAN", root.type);
  expect(
    "generation type",
    generation.type?.toUpperCase() === "GENERATION",
    generation.type,
  );
  expect(
    "root parent",
    root.parentObservationId == null,
    root.parentObservationId,
  );
  expect(
    "generation parent",
    generation.parentObservationId === rootId,
    generation.parentObservationId,
  );
  const { usage, cost } = FIXTURE.generation;
  for (const [key, value] of Object.entries(usage)) {
    expect(
      `usage ${key}`,
      generation.usageDetails?.[key] === value,
      generation.usageDetails,
    );
  }
  expect(
    "usage total",
    generation.usageDetails?.total ===
      Object.values(usage).reduce((sum, value) => sum + value, 0),
    generation.usageDetails,
  );
  for (const [key, value] of Object.entries(cost)) {
    expect(
      `cost ${key}`,
      close(generation.costDetails?.[key], value),
      generation.costDetails,
    );
  }
  const total = Object.values(cost).reduce((sum, value) => sum + value, 0);
  expect(
    "cost total",
    close(generation.costDetails?.total, total),
    generation.costDetails,
  );
  expect(
    "total cost",
    close(generation.totalCost, total),
    generation.totalCost,
  );
  expect(
    "prompt name",
    generation.promptName === prompt.name,
    generation.promptName,
  );
  expect(
    "prompt version",
    generation.promptVersion === prompt.version,
    generation.promptVersion,
  );
  for (const [label, o] of [
    ["root", root],
    ["generation", generation],
  ]) {
    expect(
      `${label} environment`,
      o.environment === ENVIRONMENT,
      o.environment,
    );
    expect(`${label} release`, o.release === FIXTURE.release, o.release);
    expect(`${label} tags`, sorted(o.tags) === sorted(FIXTURE.tags), o.tags);
    expect(`${label} user id`, o.userId === FIXTURE.userId, o.userId);
    expect(
      `${label} session id`,
      o.sessionId === FIXTURE.sessionId,
      o.sessionId,
    );
    const keys = Object.keys(o.metadata ?? {});
    const leaked = keys.filter(
      (key) => key === "attributes" || key.startsWith("attributes."),
    );
    expect(
      `${label} metadata without attributes.*`,
      leaked.length === 0,
      leaked,
    );
    expect(
      `${label} trace metadata`,
      o.metadata?.suite === "traces",
      o.metadata,
    );
    expect(
      `${label} observation metadata`,
      o.metadata?.step === label,
      o.metadata,
    );
  }
  expect(
    "generation attempt",
    generation.metadata?.attempt === 1,
    generation.metadata,
  );
  return problems;
}

/**
 * Polls `read` until `compare` of its result returns no problem or the
 * timeout passes. Returns the last result and its problems.
 */
async function poll(read, compareFn) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = { problems: ["not read"] };
  for (;;) {
    try {
      const value = await read();
      last = { value, problems: compareFn(value) };
    } catch (error) {
      last = { problems: [String(error?.message ?? error)] };
    }
    if (last.problems.length === 0 || Date.now() > deadline) return last;
    await sleep(3_000);
  }
}

async function main() {
  const settings = await langfuseSettings(options.fake);
  const langfuse = publicApi(settings);
  linkPackage();
  const { backend, cleanup } = await connectBackend();
  const checks = [];
  const createdTraces = [];
  const reads = {};
  let promptName;
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

    // The prompt the generation links to.
    promptName = `${ENVIRONMENT}-linked-${suffix}`;
    const created = await langfuse.send("POST", "/api/public/v2/prompts", {
      name: promptName,
      type: "text",
      prompt: "Answer the question.",
      labels: [],
    });
    if (created.status !== 201 && created.status !== 200) {
      throw new Error(`prompt creation: HTTP ${created.status}`);
    }
    const prompt = {
      name: promptName,
      version: (await created.json()).version,
    };

    // A trace with a root span and a nested generation.
    const traceId = randomTraceId();
    createdTraces.push(traceId);
    const startedAt = Date.now();
    const ids = await client.mutation(anyApi.traces.recordTrace, {
      traceId,
      ...FIXTURE,
      generation: { ...FIXTURE.generation, prompt },
    });
    const read = await poll(
      async () =>
        (
          await langfuse.get(
            `/api/public/v2/observations?traceId=${traceId}&fields=${FIELDS}&limit=50`,
          )
        ).data,
      (observations) => compare(observations, { ...ids, prompt }),
    );
    checks.push({
      check: "trace read back through GET /api/public/v2/observations",
      ok: read.problems.length === 0,
      detail:
        read.problems.length === 0
          ? `2 observations after ${((Date.now() - startedAt) / 1_000).toFixed(1)} s`
          : read.problems.join("; ").slice(0, 400),
    });

    // The observations of one experiment item.
    const experimentTraceId = randomTraceId();
    createdTraces.push(experimentTraceId);
    const experimentId = `${ENVIRONMENT}-${suffix}`;
    const itemId = `${ENVIRONMENT}-item-${suffix}`;
    const itemStartedAt = Date.now();
    const { rootId } = await client.mutation(
      anyApi.traces.recordExperimentItem,
      {
        traceId: experimentTraceId,
        name: ENVIRONMENT,
        experimentId,
        experimentName: `${ENVIRONMENT}-experiment`,
        itemId,
      },
    );
    const from = new Date(itemStartedAt - 10 * 60_000).toISOString();
    const item = await poll(
      async () =>
        (
          await langfuse.get(
            `/api/public/experiment-items?fromStartTime=${encodeURIComponent(from)}` +
              `&experimentId=${encodeURIComponent(experimentId)}`,
          )
        ).data,
      (items) => {
        const found = items.find((entry) => entry.id === rootId);
        if (!found) return [`${items.length} items, none with the root id`];
        const problems = [];
        if (found.traceId !== experimentTraceId) problems.push("trace id");
        if (found.experimentItemId !== itemId) problems.push("item id");
        if (found.environment !== ENVIRONMENT) problems.push("environment");
        return problems;
      },
    );
    checks.push({
      check: "experiment item in GET /api/public/experiment-items",
      ok: item.problems.length === 0,
      detail:
        item.problems.length === 0
          ? `after ${((Date.now() - itemStartedAt) / 1_000).toFixed(1)} s`
          : item.problems.join("; ").slice(0, 400),
    });
    reads.observations = read.value;
    reads.items = item.value;
  } catch (error) {
    checks.push({
      check: "run",
      ok: false,
      detail: String(error?.message ?? error),
    });
  } finally {
    const cleanupProblems = [];
    if (client && createdTraces.length > 0) {
      try {
        const drain = () =>
          waitFor(
            "an empty outbox",
            async () => {
              const health = await client.query(anyApi.e2e.health, {});
              return health.pendingAtLeast === 0 && health;
            },
            600_000,
            1_000,
          );
        const before = await drain();
        const deletion = await client.mutation(anyApi.e2e.deleteTraces, {
          traceIds: createdTraces,
        });
        if (!deletion.enqueued)
          cleanupProblems.push("trace deletion not enqueued");
        const after = await drain();
        if (
          after.accepted !== before.accepted + 1 ||
          after.deadLettersAtLeast !== before.deadLettersAtLeast
        ) {
          cleanupProblems.push("trace deletion was not accepted");
        }
      } catch (error) {
        cleanupProblems.push(`traces: ${error?.message ?? error}`);
      }
    }
    if (promptName) {
      try {
        const deleted = await langfuse.send(
          "DELETE",
          `/api/public/v2/prompts/${encodeURIComponent(promptName)}`,
        );
        if (!deleted.ok) cleanupProblems.push(`prompt: HTTP ${deleted.status}`);
      } catch (error) {
        cleanupProblems.push(`prompt: ${error?.message ?? error}`);
      }
    }
    checks.push({
      check: "cleanup",
      ok: cleanupProblems.length === 0,
      detail:
        cleanupProblems.join("; ") ||
        `deletion accepted for ${createdTraces.length} traces, 1 prompt deleted`,
    });
    console.table(
      checks.map(({ check, ok, detail }) => ({
        check,
        result: ok ? "pass" : "FAIL",
        detail,
      })),
    );
    if (options.out) {
      writeFileSync(
        options.out,
        `${JSON.stringify({ checks, ...reads }, null, 2)}\n`,
      );
    }
    process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
    stopAll();
    await sleep(200);
    cleanup();
  }
}

try {
  await main();
} catch (error) {
  console.error(`e2e failed: ${error?.message ?? error}`);
  process.exitCode = 1;
  stopAll();
}
