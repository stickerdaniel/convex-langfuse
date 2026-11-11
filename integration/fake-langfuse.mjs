// Fake Langfuse OTLP endpoint for the integration run.
//
//   node integration/fake-langfuse.mjs --port 0
//
// Prints `listening <port>` once ready. `POST /api/public/otel/v1/traces`
// records every span id with the hash of that span, then answers according to
// the mode. `POST /control` with `{ "mode": "healthy" | "status" | "delay" |
// "down", "status"?: number, "delayMs"?: number }` switches the mode;
// `GET /stats` returns what was received.

import { createHash } from "node:crypto";
import { createServer } from "node:http";

const ROUTE = "/api/public/otel/v1/traces";

let mode = { mode: "healthy" };
const stats = {
  requests: 0,
  inflight: 0,
  /** Requests without the headers the exporter must send. */
  badHeaders: 0,
  /** Span id to the hash of every delivery of that span. */
  spans: {},
};

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

function recordSpans(body) {
  const parsed = JSON.parse(body);
  for (const resource of parsed.resourceSpans) {
    for (const scope of resource.scopeSpans) {
      for (const span of scope.spans) {
        const hash = createHash("sha256")
          .update(JSON.stringify(span))
          .digest("hex")
          .slice(0, 16);
        (stats.spans[span.spanId] ??= []).push(hash);
      }
    }
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/stats") {
      return json(res, 200, stats);
    }
    if (req.method === "POST" && req.url === "/control") {
      mode = JSON.parse(await readBody(req));
      return json(res, 200, mode);
    }
    if (req.method !== "POST" || req.url !== ROUTE) {
      return json(res, 404, { error: "not found" });
    }
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
    recordSpans(body);
    if (mode.mode === "status") return json(res, mode.status, {});
    if (mode.mode === "delay") {
      stats.inflight += 1;
      await new Promise((resolve) => setTimeout(resolve, mode.delayMs));
      stats.inflight -= 1;
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
