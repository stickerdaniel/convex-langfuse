// Cases for observations: ids, fields, types, timestamps, usage, cost,
// trace fields, experiments, a second producer and prompt links. Each case
// records through the host app's `record` (the client's `trace().record`)
// and reads Langfuse back with `GET /api/public/v2/observations`, requesting
// the field groups it asserts. The expected values are the public
// representation Langfuse returns: types in upper case, times as ISO
// strings, input and output as the strings the client serialized, an
// absent string field as "", absent model parameters as {}, and the
// component's scope in the metadata.

/** How long Langfuse may take to show a recorded observation. */
const VISIBLE_MS = 60_000;

const iso = (ms) => new Date(ms).toISOString();

export default [
  {
    name: "ids from seeds and keys",
    oracle: "client result, Langfuse API",
    async run({
      runId,
      mutation,
      observations,
      poll,
      traceIdFromSeed,
      observationIdFromKey,
      differences,
      rowDifferences,
      expectNone,
    }) {
      const seed = `contract:${runId}:ids`;
      const traceId = traceIdFromSeed(seed);
      const rootId = observationIdFromKey(traceId, "root");
      const childId = observationIdFromKey(traceId, "child");
      const t = Date.now() - 60_000;
      const recorded = await mutation("record", {
        client: "full",
        trace: { seed },
        observations: [
          { key: "root", type: "span", name: "root", startTime: t },
          {
            key: "child",
            parent: { key: "root" },
            type: "span",
            name: "child",
            startTime: t + 100,
          },
        ],
      });
      expectNone(
        "client ids",
        differences(recorded, { traceId, observationIds: [rootId, childId] }),
      );
      await poll(
        "both observations under the derived ids",
        () => observations(traceId, "core"),
        (rows) =>
          rowDifferences(rows, [
            { id: rootId, traceId, parentObservationId: null },
            { id: childId, traceId, parentObservationId: rootId },
          ]),
        VISIBLE_MS,
      );
      return `trace ${traceId}`;
    },
  },

  {
    name: "explicit trace, observation and parent ids",
    oracle: "Langfuse API",
    async run({ runId, mutation, observations, poll, rowDifferences }) {
      const traceId = `${runId}000000000000000000000001`;
      const parentId = `${runId}00000001`;
      const childId = `${runId}00000002`;
      const t = Date.now() - 60_000;
      await mutation("record", {
        client: "full",
        trace: { traceId },
        observations: [
          { id: parentId, type: "span", name: "parent", startTime: t },
          {
            id: childId,
            parent: { id: parentId },
            type: "span",
            name: "child",
            startTime: t + 100,
          },
        ],
      });
      await poll(
        "both observations under the given ids",
        () => observations(traceId, "core"),
        (rows) =>
          rowDifferences(rows, [
            { id: parentId, traceId, parentObservationId: null },
            { id: childId, traceId, parentObservationId: parentId },
          ]),
        VISIBLE_MS,
      );
    },
  },

  {
    name: "observation fields, the ten types and three-deep parents",
    oracle: "Langfuse API",
    async run({
      runId,
      mutation,
      observations,
      poll,
      traceIdFromSeed,
      observationIdFromKey,
      rowDifferences,
      scopeMetadata,
    }) {
      const seed = `contract:${runId}:fields`;
      const traceId = traceIdFromSeed(seed);
      const id = (key) => observationIdFromKey(traceId, key);
      const t = Date.now() - 120_000;
      const model = `contract-model-${runId}`;
      // agent > chain > retriever > embedding is three parent links deep.
      const observationsIn = [
        { key: "agent", type: "agent", name: "plan" },
        { key: "chain", parent: "agent", type: "chain", name: "steps" },
        { key: "retriever", parent: "chain", type: "retriever", name: "find" },
        {
          key: "embedding",
          parent: "retriever",
          type: "embedding",
          name: "embed",
        },
        { key: "span", parent: "agent", type: "span", name: "work" },
        { key: "tool", parent: "chain", type: "tool", name: "search" },
        { key: "evaluator", parent: "agent", type: "evaluator", name: "judge" },
        { key: "guardrail", parent: "agent", type: "guardrail", name: "check" },
      ].map(({ key, parent, ...fields }, i) => ({
        key,
        ...(parent ? { parent: { key: parent } } : {}),
        ...fields,
        startTime: t + i * 10,
        endTime: t + i * 10 + 5,
      }));
      await mutation("record", {
        client: "full",
        trace: { seed },
        observations: [
          ...observationsIn,
          {
            key: "generation",
            parent: { key: "chain" },
            type: "generation",
            name: "answer",
            startTime: t + 100,
            endTime: t + 900,
            completionStartTime: t + 300,
            input: { question: "What is the capital of France?", lang: "en" },
            output: "Paris",
            level: "WARNING",
            statusMessage: "slow answer",
            version: "v7",
            model,
            modelParameters: { temperature: 0.2, max_tokens: 64 },
            metadata: { step: "generation" },
          },
          {
            key: "failure",
            parent: { key: "chain" },
            type: "span",
            name: "failure",
            startTime: t + 950,
            endTime: t + 960,
            level: "ERROR",
            statusMessage: "tool failed",
          },
          {
            key: "event",
            parent: { key: "agent" },
            type: "event",
            name: "barge-in",
            startTime: t + 1_000,
            endTime: t + 5_000,
          },
        ],
      });
      const plain = (key, parent, type, name, offset) => ({
        id: id(key),
        traceId,
        parentObservationId: parent ? id(parent) : null,
        type,
        name,
        level: "DEFAULT",
        statusMessage: "",
        version: "",
        startTime: iso(t + offset),
        endTime: iso(t + offset + 5),
        completionStartTime: null,
        input: null,
        output: null,
        model: "",
        modelParameters: {},
        metadata: scopeMetadata,
      });
      const expected = [
        plain("agent", null, "AGENT", "plan", 0),
        plain("chain", "agent", "CHAIN", "steps", 10),
        plain("retriever", "chain", "RETRIEVER", "find", 20),
        plain("embedding", "retriever", "EMBEDDING", "embed", 30),
        plain("span", "agent", "SPAN", "work", 40),
        plain("tool", "chain", "TOOL", "search", 50),
        plain("evaluator", "agent", "EVALUATOR", "judge", 60),
        plain("guardrail", "agent", "GUARDRAIL", "check", 70),
        {
          id: id("generation"),
          traceId,
          parentObservationId: id("chain"),
          type: "GENERATION",
          name: "answer",
          level: "WARNING",
          statusMessage: "slow answer",
          version: "v7",
          startTime: iso(t + 100),
          endTime: iso(t + 900),
          completionStartTime: iso(t + 300),
          // The client serializes with sorted keys.
          input: '{"lang":"en","question":"What is the capital of France?"}',
          output: "Paris",
          model,
          modelParameters: { max_tokens: 64, temperature: 0.2 },
          metadata: { step: "generation", ...scopeMetadata },
        },
        {
          ...plain("failure", "chain", "SPAN", "failure", 950),
          level: "ERROR",
          statusMessage: "tool failed",
          endTime: iso(t + 960),
        },
        {
          ...plain("event", "agent", "EVENT", "barge-in", 1_000),
          // An event ends at its start.
          endTime: iso(t + 1_000),
        },
      ];
      await poll(
        "eleven observations with their fields",
        () => observations(traceId, "core,basic,time,io,metadata,model"),
        (rows) => rowDifferences(rows, expected),
        VISIBLE_MS,
      );
      return "10 types, 11 observations";
    },
  },

  {
    name: "usage keys and the derived total",
    oracle: "Langfuse API",
    async run({
      runId,
      mutation,
      observations,
      poll,
      traceIdFromSeed,
      observationIdFromKey,
      rowDifferences,
    }) {
      const seed = `contract:${runId}:usage`;
      const traceId = traceIdFromSeed(seed);
      const t = Date.now() - 60_000;
      await mutation("record", {
        client: "full",
        trace: { seed },
        observations: [
          {
            key: "generation",
            type: "generation",
            name: "usage",
            startTime: t,
            model: `contract-model-${runId}`,
            usage: {
              input: 100,
              output: 40,
              input_audio: 20,
              cache_read_input_tokens: 30,
              output_reasoning: 12,
            },
          },
        ],
      });
      await poll(
        "every usage key and the total",
        () => observations(traceId, "core,usage"),
        (rows) =>
          rowDifferences(rows, [
            {
              id: observationIdFromKey(traceId, "generation"),
              usageDetails: {
                input: 100,
                output: 40,
                input_audio: 20,
                cache_read_input_tokens: 30,
                output_reasoning: 12,
                total: 202,
              },
            },
          ]),
        VISIBLE_MS,
      );
    },
  },

  {
    name: "explicit cost for a model of the run",
    oracle: "Langfuse API",
    async run({
      runId,
      mutation,
      observations,
      poll,
      traceIdFromSeed,
      observationIdFromKey,
      rowDifferences,
    }) {
      const seed = `contract:${runId}:cost`;
      const traceId = traceIdFromSeed(seed);
      const id = (key) => observationIdFromKey(traceId, key);
      // A model name no price table knows, so Langfuse infers no cost.
      const model = `contract-model-${runId}`;
      const t = Date.now() - 60_000;
      const usage = { input: 10, output: 20 };
      await mutation("record", {
        client: "full",
        trace: { seed },
        observations: [
          {
            key: "entries",
            type: "generation",
            name: "entries",
            startTime: t,
            model,
            usage,
            cost: {
              input: 0.001,
              output: 0.002,
              cache_read_input_tokens: 0.0005,
            },
          },
          {
            key: "total",
            type: "generation",
            name: "total",
            startTime: t + 10,
            model,
            usage,
            cost: { input: 0.001, output: 0.002, total: 0.01 },
          },
          {
            key: "none",
            type: "generation",
            name: "none",
            startTime: t + 20,
            model,
            usage,
          },
        ],
      });
      await poll(
        "every cost entry and the total",
        () => observations(traceId, "core,usage"),
        (rows) =>
          rowDifferences(rows, [
            {
              id: id("entries"),
              costDetails: {
                input: 0.001,
                output: 0.002,
                cache_read_input_tokens: 0.0005,
                total: 0.0035,
              },
              totalCost: 0.0035,
            },
            {
              id: id("total"),
              costDetails: { input: 0.001, output: 0.002, total: 0.01 },
              totalCost: 0.01,
            },
            { id: id("none"), costDetails: {}, totalCost: null },
          ]),
        VISIBLE_MS,
      );
    },
  },

  {
    name: "environment, release, session, user, tags and metadata",
    oracle: "Langfuse API",
    async run({
      runId,
      environment,
      mutation,
      observations,
      poll,
      traceIdFromSeed,
      observationIdFromKey,
      rowDifferences,
      scopeMetadata,
    }) {
      const t = Date.now() - 60_000;
      const traceFields = {
        name: "chat-turn",
        userId: `user-${runId}`,
        sessionId: `session-${runId}`,
        tags: ["contract", `run-${runId}`],
        release: `release-${runId}`,
        metadata: { plan: "pro", region: "eu" },
      };
      const own = `contract-${runId}-trace`;
      const record = async (seed, extra) => {
        await mutation("record", {
          client: "full",
          trace: { seed, ...traceFields, ...extra },
          observations: [
            {
              key: "answer",
              type: "generation",
              name: "answer",
              startTime: t,
              metadata: { step: "answer" },
            },
          ],
        });
        return traceIdFromSeed(seed);
      };
      const defaulted = await record(`contract:${runId}:trace-default`, {});
      const overridden = await record(`contract:${runId}:trace-own`, {
        environment: own,
      });
      const expected = (traceId, env) => ({
        id: observationIdFromKey(traceId, "answer"),
        environment: env,
        userId: `user-${runId}`,
        sessionId: `session-${runId}`,
        traceName: "chat-turn",
        tags: ["contract", `run-${runId}`],
        release: `release-${runId}`,
        // Trace and observation metadata share one object, without any
        // `attributes.` key.
        metadata: {
          plan: "pro",
          region: "eu",
          step: "answer",
          ...scopeMetadata,
        },
      });
      const fields = "core,basic,metadata,trace_context";
      await poll(
        "trace fields with the component's environment",
        () => observations(defaulted, fields),
        (rows) => rowDifferences(rows, [expected(defaulted, environment)]),
        VISIBLE_MS,
      );
      await poll(
        "trace fields with the trace's environment",
        () => observations(overridden, fields),
        (rows) => rowDifferences(rows, [expected(overridden, own)]),
        VISIBLE_MS,
      );
    },
  },

  {
    name: "experiment item",
    oracle: "Langfuse API",
    async run({
      runId,
      environment,
      mutation,
      langfuse,
      poll,
      traceIdFromSeed,
      observationIdFromKey,
      rowDifferences,
    }) {
      const seed = `contract:${runId}:experiment`;
      const traceId = traceIdFromSeed(seed);
      const t = Date.now() - 60_000;
      const experimentId = `experiment-${runId}`;
      await mutation("record", {
        client: "full",
        trace: {
          seed,
          experiment: {
            id: experimentId,
            name: "contract-experiment",
            itemId: `item-${runId}`,
            rootObservation: { key: "item" },
            metadata: { variant: "a" },
          },
        },
        observations: [
          { key: "item", type: "span", name: "item", startTime: t },
          {
            key: "task",
            parent: { key: "item" },
            type: "generation",
            name: "task",
            startTime: t + 10,
          },
        ],
      });
      const from = encodeURIComponent(new Date(t - 600_000).toISOString());
      await poll(
        "the item in GET /api/public/experiment-items",
        async () =>
          (
            await langfuse.get(
              `/api/public/experiment-items?fromStartTime=${from}&experimentId=${experimentId}`,
            )
          ).data,
        (rows) =>
          rowDifferences(rows, [
            {
              id: observationIdFromKey(traceId, "item"),
              traceId,
              experimentId,
              experimentItemId: `item-${runId}`,
              environment,
            },
          ]),
        VISIBLE_MS,
      );
    },
  },

  {
    name: "joining a trace from another producer",
    oracle: "Langfuse API",
    async run({
      runId,
      mutation,
      postSpan,
      observations,
      poll,
      traceIdFromSeed,
      observationIdFromKey,
      rowDifferences,
    }) {
      // The other producer computes the trace id from the same seed with
      // its own SHA-256, as a service with the Langfuse SDK does.
      const seed = `contract:${runId}:join`;
      const traceId = traceIdFromSeed(seed);
      const convexId = observationIdFromKey(traceId, "convex");
      const otherId = `${runId}0000000f`;
      const t = Date.now() - 60_000;
      await mutation("record", {
        client: "full",
        trace: { seed },
        observations: [
          {
            key: "convex",
            type: "span",
            name: "convex",
            startTime: t,
            endTime: t + 500,
          },
        ],
      });
      await postSpan({
        traceId,
        spanId: otherId,
        parentSpanId: convexId,
        name: "other-service",
        kind: 1,
        startTimeUnixNano: `${t + 100}000000`,
        endTimeUnixNano: `${t + 200}000000`,
        attributes: [],
      });
      await poll(
        "both producers' observations under one trace id",
        () => observations(traceId, "core,basic"),
        (rows) =>
          rowDifferences(rows, [
            {
              id: convexId,
              traceId,
              parentObservationId: null,
              name: "convex",
            },
            {
              id: otherId,
              traceId,
              parentObservationId: convexId,
              name: "other-service",
            },
          ]),
        VISIBLE_MS,
      );
    },
  },

  {
    name: "prompt link and history",
    oracle: "Langfuse API",
    async run({
      runId,
      mutation,
      langfuse,
      observations,
      poll,
      traceIdFromSeed,
      observationIdFromKey,
      rowDifferences,
    }) {
      const name = `contract-${runId}-linked`;
      const create = async (prompt) => {
        const response = await langfuse.send("POST", "/api/public/v2/prompts", {
          name,
          type: "text",
          prompt,
          labels: ["production"],
        });
        if (response.status !== 201 && response.status !== 200) {
          throw new Error(`creating ${name}: HTTP ${response.status}`);
        }
        return await response.json();
      };
      const seed = `contract:${runId}:prompt-link`;
      const traceId = traceIdFromSeed(seed);
      const id = (key) => observationIdFromKey(traceId, key);
      const generation = async (key, version, startTime) =>
        await mutation("record", {
          client: "full",
          trace: { seed },
          observations: [
            {
              key,
              type: "generation",
              name: key,
              startTime,
              prompt: { name, version },
            },
          ],
        });
      const t = Date.now() - 60_000;
      const first = await create("Answer briefly.");
      await generation("first", 1, t);
      // `production` moves to version 2.
      const second = await create("Answer in one sentence.");
      await generation("second", 2, t + 10);
      if (first.version !== 1 || second.version !== 2) {
        throw new Error(
          `created versions ${first.version} and ${second.version}`,
        );
      }
      await poll(
        "each generation with the version it was linked to",
        () => observations(traceId, "core,prompt"),
        (rows) =>
          rowDifferences(rows, [
            {
              id: id("first"),
              promptName: name,
              promptVersion: 1,
              promptId: first.id,
            },
            {
              id: id("second"),
              promptName: name,
              promptVersion: 2,
              promptId: second.id,
            },
          ]),
        VISIBLE_MS,
      );
    },
  },
];
