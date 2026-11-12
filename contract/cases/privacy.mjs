// Cases for content and redaction, with the host app's `none`, `redacting`
// and `dropping` clients. A marker string of the run goes into every field
// a fixture removes. It must be absent from every request body the proxy
// recorded and from every read-back, and each fixture's kept values must
// arrive.

/** How long Langfuse may take to show a recorded observation. */
const VISIBLE_MS = 60_000;

/** Throws when `marker` is in a request body the proxy recorded. */
function expectNotSent(proxy, marker) {
  const leaks = proxy.records.filter((record) => record.body.includes(marker));
  if (leaks.length > 0) {
    throw new Error(`the marker left the app in ${leaks.length} requests`);
  }
}

/** Reads observations and throws when one holds `marker`. */
async function readWithout(observations, traceId, fields, marker) {
  const rows = await observations(traceId, fields);
  if (JSON.stringify(rows).includes(marker)) {
    throw new Error("the marker is in the read-back");
  }
  return rows;
}

const FIELDS = "core,basic,io,metadata,model,usage,trace_context";

export default [
  {
    name: 'redaction: content "none" without a hook',
    oracle: "recording proxy, Langfuse API",
    async run({
      runId,
      mutation,
      observations,
      proxy,
      poll,
      traceIdFromSeed,
      observationIdFromKey,
      rowDifferences,
      scopeMetadata,
    }) {
      const marker = `MARKER-none-${runId}`;
      const seed = `contract:${runId}:content-none`;
      const traceId = traceIdFromSeed(seed);
      await mutation("record", {
        client: "none",
        trace: { seed, name: "content-none", metadata: { traceKept: "yes" } },
        observations: [
          {
            key: "generation",
            type: "generation",
            name: "kept-name",
            startTime: Date.now() - 60_000,
            input: marker,
            output: { answer: marker },
            level: "ERROR",
            statusMessage: marker,
            model: `contract-model-${runId}`,
            usage: { input: 3 },
            metadata: { kept: "yes" },
          },
        ],
      });
      await poll(
        "the generation without input, output and status message",
        () => readWithout(observations, traceId, FIELDS, marker),
        (rows) =>
          rowDifferences(rows, [
            {
              id: observationIdFromKey(traceId, "generation"),
              name: "kept-name",
              traceName: "content-none",
              level: "ERROR",
              statusMessage: "",
              input: null,
              output: null,
              model: `contract-model-${runId}`,
              usageDetails: { input: 3, total: 3 },
              metadata: { traceKept: "yes", kept: "yes", ...scopeMetadata },
            },
          ]),
        VISIBLE_MS,
      );
      expectNotSent(proxy, marker);
    },
  },

  {
    name: 'redaction: content "full" with a hook that projects names, metadata and content',
    oracle: "recording proxy, Langfuse API",
    async run({
      runId,
      mutation,
      observations,
      proxy,
      poll,
      traceIdFromSeed,
      observationIdFromKey,
      rowDifferences,
      scopeMetadata,
    }) {
      const marker = `MARKER-hook-${runId}`;
      const seed = `contract:${runId}:redact`;
      const traceId = traceIdFromSeed(seed);
      await mutation("record", {
        client: "redacting",
        trace: {
          seed,
          name: `trace ${marker}`,
          userId: marker,
          sessionId: `session-${runId}`,
          metadata: { traceKept: "yes", secret: marker },
        },
        observations: [
          {
            key: "span",
            type: "span",
            name: `span ${marker}`,
            startTime: Date.now() - 60_000,
            input: { secret: marker },
            output: "kept output",
            metadata: { kept: "yes", secret: marker },
          },
        ],
      });
      await poll(
        "the span as the hook returned it",
        () => readWithout(observations, traceId, FIELDS, marker),
        (rows) =>
          rowDifferences(rows, [
            {
              id: observationIdFromKey(traceId, "span"),
              name: "redacted-observation",
              traceName: "redacted-trace",
              userId: "",
              sessionId: `session-${runId}`,
              input: "[redacted]",
              output: "kept output",
              metadata: { traceKept: "yes", kept: "yes", ...scopeMetadata },
            },
          ]),
        VISIBLE_MS,
      );
      expectNotSent(proxy, marker);
    },
  },

  {
    name: "redaction: a hook that returns null",
    oracle: "client result, recording proxy, Langfuse API",
    async run({
      runId,
      mutation,
      query,
      observations,
      proxy,
      poll,
      traceIdFromSeed,
      observationIdFromKey,
      differences,
      expectNone,
    }) {
      const marker = `MARKER-drop-${runId}`;
      const seed = `contract:${runId}:dropped`;
      const traceId = traceIdFromSeed(seed);
      const t = Date.now() - 60_000;
      const recorded = await mutation("record", {
        client: "dropping",
        trace: { seed },
        observations: [
          {
            key: "span",
            type: "span",
            name: marker,
            startTime: t,
            input: marker,
          },
        ],
      });
      expectNone(
        "client ids of the dropped record",
        differences(recorded, {
          traceId,
          observationIds: [observationIdFromKey(traceId, "span")],
        }),
      );
      // The outbox sends in order: once a later sentinel arrived and the
      // outbox is empty, anything the dropped record had enqueued was sent
      // and shows on the proxy.
      const sentinelSeed = `contract:${runId}:after-dropped`;
      const sentinel = traceIdFromSeed(sentinelSeed);
      await mutation("record", {
        client: "full",
        trace: { seed: sentinelSeed },
        observations: [
          { key: "span", type: "span", name: "sentinel", startTime: t },
        ],
      });
      await poll(
        "the sentinel in Langfuse",
        () => observations(sentinel, "core"),
        (rows) => (rows.length === 1 ? [] : [`${rows.length} observations`]),
        VISIBLE_MS,
      );
      await poll(
        "the outbox empty",
        () => query("health", {}),
        ({ pendingAtLeast }) =>
          pendingAtLeast === 0 ? [] : [`${pendingAtLeast} rows pending`],
        VISIBLE_MS,
      );
      const sent = proxy.records.filter((record) =>
        record.body.includes(traceId),
      );
      if (sent.length > 0)
        throw new Error(`${sent.length} requests for the trace`);
      const rows = await observations(traceId, "core");
      if (rows.length > 0)
        throw new Error(`${rows.length} observations in Langfuse`);
      expectNotSent(proxy, marker);
    },
  },
];
