// Cases for scores. A score is written through the client's `score` and
// read back with `GET /api/public/v3/scores?id=<id>`, step by step: the
// first value, the same id and timestamp with a new value, then the
// deletion. The component sends operations of one id at least 30 s apart,
// so each step waits for the one before. `scoreDeleted` waits until the
// score is gone, or on Langfuse Cloud until it accepted the deletion.

/** How long Langfuse may take to show, change or remove a score. */
const SCORE_MS = 90_000;

export default [
  {
    name: "scores: types, targets, update and deletion",
    oracle: "Langfuse API",
    async run({
      runId,
      environment,
      mutation,
      action,
      langfuse,
      scores,
      scoreDeleted,
      poll,
      traceIdFromSeed,
      observationIdFromKey,
      differences,
      expectNone,
    }) {
      // The score configs the host app defines, created in Langfuse by the
      // sync; their ids come from Langfuse's own list.
      const synced = await action("syncScoreConfigs", {});
      expectNone("config sync", differences(synced, { status: "ok" }));
      const { data: configs } = await langfuse.get(
        "/api/public/score-configs?page=1&limit=100",
      );
      const configId = (name) => configs.find((c) => c.name === name)?.id;

      const seed = `contract:${runId}:scores`;
      const traceId = traceIdFromSeed(seed);
      const observationId = observationIdFromKey(traceId, "answer");
      const timestamp = Date.now() - 60_000;
      await mutation("record", {
        client: "full",
        trace: { seed },
        observations: [
          {
            key: "answer",
            type: "generation",
            name: "answer",
            startTime: timestamp,
          },
        ],
      });

      const onTrace = { kind: "trace", id: traceId };
      const onObservation = { kind: "observation", id: observationId, traceId };
      const fixtures = [
        {
          id: `contract-${runId}-rating`,
          name: "contract-rating",
          dataType: "NUMERIC",
          values: [7, 9],
          target: { trace: { seed } },
          subject: onTrace,
        },
        {
          id: `contract-${runId}-helpful`,
          name: "contract-helpful",
          dataType: "BOOLEAN",
          values: [true, false],
          target: { trace: { seed }, observation: { key: "answer" } },
          subject: onObservation,
        },
        {
          id: `contract-${runId}-tone`,
          name: "contract-tone",
          dataType: "CATEGORICAL",
          values: ["formal", "casual"],
          target: { trace: { seed }, observation: { key: "answer" } },
          subject: onObservation,
        },
      ];
      const metadata = (value) => ({
        source: "contract",
        round: `round ${value}`,
      });
      const write = (fixture, value) =>
        mutation("score", {
          score: { name: fixture.name, value },
          id: fixture.id,
          timestamp,
          ...fixture.target,
          comment: `comment on ${fixture.name}`,
          metadata: metadata(value),
        });
      const expected = (fixture, value) => ({
        id: fixture.id,
        name: fixture.name,
        dataType: fixture.dataType,
        value,
        timestamp: new Date(timestamp).toISOString(),
        environment,
        comment: `comment on ${fixture.name}`,
        metadata: metadata(value),
        configId: configId(fixture.name),
        subject: fixture.subject,
      });
      const readOne = async (id) => {
        const rows = await scores(id);
        if (rows.length !== 1) throw new Error(`${rows.length} scores`);
        return rows[0];
      };

      for (const [step, index] of [
        ["written", 0],
        ["updated", 1],
      ]) {
        for (const fixture of fixtures)
          await write(fixture, fixture.values[index]);
        for (const fixture of fixtures) {
          const value = fixture.values[index];
          await poll(
            `${fixture.name} ${step} as ${JSON.stringify(value)}`,
            () => readOne(fixture.id),
            (score) => differences(score, expected(fixture, value)),
            SCORE_MS,
          );
        }
      }
      for (const fixture of fixtures) {
        await mutation("deleteScore", { id: fixture.id });
      }
      for (const fixture of fixtures) {
        await scoreDeleted(`${fixture.name} deleted`, fixture.id, SCORE_MS);
      }
      return "numeric, boolean and categorical on a trace and an observation";
    },
  },
];
