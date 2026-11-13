// Relay of the contract stack for the prompt and skill webhooks. Langfuse
// posts a webhook only to port 80 or 443, so this listens on port 80 inside
// the stack's network and forwards every request unchanged, with method, path,
// headers and body, to `RELAY_TARGET`, the Convex backend's HTTP actions on
// the host. The answer goes back unchanged too.
//
// It records each forwarded delivery: the relay clock's arrival time `at`,
// the path, the event's `type` and the name of its `skill` or `prompt`, and
// the status the route answered. It records no body and no header, so no
// signature. `GET /deliveries` on port 8080 returns `{ now, deliveries }`,
// with `now` from the relay's clock, so the runner can move `at` to its own.

import { createServer, request } from "node:http";

const target = new URL(process.env.RELAY_TARGET);
const deliveries = [];

/** The event type and name of a webhook body, or nothing it can read. */
function eventOf(body) {
  try {
    const event = JSON.parse(body.toString("utf8"));
    const name = event?.skill?.name ?? event?.prompt?.name;
    return {
      type: typeof event?.type === "string" ? event.type : undefined,
      name: typeof name === "string" ? name : undefined,
    };
  } catch {
    return {};
  }
}

createServer((incoming, outgoing) => {
  const at = Date.now();
  const chunks = [];
  incoming.on("data", (chunk) => chunks.push(chunk));
  incoming.on("end", () => {
    const body = Buffer.concat(chunks);
    const record = { at, path: incoming.url, ...eventOf(body), status: null };
    deliveries.push(record);
    const forwarded = request(
      {
        hostname: target.hostname,
        port: target.port,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, host: target.host },
      },
      (answer) => {
        record.status = answer.statusCode ?? 502;
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      },
    );
    forwarded.on("error", () => {
      record.status = 502;
      outgoing.writeHead(502);
      outgoing.end();
    });
    forwarded.end(body);
  });
}).listen(80, () => console.log(`relay to ${target.host} listening on 80`));

createServer((incoming, outgoing) => {
  outgoing
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ now: Date.now(), deliveries }));
}).listen(8080);
