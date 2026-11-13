// Cases for delivery: a trace deletion request and a resend after a lost
// response. What Langfuse cannot show, the status it answered and what left
// the process twice, is read from the recording proxy.

/** How long Langfuse may take to show or remove an observation or score. */
const VISIBLE_MS = 60_000;
const DELETED_MS = 90_000;
/** How long the resend case counts the copies Langfuse returns. */
const COPIES_WINDOW_MS = 30_000;

const OTLP_PATH = "/api/public/otel/v1/traces";

/**
 * The bytes of the span with `spanId` in an OTLP/JSON request body: the
 * object that starts with its `traceId`, cut at its closing brace. Braces
 * inside strings are skipped.
 */
function spanBytes(body, traceId, spanId) {
  const start = body.indexOf(`{"traceId":"${traceId}","spanId":"${spanId}"`);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < body.length; i++) {
    const char = body[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return body.slice(start, i + 1);
  }
  return undefined;
}

export default [
  {
    name: "trace deletion",
    oracle: "client result, recording proxy, Langfuse API",
    async run({
      runId,
      mutation,
      observations,
      scores,
      proxy,
      poll,
      traceIdFromSeed,
      observationIdFromKey,
      differences,
      rowDifferences,
      expectNone,
      awaitRemoval,
    }) {
      const seed = `contract:${runId}:deleted`;
      const traceId = traceIdFromSeed(seed);
      const scoreId = `contract-${runId}-deleted`;
      const t = Date.now() - 60_000;
      await mutation("record", {
        client: "full",
        trace: { seed },
        observations: [
          { key: "root", type: "span", name: "root", startTime: t },
          {
            key: "child",
            parent: { key: "root" },
            type: "generation",
            name: "child",
            startTime: t + 10,
          },
        ],
      });
      await mutation("score", {
        score: { name: "contract-rating", value: 5 },
        id: scoreId,
        timestamp: t,
        trace: { seed },
      });
      await poll(
        "the trace's observations before the deletion",
        () => observations(traceId, "core"),
        (rows) =>
          rowDifferences(rows, [
            { id: observationIdFromKey(traceId, "root") },
            { id: observationIdFromKey(traceId, "child") },
          ]),
        VISIBLE_MS,
      );
      await poll(
        "the trace's score before the deletion",
        () => scores(scoreId),
        (rows) => (rows.length === 1 ? [] : [`${rows.length} scores`]),
        VISIBLE_MS,
      );

      expectNone(
        "deleteTraces result",
        differences(await mutation("deleteTraces", { traces: [{ seed }] }), {
          enqueued: true,
        }),
      );
      const request = await poll(
        "DELETE /api/public/traces answered",
        async () =>
          proxy.records.find(
            (r) =>
              r.method === "DELETE" &&
              r.path === "/api/public/traces" &&
              JSON.parse(r.body).traceIds?.includes(traceId) &&
              r.status !== undefined,
          ),
        (record) => (record ? [] : ["no deletion request yet"]),
        VISIBLE_MS,
      );
      expectNone(
        "deletion request",
        differences(request, { status: 200, dropped: false }),
      );
      expectNone(
        "deletion request body",
        differences(JSON.parse(request.body), { traceIds: [traceId] }),
      );
      // Langfuse Cloud applies deletions in batches; there the suite checks
      // only the 200 above.
      if (!awaitRemoval) return "deletion request answered 200";
      await poll(
        "the observations gone",
        () => observations(traceId, "core"),
        (rows) => (rows.length === 0 ? [] : [`${rows.length} observations`]),
        DELETED_MS,
      );
      await poll(
        "the score gone",
        () => scores(scoreId),
        (rows) => (rows.length === 0 ? [] : [`${rows.length} scores`]),
        DELETED_MS,
      );
    },
  },

  {
    name: "resend after a lost response",
    oracle: "recording proxy, Langfuse API",
    async run({
      runId,
      mutation,
      observations,
      proxy,
      poll,
      traceIdFromSeed,
      observationIdFromKey,
      differences,
      scopeMetadata,
      readPauseMs,
    }) {
      const seed = `contract:${runId}:resend`;
      const traceId = traceIdFromSeed(seed);
      const spanId = observationIdFromKey(traceId, "resent");
      const t = Date.now() - 60_000;
      proxy.dropResponse(
        (record) => record.path === OTLP_PATH && record.body.includes(spanId),
      );
      await mutation("record", {
        client: "full",
        trace: { seed },
        observations: [
          {
            key: "resent",
            type: "span",
            name: "resent",
            startTime: t,
            endTime: t + 250,
            input: "question",
            output: "answer",
            metadata: { attempt: "one" },
          },
        ],
      });
      const sent = await poll(
        "the original and the retry forwarded",
        async () =>
          proxy.records.filter(
            (r) => r.path === OTLP_PATH && r.body.includes(spanId),
          ),
        // Langfuse accepted the original with 200 before the proxy dropped
        // the answer. A refused original would make the retry the only
        // accepted write, which is no resend.
        (records) =>
          records.length >= 2 &&
          records[0].dropped &&
          records[0].status === 200 &&
          records.some((r) => !r.dropped && r.status === 200)
            ? []
            : [
                `${records.length} requests with the span: ` +
                  records
                    .map((r) => `${r.status}${r.dropped ? " dropped" : ""}`)
                    .join(", "),
              ],
        VISIBLE_MS,
      );
      const copies = new Set(
        sent.map((r) => spanBytes(r.body, traceId, spanId)),
      );
      if (copies.size !== 1 || copies.has(undefined)) {
        throw new Error(`${copies.size} different span encodings were sent`);
      }

      // Only fields the caller controls are compared across the copies.
      const expected = {
        id: spanId,
        traceId,
        type: "SPAN",
        name: "resent",
        startTime: new Date(t).toISOString(),
        endTime: new Date(t + 250).toISOString(),
        input: "question",
        output: "answer",
        metadata: { attempt: "one", ...scopeMetadata },
      };
      const read = () => observations(traceId, "core,basic,io,metadata");
      const compare = (rows) => {
        const rowsOfSpan = rows.filter((row) => row.id === spanId);
        if (rowsOfSpan.length === 0) return ["no copy yet"];
        return rowsOfSpan.flatMap((row) => differences(row, expected));
      };
      await poll("a copy of the span", read, compare, VISIBLE_MS);
      let mostCopies = 0;
      const windowEnd = Date.now() + COPIES_WINDOW_MS;
      while (Date.now() < windowEnd) {
        const rows = await read();
        const problems = compare(rows);
        if (problems.length > 0) throw new Error(problems.join("; "));
        mostCopies = Math.max(
          mostCopies,
          rows.filter((row) => row.id === spanId).length,
        );
        await new Promise((resolve) => setTimeout(resolve, readPauseMs));
      }
      return (
        `${sent.length} requests with identical span bytes; Langfuse returned ` +
        `at most ${mostCopies} ${mostCopies === 1 ? "copy" : "copies"} over ` +
        `${COPIES_WINDOW_MS / 1_000} s`
      );
    },
  },
];
