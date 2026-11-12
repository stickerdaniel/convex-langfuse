// Fake Langfuse for the integration run and the end-to-end scripts.
//
//   node integration/fake-langfuse.mjs --port 0
//
// Prints `listening <port>` once ready. `POST /api/public/otel/v1/traces`
// records every span id with a hash of that span's content and every request
// with the hash of its raw body, then answers according to the mode. `POST
// /control` with `{ "mode": "healthy" | "status" | "delay" | "down",
// "status"?: number, "delayMs"?: number }` switches the mode of that route;
// `GET /stats` returns what was received.
//
// The public API routes the component and the end-to-end scripts use keep
// their state in memory and apply it at once: scores (`POST /scores`,
// `DELETE /scores/{id}`, `GET /v3/scores?id=`), score configs (`GET` and
// `POST /score-configs`), trace deletion (`DELETE /traces`) and observations
// of the received spans (`GET /v2/observations?traceId=`).

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const ROUTE = "/api/public/otel/v1/traces";

let mode = { mode: "healthy" };
const stats = {
  requests: 0,
  inflight: 0,
  /** Requests without the headers the exporter must send. */
  badHeaders: 0,
  /** Span id to the content hash of every delivery of that span. */
  spans: {},
  /** Every request in arrival order: raw body hash and span ids. */
  log: [],
  /** Indexes into `log` of the requests that are being delayed right now. */
  inflightLog: [],
  /** Public API requests by `<method> <route>`. */
  api: {},
};

/** Score id to the stored score. */
const scores = new Map();
const configs = [];
/** Trace id to the ids of its received spans. */
const observations = new Map();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

/** Records one request and returns its index in `stats.log`. */
function recordSpans(body) {
  const parsed = JSON.parse(body);
  const spanIds = [];
  stats.log.push({
    bodyHash: createHash("sha256").update(body).digest("hex"),
    spanIds,
  });
  for (const resource of parsed.resourceSpans) {
    for (const scope of resource.scopeSpans) {
      for (const span of scope.spans) {
        const hash = createHash("sha256")
          .update(JSON.stringify(span))
          .digest("hex")
          .slice(0, 16);
        (stats.spans[span.spanId] ??= []).push(hash);
        spanIds.push(span.spanId);
        if (!observations.has(span.traceId)) {
          observations.set(span.traceId, new Set());
        }
        observations.get(span.traceId).add(span.spanId);
      }
    }
  }
  return stats.log.length - 1;
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

/** Answers a public API request; returns false for an unknown route. */
async function publicApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\/public/, "");
  const key = `${req.method} ${route.replace(/^\/scores\/.+/, "/scores/{id}")}`;
  stats.api[key] = (stats.api[key] ?? 0) + 1;
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
  if (req.method === "GET" && route === "/v2/observations") {
    const traceId = url.searchParams.get("traceId");
    const data = [...(observations.get(traceId) ?? [])].map((id) => ({
      id,
      traceId,
    }));
    return json(res, 200, { data, meta: {} });
  }
  return false;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fake");
    if (req.method === "GET" && url.pathname === "/stats") {
      return json(res, 200, stats);
    }
    if (req.method === "POST" && url.pathname === "/control") {
      mode = JSON.parse(await readBody(req));
      return json(res, 200, mode);
    }
    if (url.pathname !== ROUTE) {
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
    if (
      !req.headers.authorization?.startsWith("Basic ") ||
      req.headers["x-langfuse-ingestion-version"] !== "4"
    ) {
      stats.badHeaders += 1;
    }
    const body = await readBody(req);
    const index = recordSpans(body);
    if (mode.mode === "status") return json(res, mode.status, {});
    if (mode.mode === "delay") {
      stats.inflight += 1;
      stats.inflightLog.push(index);
      await new Promise((resolve) => setTimeout(resolve, mode.delayMs));
      stats.inflight -= 1;
      stats.inflightLog = stats.inflightLog.filter((i) => i !== index);
    }
    return json(res, 200, {});
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
