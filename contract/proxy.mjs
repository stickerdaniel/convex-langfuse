// The recording proxy of the contract suite. The Convex backend's
// LANGFUSE_BASE_URL points here, so it sees exactly the component's requests
// to Langfuse and none of the runner's own. It forwards each request
// unchanged and records method, path, request body, the status Langfuse
// answered and whether the answer was dropped. It never records a header,
// so the Authorization header is not stored.
//
// Two faults:
// - `dropResponse(match)`: the next request for which `match(record)` is
//   true is forwarded and answered by Langfuse, and then the proxy closes
//   the connection instead of passing the answer on.
// - `refusePrompts(true)`: requests to `/api/public/v2/prompts` get 503
//   without reaching Langfuse, until `refusePrompts(false)`.

import { createServer } from "node:http";

/** Headers a tunnel in front of the proxy adds; Langfuse must not see them. */
const TUNNEL_HEADER = /^(cf-|cdn-loop$|x-forwarded-|x-real-ip$)/;

/**
 * Starts the proxy on 127.0.0.1 in front of `target`, the Langfuse web URL,
 * on `port` or on a free one.
 */
export async function startProxy(target, port = 0) {
  /** Every request the proxy received, in arrival order. */
  const records = [];
  let dropMatch;
  let refusingPrompts = false;

  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const record = {
      at: Date.now(),
      method: incoming.method,
      path: incoming.url,
      body: body.toString("utf8"),
      status: undefined,
      dropped: false,
    };
    records.push(record);

    if (refusingPrompts && record.path.startsWith("/api/public/v2/prompts")) {
      record.status = 503;
      outgoing.writeHead(503).end();
      return;
    }
    const headers = Object.fromEntries(
      Object.entries(incoming.headers).filter(
        ([name]) => !TUNNEL_HEADER.test(name),
      ),
    );
    delete headers.host;
    delete headers["content-length"];
    let answer;
    try {
      answer = await fetch(`${target}${record.path}`, {
        method: record.method,
        headers,
        body: body.length > 0 ? body : undefined,
        redirect: "manual",
      });
    } catch {
      record.status = 502;
      outgoing.writeHead(502).end();
      return;
    }
    const answered = Buffer.from(await answer.arrayBuffer());
    record.status = answer.status;
    if (dropMatch?.(record)) {
      dropMatch = undefined;
      record.dropped = true;
      outgoing.socket?.destroy();
      return;
    }
    const passed = Object.fromEntries(answer.headers);
    delete passed["content-encoding"];
    delete passed["content-length"];
    delete passed["transfer-encoding"];
    outgoing.writeHead(answer.status, passed).end(answered);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    records,
    dropResponse(match) {
      dropMatch = match;
    },
    refusePrompts(on) {
      refusingPrompts = on;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
