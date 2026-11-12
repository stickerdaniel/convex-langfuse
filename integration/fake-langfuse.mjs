// Fake Langfuse for the integration run, the load drivers and the end-to-end
// scripts.
//
//   node integration/fake-langfuse.mjs --port 0
//
// Prints `listening <port>` once ready. `POST /api/public/otel/v1/traces`
// records every span id with a hash of that span's bytes and every request
// with the hash of its raw body, its arrival time and its answer, then
// answers according to the mode. A span id counts as accepted once per
// request that carried it and was answered with a 2xx, also when the client
// gave up before a held answer came. `POST /control` switches the mode of
// that route:
//
// - `{ "mode": "healthy" }` answers 200.
// - `{ "mode": "status", "status": number }` answers `status`.
// - `{ "mode": "delay", "delayMs": number }` answers 200 after `delayMs`.
// - `{ "mode": "down" }` closes the connection without an answer.
// - `{ "mode": "faults", "p500", "p429", "pDelay", "delayMs", "seed"? }`
//   draws one number per request from a pseudo-random sequence seeded with
//   `seed` (default 1) and answers 500, 429 with `Retry-After: 1`, 200 after
//   `delayMs`, or 200, with the given probabilities. Setting the mode restarts
//   the sequence, so two runs see the same answers.
//
// The OTLP route and every route under `/api/public` answer 401 without a
// Basic `Authorization` header that carries a public and a secret key, as
// Langfuse 4.78.0 does. The OTLP route answers 400 to a content type without
// `application/json`; Langfuse also takes protobuf, which this fake cannot
// read. The fake's own routes, `/stats` and `/control…`, take any request.
//
// `GET /stats` returns what was received; `GET /stats?summary=1` returns the
// counts only.
//
// The public API routes the component and the end-to-end scripts use keep
// their state in memory and apply it at once: scores (`POST /scores`,
// `DELETE /scores/{id}`, `GET /v3/scores?id=`), score configs (`GET` and
// `POST /score-configs`), trace deletion (`DELETE /traces`), the received
// spans as observations (`GET /v2/observations?traceId=`) and experiment items
// (`GET /experiment-items?fromStartTime=`), and prompts (`POST /v2/prompts`,
// `GET /v2/prompts?name=`, `GET /v2/prompts/{name}?label=|version=`, `DELETE
// /v2/prompts/{name}`, without references). Every prompt `GET` is logged in
// `stats.promptRequests` with its route, prompt name and arrival time. `POST
// /control/prompts` with `{ name, prompt, labels }` adds the next text version
// of a prompt, moves the labels to it and answers `{ version, createdAt }`.
// After `POST /control/webhook` with `{ url, secret }`, every created prompt
// version is posted to `url` as a signed `prompt-version` event.

import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const ROUTE = "/api/public/otel/v1/traces";

let mode = { mode: "healthy" };
/** The next draw of the `faults` mode, in [0, 1). */
let draw = mulberry32(1);
const stats = {
  requests: 0,
  inflight: 0,
  /**
   * Requests without the headers a client must send: an OTLP request without
   * a well-formed Basic `Authorization`, `x-langfuse-ingestion-version: 4` or
   * a JSON content type, and a public API request without a well-formed
   * Basic `Authorization`.
   */
  badHeaders: 0,
  /**
   * Span id to the hash of its span bytes in every request that carried it
   * and passed the credential and content type checks, whatever the answer.
   */
  spans: {},
  /** Span id to the number of requests that carried it and got a 2xx. */
  accepted: {},
  /**
   * Every request in arrival order: raw body hash, span ids, arrival time
   * and the status it was answered with, `null` until it is answered.
   */
  log: [],
  /** Indexes into `log` of the requests that are being delayed right now. */
  inflightLog: [],
  /** Answers the `faults` mode injected, by kind. */
  faults: { 500: 0, 429: 0, delay: 0 },
  /** Public API requests by `<method> <route>`. */
  api: {},
  /**
   * Every prompt `GET` in arrival order: `<method> <route>` as in `api`, the
   * prompt name (`null` for a listing without `name`) and the arrival time.
   */
  promptRequests: [],
};

/** Score id to the stored score. */
const scores = new Map();
const configs = [];
/** Trace id to its received spans, by span id; the last delivery wins. */
const observations = new Map();
/** Prompt name to its versions: `{ version, type, prompt, config, labels }`. */
const prompts = new Map();
/** Where created prompt versions are posted, or `null`. */
let webhook = null;
/** A prompt by name is answered after this many milliseconds. */
let promptHoldMs = 0;

/** A pseudo-random generator: the same seed gives the same sequence. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adds the next version of `name` and moves `labels` to it. */
function addPrompt({ name, type = "text", prompt, config = {}, labels = [] }) {
  const versions = prompts.get(name) ?? [];
  prompts.set(name, versions);
  for (const entry of versions) {
    entry.labels = entry.labels.filter((label) => !labels.includes(label));
  }
  const entry = {
    version: versions.length + 1,
    type,
    prompt,
    config: config ?? {},
    labels: [...labels],
  };
  versions.push(entry);
  if (webhook) void postWebhook(name, entry);
  return entry;
}

/** The prompt object the public API returns for one version. */
function promptBody(name, entry) {
  return {
    id: `${name}@${entry.version}`,
    name,
    version: entry.version,
    type: entry.type,
    prompt: entry.prompt,
    config: entry.config,
    labels: entry.labels,
    tags: [],
    resolutionGraph: null,
  };
}

/** Posts a `prompt-version` event, signed as Langfuse's `signature.ts` does. */
async function postWebhook(name, entry) {
  const body = JSON.stringify({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: "prompt-version",
    apiVersion: "v1",
    action: "created",
    prompt: {
      id: `${name}@${entry.version}`,
      name,
      version: entry.version,
      projectId: "fake",
      createdBy: "API",
      labels: entry.labels,
      prompt: entry.prompt,
      type: entry.type,
      config: entry.config,
      commitMessage: null,
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  const t = Math.floor(Date.now() / 1_000);
  const hex = createHmac("sha256", webhook.secret)
    .update(`${t}.${body}`, "utf8")
    .digest("hex");
  try {
    await fetch(webhook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-langfuse-signature": `t=${t},v1=${hex}`,
      },
      body,
    });
  } catch {
    // A webhook delivery that fails is not retried.
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

/** Raw span objects in the exporter's JSON body, including their whitespace. */
function rawSpans(body) {
  const spans = [];
  const arrays = /"spans"\s*:\s*\[/g;
  while (arrays.exec(body) !== null) {
    let depth = 0;
    let quoted = false;
    let start;
    for (let i = arrays.lastIndex; i < body.length; i++) {
      const char = body[i];
      if (quoted) {
        if (char === "\\") i += 1;
        else if (char === '"') quoted = false;
      } else if (char === '"') {
        quoted = true;
      } else if (char === "{" || char === "[") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (char === "}" || char === "]") {
        if (depth === 0) {
          arrays.lastIndex = i + 1;
          break;
        }
        depth -= 1;
        if (depth === 0) spans.push(body.slice(start, i + 1));
      }
    }
  }
  return spans;
}

/** Adds one request to `stats.log` and returns its entry. */
function logRequest(body) {
  const entry = {
    bodyHash: createHash("sha256").update(body).digest("hex"),
    spanIds: [],
    at: Date.now(),
    status: null,
  };
  stats.log.push(entry);
  return entry;
}

/**
 * Records one request and returns its entry in `stats.log`. The hash kept
 * per span id covers the bytes of that span object only. Resource and scope
 * are built per request, so they are not part of it.
 */
function recordSpans(body) {
  const parsed = JSON.parse(body);
  const raw = rawSpans(body);
  let next = 0;
  const entry = logRequest(body);
  for (const resource of parsed.resourceSpans) {
    const resourceAttributes = attributeMap(resource.resource?.attributes);
    for (const scope of resource.scopeSpans) {
      for (const span of scope.spans) {
        const hash = createHash("sha256").update(raw[next++]).digest("hex");
        (stats.spans[span.spanId] ??= []).push(hash);
        entry.spanIds.push(span.spanId);
        if (!observations.has(span.traceId)) {
          observations.set(span.traceId, new Map());
        }
        observations
          .get(span.traceId)
          .set(span.spanId, { span, scope: scope.scope, resourceAttributes });
      }
    }
  }
  return entry;
}

/** OTLP attributes as a plain object of their values. */
function attributeMap(attributes = []) {
  const map = {};
  for (const { key, value } of attributes) {
    if ("stringValue" in value) map[key] = value.stringValue;
    else if ("intValue" in value) map[key] = Number(value.intValue);
    else if ("arrayValue" in value) {
      map[key] = value.arrayValue.values.map((item) => item.stringValue);
    }
  }
  return map;
}

const parseJson = (text) => (text === undefined ? undefined : JSON.parse(text));
const nanosToIso = (nanos) =>
  new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString();

/**
 * A received span as `GET /api/public/v2/observations` returns it, with
 * every field group. Metadata is flat, as the events table stores it: the
 * observation and trace metadata's top-level keys, `resourceAttributes.*` and
 * `scope.*`, and `attributes.*` for every span attribute when the scope name
 * does not start with `langfuse-sdk`, which is what Langfuse does.
 */
function observationOf({ span, scope, resourceAttributes }) {
  const a = attributeMap(span.attributes);
  const usage = parseJson(a["langfuse.observation.usage_details"]);
  const cost = parseJson(a["langfuse.observation.cost_details"]);
  const metadata = {};
  for (const [key, value] of Object.entries(resourceAttributes)) {
    metadata[`resourceAttributes.${key}`] = value;
  }
  metadata["scope.name"] = scope.name;
  metadata["scope.version"] = scope.version;
  if (!scope.name.startsWith("langfuse-sdk")) {
    for (const [key, value] of Object.entries(a)) {
      metadata[`attributes.${key}`] = value;
    }
  }
  Object.assign(
    metadata,
    parseJson(a["langfuse.observation.metadata"]),
    parseJson(a["langfuse.trace.metadata"]),
  );
  const usageDetails =
    usage === undefined
      ? {}
      : {
          ...usage,
          total:
            usage.total ??
            Object.values(usage).reduce((sum, value) => sum + value, 0),
        };
  return {
    id: span.spanId,
    traceId: span.traceId,
    startTime: nanosToIso(span.startTimeUnixNano),
    endTime: nanosToIso(span.endTimeUnixNano),
    projectId: "fake",
    parentObservationId: span.parentSpanId ?? null,
    type: String(a["langfuse.observation.type"] ?? "span").toUpperCase(),
    name: span.name,
    level: a["langfuse.observation.level"] ?? "DEFAULT",
    version: a["langfuse.version"] ?? null,
    environment: a["langfuse.environment"] ?? "default",
    userId: a["user.id"] ?? null,
    sessionId: a["session.id"] ?? null,
    input: a["langfuse.observation.input"] ?? null,
    output: a["langfuse.observation.output"] ?? null,
    metadata,
    model: a["langfuse.observation.model.name"] ?? null,
    usageDetails,
    costDetails: cost ?? {},
    totalCost: cost?.total ?? null,
    promptId: null,
    promptName: a["langfuse.observation.prompt.name"] ?? null,
    promptVersion: a["langfuse.observation.prompt.version"] ?? null,
    traceName: a["langfuse.trace.name"] ?? null,
    tags: a["langfuse.trace.tags"] ?? [],
    release: a["langfuse.release"] ?? null,
    modelId: null,
    inputPrice: null,
    outputPrice: null,
    totalPrice: null,
    // Not part of the API: the experiment fields for `/experiment-items`.
    experiment: {
      id: a["langfuse.experiment.id"],
      name: a["langfuse.experiment.name"],
      datasetId: a["langfuse.experiment.dataset.id"] ?? null,
      itemId: a["langfuse.experiment.item.id"],
      rootObservationId: a["langfuse.experiment.item.root_observation_id"],
    },
  };
}

const DATA_TYPES = new Set(["NUMERIC", "BOOLEAN", "CATEGORICAL"]);

/** Whether a score body has the fields and value type Langfuse requires. */
function validScore(body) {
  if (typeof body.id !== "string" || typeof body.name !== "string") {
    return false;
  }
  if (!DATA_TYPES.has(body.dataType) || typeof body.traceId !== "string") {
    return false;
  }
  if (body.dataType === "CATEGORICAL") return typeof body.value === "string";
  if (body.dataType === "BOOLEAN") return body.value === 0 || body.value === 1;
  return typeof body.value === "number";
}

/** Whether a prompt body has the shape `CreatePromptSchema` accepts. */
function validPrompt(body) {
  if (typeof body.name !== "string" || body.name === "") return false;
  if (body.labels !== undefined && !Array.isArray(body.labels)) return false;
  if ((body.type ?? "text") === "text") return typeof body.prompt === "string";
  return (
    body.type === "chat" &&
    Array.isArray(body.prompt) &&
    body.prompt.every(
      (message) =>
        (typeof message.role === "string" &&
          typeof message.content === "string") ||
        (message.type === "placeholder" && typeof message.name === "string"),
    )
  );
}

/** Answers a public API request; returns false for an unknown route. */
async function publicApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\/public/, "");
  const key = `${req.method} ${route
    .replace(/^\/scores\/.+/, "/scores/{id}")
    .replace(/^\/v2\/prompts\/.+/, "/v2/prompts/{name}")}`;
  stats.api[key] = (stats.api[key] ?? 0) + 1;
  if (req.method === "GET" && route.startsWith("/v2/prompts")) {
    stats.promptRequests.push({
      route: key,
      name:
        route === "/v2/prompts"
          ? url.searchParams.get("name")
          : decodeURIComponent(route.slice("/v2/prompts/".length)),
      at: Date.now(),
    });
  }
  if (req.method === "POST" && route === "/scores") {
    const body = JSON.parse(await readBody(req));
    if (!validScore(body)) return json(res, 400, { message: "invalid" });
    scores.set(body.id, { ...body, createdAt: new Date().toISOString() });
    return json(res, 200, { id: body.id });
  }
  if (req.method === "DELETE" && route.startsWith("/scores/")) {
    scores.delete(decodeURIComponent(route.slice("/scores/".length)));
    return json(res, 202, { message: "Score deleted" });
  }
  if (req.method === "GET" && route === "/v3/scores") {
    const ids = (url.searchParams.get("id") ?? "").split(",");
    const data = ids
      .filter((id) => scores.has(id))
      .map((id) => {
        const score = scores.get(id);
        return {
          ...score,
          value: score.dataType === "BOOLEAN" ? score.value === 1 : score.value,
        };
      });
    return json(res, 200, { data, meta: { limit: 50 } });
  }
  if (route === "/score-configs") {
    if (req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const config = {
        ...body,
        id: randomUUID(),
        isArchived: false,
        createdAt: new Date().toISOString(),
        ...(body.dataType === "BOOLEAN"
          ? {
              categories: [
                { label: "True", value: 1 },
                { label: "False", value: 0 },
              ],
            }
          : {}),
      };
      configs.push(config);
      return json(res, 200, config);
    }
    const page = Number(url.searchParams.get("page") ?? 1);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const newest = [...configs].reverse();
    return json(res, 200, {
      data: newest.slice((page - 1) * limit, page * limit),
      meta: {
        page,
        limit,
        totalItems: newest.length,
        totalPages: Math.ceil(newest.length / limit),
      },
    });
  }
  if (req.method === "DELETE" && route === "/traces") {
    const { traceIds } = JSON.parse(await readBody(req));
    if (!Array.isArray(traceIds) || traceIds.length === 0) {
      return json(res, 400, { message: "invalid" });
    }
    for (const traceId of traceIds) observations.delete(traceId);
    return json(res, 200, { message: "Traces deleted successfully" });
  }
  if (req.method === "POST" && route === "/v2/prompts") {
    const body = JSON.parse(await readBody(req));
    if (!validPrompt(body)) return json(res, 400, { message: "invalid" });
    const entry = addPrompt(body);
    return json(res, 201, promptBody(body.name, entry));
  }
  if (req.method === "GET" && route === "/v2/prompts") {
    const name = url.searchParams.get("name");
    const page = Number(url.searchParams.get("page") ?? 1);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const names = [...prompts.keys()]
      .filter((item) => name === null || item === name)
      .sort();
    const data = names.slice((page - 1) * limit, page * limit).map((item) => ({
      name: item,
      versions: prompts.get(item).map((entry) => entry.version),
      labels: [...new Set(prompts.get(item).flatMap((e) => e.labels))].sort(),
      tags: [],
      lastUpdatedAt: new Date().toISOString(),
      type: prompts.get(item).at(-1).type,
      lastConfig: prompts.get(item).at(-1).config,
    }));
    const totalPages = Math.ceil(names.length / limit);
    const meta = { page, limit, totalPages, totalItems: names.length };
    // 4.78.0 repeats `meta` as `pagination` for older clients.
    return json(res, 200, { data, meta, pagination: meta });
  }
  if (req.method === "DELETE" && route.startsWith("/v2/prompts/")) {
    const name = decodeURIComponent(route.slice("/v2/prompts/".length));
    if (!prompts.delete(name)) {
      return json(res, 404, { message: "Prompt not found" });
    }
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "GET" && route.startsWith("/v2/prompts/")) {
    const name = decodeURIComponent(route.slice("/v2/prompts/".length));
    const version = url.searchParams.get("version");
    const label = url.searchParams.get("label") ?? "production";
    const entry = prompts
      .get(name)
      ?.find((item) =>
        version === null
          ? item.labels.includes(label)
          : item.version === Number(version),
      );
    if (!entry) return json(res, 404, { message: "Prompt not found" });
    if (promptHoldMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, promptHoldMs));
    }
    return json(res, 200, {
      ...promptBody(name, entry),
      isActive: entry.labels.includes("production"),
    });
  }
  if (req.method === "GET" && route === "/v2/observations") {
    const traceId = url.searchParams.get("traceId");
    const data = [...(observations.get(traceId)?.values() ?? [])].map(
      (received) => {
        const observation = observationOf(received);
        delete observation.experiment;
        return observation;
      },
    );
    return json(res, 200, { data, meta: {} });
  }
  if (req.method === "GET" && route === "/experiment-items") {
    const from = url.searchParams.get("fromStartTime");
    if (from === null || Number.isNaN(Date.parse(from))) {
      return json(res, 400, { message: "fromStartTime is required" });
    }
    const ids = url.searchParams.get("experimentId")?.split(",");
    const data = [...observations.values()]
      .flatMap((spans) => [...spans.values()].map(observationOf))
      .filter(
        ({ id, startTime, experiment }) =>
          experiment.id !== undefined &&
          experiment.rootObservationId === id &&
          Date.parse(startTime) >= Date.parse(from) &&
          (ids === undefined || ids.includes(experiment.id)),
      )
      .map(({ id, traceId, startTime, endTime, level, environment, ...o }) => ({
        id,
        traceId,
        startTime,
        endTime,
        level,
        environment,
        experimentId: o.experiment.id,
        experimentName: o.experiment.name,
        experimentItemId: o.experiment.itemId ?? "",
        experimentDatasetId: o.experiment.datasetId,
      }));
    return json(res, 200, { data, meta: {} });
  }
  return false;
}

/**
 * The counts of `stats`, without the per-span and per-request detail:
 * distinct span ids `attempted` and `accepted`, span `deliveries` in every
 * request and `acceptedDeliveries` in requests answered with a 2xx, and the
 * ids whose span bytes differ between deliveries.
 */
function summary() {
  let deliveries = 0;
  let divergent = 0;
  for (const hashes of Object.values(stats.spans)) {
    deliveries += hashes.length;
    if (new Set(hashes).size > 1) divergent += 1;
  }
  const accepted = Object.values(stats.accepted);
  return {
    requests: stats.requests,
    inflight: stats.inflight,
    badHeaders: stats.badHeaders,
    attempted: Object.keys(stats.spans).length,
    accepted: accepted.length,
    deliveries,
    acceptedDeliveries: accepted.reduce((sum, n) => sum + n, 0),
    divergent,
    faults: stats.faults,
  };
}

/**
 * Whether `header` is a Basic `Authorization` value with a public and a
 * secret key, the shape Langfuse's `extractBasicAuthCredentials` reads.
 */
function basicAuth(header) {
  if (!header?.startsWith("Basic ")) return false;
  const value = header.split(" ")[1];
  if (!value) return false;
  try {
    const [publicKey, secretKey] = atob(value).split(":");
    return Boolean(publicKey && secretKey);
  } catch {
    // Not base64.
    return false;
  }
}

/** Answers 401 as Langfuse's public API does without valid credentials. */
function unauthorized(res) {
  json(res, 401, {
    message: "Invalid authorization header",
    error: "UnauthorizedError",
  });
}

/** Waits `ms` while the request counts as in flight. */
async function hold(entry, ms) {
  const index = stats.log.indexOf(entry);
  stats.inflight += 1;
  stats.inflightLog.push(index);
  await new Promise((resolve) => setTimeout(resolve, ms));
  stats.inflight -= 1;
  stats.inflightLog = stats.inflightLog.filter((i) => i !== index);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fake");
    if (req.method === "GET" && url.pathname === "/stats") {
      return json(
        res,
        200,
        url.searchParams.has("summary") ? summary() : stats,
      );
    }
    if (req.method === "POST" && url.pathname === "/control/prompts") {
      const { version } = addPrompt(JSON.parse(await readBody(req)));
      return json(res, 200, { version, createdAt: Date.now() });
    }
    if (req.method === "POST" && url.pathname === "/control/webhook") {
      webhook = JSON.parse(await readBody(req));
      return json(res, 200, {});
    }
    if (req.method === "POST" && url.pathname === "/control/prompt-hold") {
      promptHoldMs = JSON.parse(await readBody(req)).ms;
      return json(res, 200, {});
    }
    if (req.method === "POST" && url.pathname === "/control") {
      mode = JSON.parse(await readBody(req));
      draw = mulberry32(mode.seed ?? 1);
      return json(res, 200, mode);
    }
    if (url.pathname !== ROUTE) {
      if (url.pathname.startsWith("/api/public/")) {
        if (!basicAuth(req.headers.authorization)) {
          stats.badHeaders += 1;
          return unauthorized(res);
        }
      }
      if ((await publicApi(req, res, url)) === false) {
        json(res, 404, { error: "not found" });
      }
      return;
    }
    if (req.method !== "POST") return json(res, 404, { error: "not found" });
    if (mode.mode === "down") {
      req.socket.destroy();
      return;
    }
    stats.requests += 1;
    const authorized = basicAuth(req.headers.authorization);
    const jsonBody = /application\/json/i.test(
      req.headers["content-type"] ?? "",
    );
    if (
      !authorized ||
      !jsonBody ||
      req.headers["x-langfuse-ingestion-version"] !== "4"
    ) {
      stats.badHeaders += 1;
    }
    // Langfuse authenticates before it reads the body, then checks the
    // content type. A refused request is logged without its spans.
    if (!authorized) {
      logRequest(await readBody(req)).status = 401;
      return unauthorized(res);
    }
    if (!jsonBody) {
      logRequest(await readBody(req)).status = 400;
      return json(res, 400, { error: "Invalid content type" });
    }
    const entry = recordSpans(await readBody(req));
    const answer = (status, headers) => {
      entry.status = status;
      if (status >= 200 && status < 300) {
        for (const id of entry.spanIds) {
          stats.accepted[id] = (stats.accepted[id] ?? 0) + 1;
        }
      }
      json(res, status, {}, headers);
    };
    if (mode.mode === "status") return answer(mode.status);
    if (mode.mode === "delay") await hold(entry, mode.delayMs);
    if (mode.mode === "faults") {
      const r = draw();
      if (r < mode.p500) {
        stats.faults[500] += 1;
        return answer(500);
      }
      if (r < mode.p500 + mode.p429) {
        stats.faults[429] += 1;
        return answer(429, { "retry-after": "1" });
      }
      if (r < mode.p500 + mode.p429 + mode.pDelay) {
        stats.faults.delay += 1;
        await hold(entry, mode.delayMs);
      }
    }
    return answer(200);
  } catch {
    if (!res.headersSent) json(res, 500, {});
  }
});

const portArg = process.argv.indexOf("--port");
const port = portArg === -1 ? 0 : Number(process.argv[portArg + 1]);
server.listen(port, "127.0.0.1", () => {
  console.log(`listening ${server.address().port}`);
});
process.on("SIGTERM", () => process.exit(0));
