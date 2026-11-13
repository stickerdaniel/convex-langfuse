// Contract suite: proves on a real Langfuse that what the public client API
// promises arrives as documented.
//
//   npm run build && npm run test:contract [-- --langfuse 4.78.0] [-- --stack file.json]
//
// Starts the Langfuse stack of `contract/stack/` with the images of one entry
// of `contract/supported.json` (or of `--stack`), the pinned Convex local
// backend of `integration/backend.mjs` and the recording proxy of
// `proxy.mjs` between the two. Deploys the host app in `contract/convex`,
// whose functions call the `Langfuse` client, and runs the cases of
// `contract/cases/`. A case writes through the client, lets the component's
// outbox and exporter deliver to Langfuse, and compares what it reads back
// with literal values written in the case: from Langfuse's public API, from
// the client's result in Convex, or from the proxy's record of the
// component's requests. Each case names that oracle.
//
// Every run has an id. Every trace seed, prompt name, score id, model name
// and the environment carry it, and the stack runs as its own Compose
// project, so two runs at the same time share nothing. Every key, password
// and secret is generated per run. Those of the stack reach Docker and the
// containers through the environment only. The Convex backend takes its
// instance secret as an argument (`integration/backend.mjs`), which a local
// process can read while the run lasts. A run prints one line per case,
// writes its logs to `contract/logs/<run id>/` after scanning them for every
// generated secret, and removes what it started, also when it is interrupted.

import { execFile, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual, parseArgs, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import {
  Backend,
  convexCli,
  ensureBinary,
  RELEASE,
  sleep,
  stopAll,
} from "../integration/backend.mjs";
import { publicApi } from "../e2e/shared.mjs";
import { startProxy } from "./proxy.mjs";
import observations from "./cases/observations.mjs";
import scores from "./cases/scores.mjs";
import prompts from "./cases/prompts.mjs";
import privacy from "./cases/privacy.mjs";
import delivery from "./cases/delivery.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const COMPOSE_FILE = join(HERE, "stack", "compose.yml");
const { version: PACKAGE_VERSION } = JSON.parse(
  readFileSync(join(HERE, "..", "package.json"), "utf8"),
);
const run = promisify(execFile);

/** Every case, in the order the runner runs them. */
export const CASES = [
  ...observations,
  ...scores,
  ...prompts,
  ...privacy,
  ...delivery,
];

/** The stack must answer the canary within this time after `compose up`. */
const BOOT_DEADLINE_MS = 10 * 60_000;

/** First 32 hex characters of SHA-256 over the seed, as the README states. */
export const traceIdFromSeed = (seed) =>
  createHash("sha256").update(seed).digest("hex").slice(0, 32);
/** First 16 hex characters of SHA-256 over `<traceId>:<key>`. */
export const observationIdFromKey = (traceId, key) =>
  createHash("sha256").update(`${traceId}:${key}`).digest("hex").slice(0, 16);

/**
 * The keys of `expected` whose values in `actual` differ, as messages. Each
 * listed key is compared in full, so an expected object lists every key the
 * read-back must hold and no other.
 */
export function differences(actual, expected) {
  return Object.entries(expected).flatMap(([key, value]) =>
    isDeepStrictEqual(actual?.[key], value)
      ? []
      : [
          `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual?.[key])}`,
        ],
  );
}

/**
 * What differs between read rows and the expected rows: a missing or extra
 * id, or `differences` of a row and its expected fields. Rows are matched
 * by `id`; an id read twice counts as extra.
 */
export function rowDifferences(rows, expected) {
  const problems = expected.flatMap((fields) => {
    const matches = rows.filter((row) => row.id === fields.id);
    if (matches.length === 0) return [`${fields.id}: missing`];
    return matches.flatMap((row) =>
      differences(row, fields).map((problem) => `${fields.id}: ${problem}`),
    );
  });
  if (rows.length > expected.length) {
    problems.push(`${rows.length} rows, expected ${expected.length}`);
  }
  return problems;
}

/** The stack entry of `--langfuse` in `--stack`, or its first entry. */
function stackEntry(file, version) {
  const { stacks } = JSON.parse(readFileSync(file, "utf8"));
  const entry = version
    ? stacks.find((stack) => stack.langfuse === version)
    : stacks[0];
  if (!entry) throw new Error(`no stack for Langfuse ${version} in ${file}`);
  return entry;
}

/** Every value the stack needs, generated for one run. */
function generateSecrets() {
  const hex = (bytes) => randomBytes(bytes).toString("hex");
  return {
    POSTGRES_PASSWORD: hex(16),
    CLICKHOUSE_PASSWORD: hex(16),
    REDIS_PASSWORD: hex(16),
    MINIO_PASSWORD: hex(16),
    SALT: hex(32),
    ENCRYPTION_KEY: hex(32),
    NEXTAUTH_SECRET: hex(32),
    LANGFUSE_PUBLIC_KEY: `pk-lf-${hex(16)}`,
    LANGFUSE_SECRET_KEY: `sk-lf-${hex(16)}`,
    LANGFUSE_USER_PASSWORD: hex(16),
  };
}

/**
 * `docker compose` for one run's project. `env` carries the image references
 * and the secrets; they never reach a file or the command line.
 */
function composeFor(project, env) {
  const args = (rest) => [
    "compose",
    "-p",
    project,
    "-f",
    COMPOSE_FILE,
    ...rest,
  ];
  const options = { env: { ...process.env, ...env }, maxBuffer: 64 << 20 };
  const call = async (rest, timeout = 0) => {
    try {
      return (await run("docker", args(rest), { ...options, timeout })).stdout;
    } catch (error) {
      throw new Error(
        `docker compose ${rest[0]} failed: ${String(error.stderr).slice(-2_000)}`,
      );
    }
  };
  return {
    exec: (...rest) => call(rest),
    /**
     * `up --detach`, which starts each service once its dependencies are
     * healthy; killed after `timeoutMs`.
     */
    up: (timeoutMs) => call(["up", "--detach", "--quiet-pull"], timeoutMs),
    /** Removes every container, network and volume of the project. */
    downSync() {
      spawnSync(
        "docker",
        args(["down", "--volumes", "--remove-orphans", "--timeout", "5"]),
        { ...options, stdio: "ignore" },
      );
    },
  };
}

/** The summed memory of the project's containers in MiB, from `docker stats`. */
async function stackMemoryMib(project) {
  const { stdout: ids } = await run("docker", [
    "ps",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  if (ids.trim() === "") return 0;
  const { stdout } = await run("docker", [
    "stats",
    "--no-stream",
    "--format",
    "{{.MemUsage}}",
    ...ids.trim().split("\n"),
  ]);
  const units = { B: 1 / 2 ** 20, KiB: 1 / 1024, MiB: 1, GiB: 1024 };
  return stdout
    .trim()
    .split("\n")
    .map((line) => /^([\d.]+)(\w+)/.exec(line))
    .reduce((sum, match) => sum + Number(match[1]) * (units[match[2]] ?? 0), 0);
}

/**
 * Polls `read` until `check` of its result returns no difference or
 * `deadlineMs` passes. Returns the last result. On a timeout it throws with
 * the differences and the last response read; a read that throws keeps the
 * response before it. A result that matches after the deadline is a timeout
 * too. Records the time it needed in `steps`. `pauseMs` lies between two
 * reads.
 */
async function poll(steps, what, read, check, deadlineMs, pauseMs = 500) {
  const startedAt = Date.now();
  let last;
  let problems;
  for (;;) {
    try {
      const response = await read();
      last = response;
      problems = check(response);
    } catch (error) {
      problems = [String(error?.message ?? error)];
    }
    const ms = Date.now() - startedAt;
    if (ms > deadlineMs) {
      steps.push({ step: what, ms: null, deadlineMs });
      const late = `matched only after ${(ms / 1_000).toFixed(1)} s`;
      throw new Error(
        `${what}: not within ${deadlineMs / 1_000} s: ` +
          `${problems.join("; ") || late}\n` +
          `last response: ${JSON.stringify(last)?.slice(0, 4_000)}`,
      );
    }
    if (problems.length === 0) {
      steps.push({ step: what, ms, deadlineMs });
      return last;
    }
    await sleep(pauseMs);
  }
}

/** One OTLP/JSON span posted by the runner itself, not by the component. */
async function postSpan(langfuse, span) {
  const response = await langfuse.send("POST", "/api/public/otel/v1/traces", {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "contract-runner" } },
          ],
        },
        scopeSpans: [{ scope: { name: "contract-runner" }, spans: [span] }],
      },
    ],
  });
  if (!response.ok) throw new Error(`OTLP post: HTTP ${response.status}`);
}

/**
 * Signs in as the provisioned user and creates the prompt webhook through
 * the `automations.createAutomation` procedure, which the UI uses too.
 * Returns the signing secret Langfuse generated.
 */
async function createWebhook(webUrl, { email, password, projectId }) {
  const cookies = new Map();
  const keep = (response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const at = pair.indexOf("=");
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
  };
  const cookie = () =>
    [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  const csrf = await fetch(`${webUrl}/api/auth/csrf`);
  keep(csrf);
  const { csrfToken } = await csrf.json();
  const login = await fetch(`${webUrl}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookie(),
    },
    body: new URLSearchParams({ email, password, csrfToken, json: "true" }),
  });
  keep(login);
  if (!cookies.has("next-auth.session-token")) {
    throw new Error(`sign-in failed: HTTP ${login.status}`);
  }
  const created = await fetch(
    `${webUrl}/api/trpc/automations.createAutomation`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie() },
      body: JSON.stringify({
        json: {
          projectId,
          name: "convex-langfuse prompt webhook",
          eventSource: "prompt",
          eventAction: ["created", "updated", "deleted"],
          filter: [],
          status: "ACTIVE",
          actionType: "WEBHOOK",
          actionConfig: {
            type: "WEBHOOK",
            url: "http://webhook-relay/langfuse/prompt-webhook",
            apiVersion: { prompt: "v1" },
            requestHeaders: {},
          },
        },
      }),
    },
  );
  const body = await created.json();
  const secret = body?.result?.data?.json?.webhookSecret;
  if (!created.ok || typeof secret !== "string") {
    throw new Error(`webhook creation failed: HTTP ${created.status}`);
  }
  return secret;
}

/**
 * How a suite waits: every deadline of a case times `scale`, `pauseMs`
 * between two reads, and whether a deleted trace or score must be gone from
 * Langfuse.
 */
const DEFAULT_PACE = { scale: 1, pauseMs: 500, awaitRemoval: true };
/**
 * The pace for Langfuse Cloud. Its Hobby plan allows 30 requests per minute
 * on the read API, for the whole organization. It applies deletions in
 * batches: traces 4 to 19 minutes and scores 34 to 49 minutes after the
 * request, measured on 2026-11-13. So the suite takes
 * Langfuse's 2xx answer to the deletion request as proof.
 */
const CLOUD_PACE = { scale: 4, pauseMs: 3_000, awaitRemoval: false };

/**
 * Deploys the host app to `backend`, binds the component's settings and
 * returns the context every case gets, with `deploy` to deploy again and the
 * Convex CLI's `convex`. `backend` has `url` and either `adminKey` or, for a
 * Convex Cloud deployment, `deployKey`. `baseUrl` is where the component
 * reaches the proxy. `webhook` returns the signing secret of the prompt
 * webhook and runs once the host app is deployed.
 */
async function prepareCases({
  runId,
  backend,
  langfuse,
  proxy,
  baseUrl,
  keys,
  webhook,
  pace = DEFAULT_PACE,
}) {
  const { convex, setEnv, linkPackage } = convexCli(HERE);
  linkPackage();
  const deploy = () =>
    convex(backend, ["deploy", "--yes", "--codegen", "disable"]);
  await deploy();
  const environment = `contract-${runId}`;
  const settings = {
    LANGFUSE_PUBLIC_KEY: keys.publicKey,
    LANGFUSE_SECRET_KEY: keys.secretKey,
    LANGFUSE_BASE_URL: baseUrl,
    LANGFUSE_TRACING_ENVIRONMENT: environment,
    LANGFUSE_WEBHOOK_SECRET: await webhook(),
  };
  for (const [name, value] of Object.entries(settings)) {
    await setEnv(backend, name, value);
  }
  const client = new ConvexHttpClient(backend.url);
  const api = anyApi.contract;
  const context = {
    runId,
    environment,
    langfuse,
    proxy,
    traceIdFromSeed,
    observationIdFromKey,
    differences,
    rowDifferences,
    /**
     * The metadata Langfuse shows on every observation of the component
     * besides the caller's: its instrumentation scope and service name.
     */
    scopeMetadata: {
      "scope.name": "langfuse-sdk-convex",
      "scope.version": PACKAGE_VERSION,
      "resourceAttributes.service.name": "convex-langfuse",
    },
    /** Throws when `problems`, a result of `differences`, is not empty. */
    expectNone: (what, problems) => {
      if (problems.length > 0) {
        throw new Error(`${what}: ${problems.join("; ")}`);
      }
    },
    /** Whether a deleted trace or score must be gone from Langfuse. */
    awaitRemoval: pace.awaitRemoval,
    steps: [],
    postSpan: (span) => postSpan(langfuse, span),
    poll: (what, read, check, deadlineMs) =>
      poll(
        context.steps,
        what,
        read,
        check,
        deadlineMs * pace.scale,
        pace.pauseMs,
      ),
    mutation: (name, args) => client.mutation(api[name], args),
    query: (name, args) => client.query(api[name], args),
    action: (name, args) => client.action(api[name], args),
    /** Observations of a trace from `GET /api/public/v2/observations`. */
    observations: async (traceId, fields) =>
      (
        await langfuse.get(
          `/api/public/v2/observations?traceId=${traceId}&fields=${fields}&limit=100`,
        )
      ).data,
    /** Scores with this id from `GET /api/public/v3/scores`. */
    scores: async (id) =>
      (
        await langfuse.get(
          `/api/public/v3/scores?id=${encodeURIComponent(id)}` +
            "&fields=core,details,subject,annotation",
        )
      ).data,
    /**
     * Waits until the deletion of score `id` has its proof: Langfuse shows
     * no score with that id, or, where the pace does not wait for the
     * removal, Langfuse answered the component's deletion request with 2xx.
     */
    scoreDeleted: (what, id, deadlineMs) => {
      if (pace.awaitRemoval) {
        return context.poll(
          what,
          () => context.scores(id),
          (rows) => (rows.length === 0 ? [] : [`${rows.length} scores`]),
          deadlineMs,
        );
      }
      const path = `/api/public/scores/${encodeURIComponent(id)}`;
      return context.poll(
        `${what}: request accepted`,
        async () =>
          proxy.records
            .filter((r) => r.method === "DELETE" && r.path === path)
            .map((r) => r.status),
        (statuses) =>
          statuses.some((status) => status >= 200 && status < 300)
            ? []
            : [`deletion requests answered: ${statuses.join(", ") || "none"}`],
        deadlineMs,
      );
    },
  };
  return { context, deploy, convex };
}

/**
 * Returns `runCases(names)`: it runs the cases named in `names`, or all,
 * prints one line per case with its oracle and time, and returns the
 * results. `detail` of a failed case is its error message. The steps of
 * every case are added to `steps`.
 */
function caseRunner({ context, steps, print }) {
  return async (names) => {
    const results = [];
    for (const item of CASES) {
      if (names && !names.includes(item.name)) continue;
      const startedAt = Date.now();
      context.steps = [];
      let ok = true;
      let detail;
      try {
        detail = await item.run(context);
      } catch (error) {
        ok = false;
        detail = String(error?.message ?? error);
      }
      const seconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
      steps.push(
        ...context.steps.map((step) => ({ case: item.name, ...step })),
      );
      results.push({
        name: item.name,
        oracle: item.oracle,
        ok,
        seconds,
        detail,
      });
      print(
        `${ok ? "pass" : "FAIL"}  ${item.name}  [${item.oracle}]  ${seconds} s` +
          (detail ? `  ${detail}` : ""),
      );
    }
    return results;
  };
}

/**
 * Starts the stack, the backend and the proxy, and deploys the host app.
 * Returns `runCases`, `redeploy`, and `stop`, which writes the scanned logs
 * and removes everything the run started. When the start fails, it stops
 * and throws with the result of `stop` as `logs`. If the process exits
 * before `stop` ran, also on SIGINT or SIGTERM, the stack is removed
 * synchronously.
 */
export async function startSuite({ stackFile, version }) {
  const runId = randomBytes(4).toString("hex");
  const project = `convex-langfuse-contract-${runId}`;
  const stack = stackEntry(stackFile, version);
  const secrets = generateSecrets();
  const user = {
    email: `contract-${runId}@example.com`,
    password: secrets.LANGFUSE_USER_PASSWORD,
    projectId: `contract-project-${runId}`,
  };
  const stateDir = mkdtempSync(join(tmpdir(), "convex-langfuse-contract-"));
  const backend = new Backend(await ensureBinary(), stateDir);
  await backend.init();
  const compose = composeFor(project, {
    ...secrets,
    LANGFUSE_WEB_IMAGE: stack.images.web,
    LANGFUSE_WORKER_IMAGE: stack.images.worker,
    POSTGRES_IMAGE: stack.images.postgres,
    CLICKHOUSE_IMAGE: stack.images.clickhouse,
    REDIS_IMAGE: stack.images.redis,
    MINIO_IMAGE: stack.images.minio,
    LANGFUSE_INIT_ORG_ID: `contract-org-${runId}`,
    LANGFUSE_INIT_PROJECT_ID: user.projectId,
    LANGFUSE_USER_EMAIL: user.email,
    CONVEX_SITE_PORT: String(backend.sitePort),
  });

  const lines = [];
  const print = (line) => {
    lines.push(line);
    console.log(line);
  };
  const measures = { peakMemoryMib: 0 };
  const steps = [];
  let proxy;
  let webhookSecret;
  let stopped = false;
  process.on("exit", () => {
    if (stopped) return;
    compose.downSync();
    rmSync(stateDir, { recursive: true, force: true });
  });

  // Peak memory of the stack, sampled until `stop`.
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const mib = await stackMemoryMib(project).catch(() => 0);
      measures.peakMemoryMib = Math.max(measures.peakMemoryMib, mib);
      await sleep(2_000);
    }
  })();

  const stop = async () => {
    sampling = false;
    await sampler;
    const logs = await collectLogs({
      runId,
      lines,
      steps,
      measures,
      proxy,
      backend,
      compose,
      publicKey: secrets.LANGFUSE_PUBLIC_KEY,
      secrets: {
        ...secrets,
        "the Basic authorization of the key pair": Buffer.from(
          `${secrets.LANGFUSE_PUBLIC_KEY}:${secrets.LANGFUSE_SECRET_KEY}`,
        ).toString("base64"),
        "the backend's instance secret": backend.secret,
        "the backend's admin key": backend.adminKey,
        "the webhook secret": webhookSecret,
      },
    });
    await proxy?.stop();
    stopAll();
    await compose
      .exec("down", "--volumes", "--remove-orphans", "--timeout", "5")
      .catch(() => compose.downSync());
    stopped = true;
    rmSync(stateDir, { recursive: true, force: true });
    return logs;
  };

  /** Boots the stack in the readiness order and deploys the host app. */
  const boot = async () => {
    print(
      `run ${runId}: Langfuse ${stack.langfuse}, Convex backend ${RELEASE}, project ${project}`,
    );
    const pullStart = Date.now();
    await compose.exec("pull", "--quiet");
    const bootStart = Date.now();
    await compose.up(BOOT_DEADLINE_MS);
    const portOf = async (service, port) =>
      `http://${(await compose.exec("port", service, String(port))).trim()}`;
    const webUrl = await portOf("langfuse-web", 3000);
    const workerUrl = await portOf("langfuse-worker", 3030);
    const langfuse = publicApi({
      baseUrl: webUrl,
      publicKey: secrets.LANGFUSE_PUBLIC_KEY,
      secretKey: secrets.LANGFUSE_SECRET_KEY,
    });

    // Each step polls within what is left of the boot deadline.
    const left = () => BOOT_DEADLINE_MS - (Date.now() - bootStart);
    const status = async (url) => (await fetch(url)).status;
    const is200 = (code) => (code === 200 ? [] : [`HTTP ${code}`]);
    await poll(
      steps,
      "boot: Postgres, ClickHouse, Redis and MinIO healthy",
      () => compose.exec("ps", "--format", "json"),
      (text) => {
        // One JSON object per line, or one array in older Compose releases.
        const states = text.trimStart().startsWith("[")
          ? JSON.parse(text)
          : text
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
        return ["postgres", "clickhouse", "redis", "minio"].flatMap(
          (service) =>
            states.find((state) => state.Service === service)?.Health ===
            "healthy"
              ? []
              : [`${service} not healthy`],
        );
      },
      left(),
    );
    await poll(
      steps,
      "boot: web migrated, GET /api/public/health",
      () => status(`${webUrl}/api/public/health`),
      is200,
      left(),
    );
    await poll(
      steps,
      "boot: worker GET /api/ready",
      () => status(`${workerUrl}/api/ready`),
      is200,
      left(),
    );
    await poll(
      steps,
      "boot: authenticated GET /api/public/projects",
      () => langfuse.get("/api/public/projects"),
      ({ data }) =>
        data?.[0]?.id === user.projectId ? [] : ["provisioned project missing"],
      left(),
    );
    const canary = randomBytes(16).toString("hex");
    const canaryAt = `${Date.now()}000000`;
    await postSpan(langfuse, {
      traceId: canary,
      spanId: randomBytes(8).toString("hex"),
      name: "canary",
      kind: 1,
      startTimeUnixNano: canaryAt,
      endTimeUnixNano: canaryAt,
      attributes: [],
    });
    await poll(
      steps,
      "boot: canary span read back",
      () => langfuse.get(`/api/public/v2/observations?traceId=${canary}`),
      ({ data }) => (data.length === 1 ? [] : [`${data.length} observations`]),
      left(),
    );
    measures.pullMs = bootStart - pullStart;
    measures.bootMs = Date.now() - bootStart;
    print(
      `stack ready ${(measures.bootMs / 1_000).toFixed(1)} s after compose up ` +
        `(image pull ${(measures.pullMs / 1_000).toFixed(1)} s)`,
    );

    proxy = await startProxy(webUrl);
    await backend.start();
    return await prepareCases({
      runId,
      backend,
      langfuse,
      proxy,
      baseUrl: proxy.url,
      keys: {
        publicKey: secrets.LANGFUSE_PUBLIC_KEY,
        secretKey: secrets.LANGFUSE_SECRET_KEY,
      },
      webhook: async () => (webhookSecret = await createWebhook(webUrl, user)),
    });
  };

  let started;
  try {
    started = await boot();
  } catch (error) {
    error.logs = await stop();
    throw error;
  }
  const { context, deploy } = started;

  const runCases = caseRunner({ context, steps, print });
  return { runId, measures, print, runCases, redeploy: deploy, stop };
}

/**
 * The suite against a Langfuse instance and a Convex Cloud deployment that
 * exist already, such as Langfuse Cloud. It starts no stack and no backend.
 * CI does not run it, because it needs credentials. From the environment:
 *
 * - `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`: the
 *   Langfuse project. Use one for tests: the cases leave traces, scores and
 *   score configs in it.
 * - `CONVEX_URL`, `CONVEX_DEPLOY_KEY`: the deployment the host app is
 *   deployed to. Use one for tests: its functions are public.
 * - `LANGFUSE_WEBHOOK_SECRET`: the signing secret of a prompt webhook that
 *   the Langfuse project sends to `<site URL>/langfuse/prompt-webhook`.
 * - `CONTRACT_PROXY_PORT`, `CONTRACT_PROXY_URL`: the local port of the
 *   recording proxy, and the public URL of a tunnel to that port. The
 *   deployment sends to Langfuse through it, as the local backend does.
 *
 * `stop` unbinds the component's base URL, which disables the export, and
 * deletes the prompts of the run.
 */
export async function startCloudSuite({ pace = CLOUD_PACE } = {}) {
  const need = (name) => {
    const value = process.env[name];
    if (!value) throw new Error(`set ${name}`);
    return value;
  };
  const runId = randomBytes(4).toString("hex");
  const langfuseUrl = need("LANGFUSE_BASE_URL").replace(/\/+$/, "");
  const keys = {
    publicKey: need("LANGFUSE_PUBLIC_KEY"),
    secretKey: need("LANGFUSE_SECRET_KEY"),
  };
  const backend = {
    url: need("CONVEX_URL").replace(/\/+$/, ""),
    deployKey: need("CONVEX_DEPLOY_KEY"),
  };
  const webhookSecret = need("LANGFUSE_WEBHOOK_SECRET");
  const proxyUrl = need("CONTRACT_PROXY_URL").replace(/\/+$/, "");
  const proxyPort = Number(need("CONTRACT_PROXY_PORT"));

  const lines = [];
  const print = (line) => {
    lines.push(line);
    console.log(line);
  };
  const measures = { pace };
  const steps = [];
  const langfuse = publicApi({ baseUrl: langfuseUrl, ...keys });
  const proxy = await startProxy(langfuseUrl, proxyPort);
  let convex;

  const stop = async () => {
    // Without a base URL the component is disabled and exports nothing.
    await convex?.(backend, ["env", "remove", "LANGFUSE_BASE_URL"]).catch(
      (error) => print(`cleanup: ${String(error.message).split("\n")[0]}`),
    );
    await deletePrompts(langfuse, `contract-${runId}-`).catch((error) =>
      print(`cleanup: ${error.message}`),
    );
    const logs = await collectLogs({
      runId,
      lines,
      steps,
      measures,
      proxy,
      secrets: {
        "the Langfuse secret key": keys.secretKey,
        "the Basic authorization of the key pair": Buffer.from(
          `${keys.publicKey}:${keys.secretKey}`,
        ).toString("base64"),
        "the deploy key": backend.deployKey,
        "the webhook secret": webhookSecret,
      },
    });
    await proxy.stop();
    return logs;
  };

  const boot = async () => {
    const bootStart = Date.now();
    const health = await (
      await fetch(`${langfuseUrl}/api/public/health`)
    ).json();
    print(
      `run ${runId}: Langfuse ${health.version} at ${langfuseUrl}, ` +
        `Convex deployment ${backend.url}`,
    );
    // The tunnel must lead to this run's proxy.
    const probe = `/api/public/health?run=${runId}`;
    await fetch(`${proxyUrl}${probe}`).catch(() => undefined);
    if (!proxy.records.some((record) => record.path === probe)) {
      throw new Error(
        `${proxyUrl} does not lead to the proxy on port ${proxyPort}`,
      );
    }
    const canary = randomBytes(16).toString("hex");
    const canaryAt = `${Date.now()}000000`;
    await postSpan(langfuse, {
      traceId: canary,
      spanId: randomBytes(8).toString("hex"),
      name: "canary",
      kind: 1,
      startTimeUnixNano: canaryAt,
      endTimeUnixNano: canaryAt,
      attributes: [],
    });
    await poll(
      steps,
      "boot: canary span read back",
      () => langfuse.get(`/api/public/v2/observations?traceId=${canary}`),
      ({ data }) => (data.length === 1 ? [] : [`${data.length} observations`]),
      60_000 * pace.scale,
      pace.pauseMs,
    );
    const prepared = await prepareCases({
      runId,
      backend,
      langfuse,
      proxy,
      baseUrl: proxyUrl,
      keys,
      webhook: async () => webhookSecret,
      pace,
    });
    convex = prepared.convex;
    measures.bootMs = Date.now() - bootStart;
    return prepared;
  };

  let started;
  try {
    started = await boot();
  } catch (error) {
    error.logs = await stop();
    throw error;
  }
  const { context, deploy } = started;
  const runCases = caseRunner({ context, steps, print });
  return { runId, measures, print, runCases, redeploy: deploy, stop };
}

/** Deletes every prompt of the project whose name starts with `prefix`. */
async function deletePrompts(langfuse, prefix) {
  const names = [];
  for (let page = 1; ; page++) {
    const { data, meta } = await langfuse.get(
      `/api/public/v2/prompts?page=${page}&limit=100`,
    );
    names.push(...data.map((prompt) => prompt.name));
    if (page >= meta.totalPages) break;
  }
  for (const name of names.filter((name) => name.startsWith(prefix))) {
    await langfuse.send(
      "DELETE",
      `/api/public/v2/prompts/${encodeURIComponent(name)}`,
    );
  }
}

/**
 * Writes the run's output, step timings, proxy record and, where the run
 * started them, the backend log and the stack's container logs to a staging
 * folder, scans every file for every secret of the run, and only then moves
 * the folder to `contract/logs/<run id>/`. When a secret is found, the folder is deleted and the run fails;
 * the result names the secret and the file, never the value.
 *
 * Langfuse logs the public key of API requests in full by design
 * (`formatSubmittedPublicKeyForLog`), so the container logs replace
 * `publicKey` with a mask before the scan, which covers the public key too.
 */
async function collectLogs({
  runId,
  lines,
  steps,
  measures,
  proxy,
  backend,
  compose,
  secrets,
  publicKey,
}) {
  const logs = join(HERE, "logs");
  const staging = join(logs, `.${runId}`);
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "run.log"), `${lines.join("\n")}\n`);
  writeFileSync(
    join(staging, "measures.json"),
    `${JSON.stringify({ ...measures, steps }, null, 2)}\n`,
  );
  if (proxy) {
    writeFileSync(
      join(staging, "proxy.json"),
      `${JSON.stringify(proxy.records, null, 2)}\n`,
    );
  }
  if (backend?.logPath && existsSync(backend.logPath)) {
    copyFileSync(backend.logPath, join(staging, "backend.log"));
  }
  if (compose) {
    const containers = await compose
      .exec("logs", "--no-color", "--timestamps")
      .catch((error) => `docker compose logs failed: ${error.message}`);
    writeFileSync(
      join(staging, "stack.log"),
      containers.replaceAll(publicKey, "pk-lf-[masked]"),
    );
  }

  const leaks = readdirSync(staging).flatMap((file) => {
    const text = readFileSync(join(staging, file), "utf8");
    return Object.entries(secrets)
      .filter(([, value]) => value && text.includes(value))
      .map(([name]) => `${name} in ${file}`);
  });
  if (leaks.length > 0) {
    rmSync(staging, { recursive: true, force: true });
    return { leaks };
  }
  const folder = join(logs, runId);
  renameSync(staging, folder);
  return { leaks, folder };
}

/** Prints where the logs went, or which secret leaked into which file. */
export function reportLogs(logs) {
  if (!logs) return true;
  if (logs.leaks.length > 0) {
    console.error(
      `generated secrets in the logs: ${logs.leaks.join("; ")}; the logs were deleted`,
    );
    return false;
  }
  console.log(`logs in ${logs.folder}`);
  return true;
}

async function main() {
  const { values } = parseArgs({
    options: {
      stack: { type: "string", default: join(HERE, "supported.json") },
      langfuse: { type: "string" },
      cloud: { type: "boolean", default: false },
    },
  });
  const startedAt = Date.now();
  let failed = true;
  let logs;
  try {
    const suite = values.cloud
      ? await startCloudSuite()
      : await startSuite({ stackFile: values.stack, version: values.langfuse });
    try {
      const results = await suite.runCases();
      failed = results.some((result) => !result.ok);
      suite.print(
        `${results.filter((r) => r.ok).length} of ${results.length} cases passed; ` +
          `suite ${((Date.now() - startedAt) / 1_000).toFixed(1)} s, ` +
          (values.cloud
            ? `ready after ${(suite.measures.bootMs / 1_000).toFixed(1)} s`
            : `stack ready after ${(suite.measures.bootMs / 1_000).toFixed(1)} s, ` +
              `peak stack memory ${(suite.measures.peakMemoryMib / 1024).toFixed(2)} GiB`),
      );
    } finally {
      logs = await suite.stop();
    }
  } catch (error) {
    console.error(`contract run failed: ${error?.message ?? error}`);
    logs ??= error?.logs;
  }
  process.exitCode = reportLogs(logs) && !failed ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
