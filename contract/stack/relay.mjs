// Relay of the contract stack for the prompt and skill webhooks. Langfuse
// posts a webhook only to port 80 or 443, so this listens on port 80 inside
// the stack's network and forwards every request unchanged, with method, path,
// headers and body, to `RELAY_TARGET`, the Convex backend's HTTP actions on
// the host. The answer goes back unchanged too.

import { createServer, request } from "node:http";

const target = new URL(process.env.RELAY_TARGET);

createServer((incoming, outgoing) => {
  const forwarded = request(
    {
      hostname: target.hostname,
      port: target.port,
      method: incoming.method,
      path: incoming.url,
      headers: { ...incoming.headers, host: target.host },
    },
    (answer) => {
      outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(outgoing);
    },
  );
  forwarded.on("error", () => {
    outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(forwarded);
}).listen(80, () => console.log(`relay to ${target.host} listening on 80`));
