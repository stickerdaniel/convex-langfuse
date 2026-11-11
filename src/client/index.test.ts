import { defineTestApp } from "convex-test";
import {
  componentsGeneric,
  defineSchema,
  defineTable,
  type DataModelFromSchemaDefinition,
  type FunctionReference,
  type GenericMutationCtx,
} from "convex/server";
import { v } from "convex/values";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";
import componentTest from "../test.js";
import {
  drive,
  enableExport,
  installFakeLangfuse,
  type Tables,
} from "../component/fakeLangfuse.test-util.js";
import { byteLength, encodeSpan } from "../shared/otlp.js";
import type { Observation, TraceContext } from "../shared/validators.js";
import {
  Langfuse,
  observationIdFromKey,
  traceIdFromSeed,
  type ExportRecord,
  type Health,
  type LangfuseOptions,
  type Trace,
} from "./index.js";

const schema = defineSchema({ notes: defineTable({ body: v.string() }) });
const app = defineTestApp({
  schema,
  components: { convexLangfuse: componentTest },
});
type AppCtx = GenericMutationCtx<DataModelFromSchemaDefinition<typeof schema>>;
type RunMutationCtx = Parameters<Trace["generation"]>[0];

function client(options: LangfuseOptions): Langfuse {
  return new Langfuse(app.components.convexLangfuse, options);
}

/** What the current test runs inside the `app.run` mutation. */
let body: (ctx: AppCtx) => Promise<void> = async () => {};

const { api, createTest } = app.defineModules({
  app: {
    run: app.mutation({
      args: {},
      handler: async (ctx): Promise<null> => {
        await body(ctx);
        return null;
      },
    }),
    /** Saves a note and records a generation, then throws when asked. */
    note: app.mutation({
      args: { fail: v.boolean() },
      handler: async (ctx, { fail }): Promise<null> => {
        await ctx.db.insert("notes", { body: "hello" });
        await client({ content: "full" })
          .trace({ seed: "note" })
          .generation(ctx, { key: "llm", name: "llm", input: "hi" });
        if (fail) throw new Error("after the generation");
        return null;
      },
    }),
    health: app.query({
      args: {},
      handler: async (ctx): Promise<Health> =>
        await client({ content: "full" }).health(ctx),
    }),
  },
});
type TestApp = ReturnType<typeof createTest>;

type EmptyArgs = Record<string, never>;

// Test-only component functions; see `inspect.test-util.ts`.
const inspect = componentsGeneric().convexLangfuse[
  "inspect.test-util"
] as unknown as {
  exportTables: FunctionReference<"query", "internal", EmptyArgs, Tables>;
  closeGate: FunctionReference<"mutation", "internal", EmptyArgs, null>;
};

/** Runs `fn` in an app mutation and returns its result. */
async function inMutation<T>(
  t: TestApp,
  fn: (ctx: AppCtx) => Promise<T>,
): Promise<T> {
  const results: T[] = [];
  body = async (ctx) => {
    results.push(await fn(ctx));
  };
  await t.mutation(api.app.run, {});
  return results[0]!;
}

async function tables(t: TestApp): Promise<Tables> {
  return await t.query(inspect.exportTables, {});
}

/** Stored span payloads by span id. */
async function spans(t: TestApp): Promise<Map<string, string>> {
  const { outbox, payloads } = await tables(t);
  const data = new Map(payloads.map((row) => [row._id, row.data]));
  return new Map(
    outbox.map((row) => [row.ref.split(":")[1]!, data.get(row.payloadId)!]),
  );
}

type Span = {
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: { stringValue?: string } }[];
};

function attribute(data: string, key: string): string | undefined {
  const span = JSON.parse(data) as Span;
  return span.attributes.find((a) => a.key === key)?.value.stringValue;
}

type RecordArgs = { trace: TraceContext; observations: Observation[] };

/** A ctx that records the arguments of every component call it forwards. */
function spying(ctx: AppCtx, calls: RecordArgs[]): RunMutationCtx {
  return {
    runMutation: async (reference, ...args) => {
      calls.push(args[0] as RecordArgs);
      return await ctx.runMutation(reference, ...args);
    },
  };
}

let consoleError: MockInstance<typeof console.error>;
/** Every console line, from any method. */
let consoleLines: unknown[][];

/** The codes of the client's log lines, in order. */
function loggedCodes(): string[] {
  return consoleError.mock.calls.map((call) =>
    String(call[0]).replace("[convex-langfuse] ", ""),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  enableExport();
  consoleLines = [];
  const capture = (...args: unknown[]) => {
    consoleLines.push(args);
  };
  for (const method of ["log", "info", "warn", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(capture);
  }
  consoleError = vi.spyOn(console, "error").mockImplementation(capture);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const KIB = 1024;
const MIB = 1024 * KIB;

test("a generation commits and rolls back with the app mutation", async () => {
  const t = createTest();
  await expect(t.mutation(api.app.note, { fail: true })).rejects.toThrow(
    "after the generation",
  );
  expect((await tables(t)).outbox).toHaveLength(0);
  expect(
    await t.run(async (ctx) => await ctx.db.query("notes").collect()),
  ).toHaveLength(0);

  await t.mutation(api.app.note, { fail: false });
  expect((await tables(t)).outbox).toHaveLength(1);
  expect(
    await t.run(async (ctx) => await ctx.db.query("notes").collect()),
  ).toHaveLength(1);
});

describe("content never leaves the app", () => {
  const MARKER = "MARKER-7f3a";
  const INPUT = `question ${MARKER}`;
  const OUTPUT = `answer ${MARKER}`;
  const STATUS = `failed ${MARKER}`;

  /** Replaces the marker in every string, at any depth. */
  function scrub(value: unknown): unknown {
    if (typeof value === "string") return value.replaceAll(MARKER, "[gone]");
    if (Array.isArray(value)) return value.map(scrub);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, scrub(item)]),
      );
    }
    return value;
  }

  /**
   * Records content with the marker, forces an error log and lets the fake
   * endpoint reject every row into a dead letter. Returns everything the
   * component stored, sent and logged.
   */
  async function exportAndCollect(
    langfuse: Langfuse,
    everywhere: boolean,
  ): Promise<{ haystack: string; state: Tables }> {
    const fake = installFakeLangfuse();
    fake.fallback = { status: 400 };
    const t = createTest();
    const label = everywhere ? MARKER : "plain";
    await inMutation(t, async (ctx) => {
      const trace = langfuse.trace({
        seed: "chat",
        name: `chat ${label}`,
        userId: label,
        tags: [label],
        metadata: { note: label },
      });
      await trace.record(ctx, [
        {
          type: "generation",
          key: "llm",
          name: `llm ${label}`,
          model: label,
          input: { text: INPUT, history: [INPUT] },
          output: OUTPUT,
          statusMessage: STATUS,
          level: "ERROR",
          metadata: { note: label },
          modelParameters: { note: label },
        },
        // A negative usage value forces an error log for this record.
        {
          type: "span",
          key: "tool",
          name: "tool",
          input: INPUT,
          usage: { input: -1 },
        },
      ]);
    });
    await drive(t, fake, {
      until: async () => (await tables(t)).outbox.length === 0,
    });
    const state = await tables(t);
    expect(state.deadLetters).toHaveLength(2);
    expect(loggedCodes()).toContain("invalid_usage");
    const haystack = [
      JSON.stringify(state),
      JSON.stringify(consoleLines),
      ...fake.requests.map((request) => request.body),
    ].join("\n");
    return { haystack, state };
  }

  test('content: "none" removes input, output and status message', async () => {
    const { haystack } = await exportAndCollect(
      client({ content: "none" }),
      false,
    );
    for (const text of [MARKER, INPUT, OUTPUT, STATUS]) {
      expect(haystack).not.toContain(text);
    }
    expect(haystack).toContain("llm plain");
  });

  test("redact replaces the marker in every field", async () => {
    const { haystack } = await exportAndCollect(
      client({
        content: "full",
        redact: (record) => scrub(record) as ExportRecord,
      }),
      true,
    );
    for (const text of [MARKER, INPUT, OUTPUT, STATUS]) {
      expect(haystack).not.toContain(text);
    }
    expect(haystack).toContain("question [gone]");
  });
});

test("redact returning null enqueues and logs nothing", async () => {
  const t = createTest();
  const langfuse = client({ content: "full", redact: () => null });
  const recorded = await inMutation(t, async (ctx) =>
    langfuse.trace({ seed: "s" }).generation(ctx, { key: "k", name: "n" }),
  );
  expect(recorded.traceId).toBe(await traceIdFromSeed("s"));
  expect((await tables(t)).outbox).toHaveLength(0);
  expect(consoleLines).toEqual([]);
});

test("a 1 MiB input is cut to maxFieldBytes on a character boundary", async () => {
  const t = createTest();
  const limit = 131_072;
  // The first "€" (3 bytes) straddles the limit.
  const input = "a".repeat(limit - 1) + "€".repeat(Math.ceil(MIB / 3));
  const total = byteLength(input);
  expect(total).toBeGreaterThan(MIB);
  const { observationId } = await inMutation(t, async (ctx) =>
    client({ content: "full" })
      .trace({ seed: "s" })
      .generation(ctx, { key: "k", name: "n", input }),
  );

  const stored = attribute(
    (await spans(t)).get(observationId)!,
    "langfuse.observation.input",
  )!;
  const marker = `…[truncated ${total - (limit - 1)} bytes]`;
  expect(stored.endsWith(marker)).toBe(true);
  const kept = stored.slice(0, -marker.length);
  expect(kept).toBe("a".repeat(limit - 1));
  expect(byteLength(kept)).toBeLessThanOrEqual(limit);
  expect(stored).not.toContain("�");
});

test("record splits 60 large observations into bounded calls", async () => {
  const t = createTest();
  const calls: RecordArgs[] = [];
  await inMutation(t, async (ctx) =>
    client({ content: "full" })
      .trace({ seed: "s" })
      .record(
        spying(ctx, calls),
        Array.from({ length: 60 }, (_, i) => ({
          type: "span" as const,
          key: `step-${i}`,
          name: `step-${i}`,
          input: "x".repeat(100 * KIB),
        })),
      ),
  );

  expect(calls.length).toBeGreaterThan(1);
  for (const { trace, observations } of calls) {
    expect(observations.length).toBeLessThanOrEqual(50);
    const bytes = observations.reduce(
      (sum, observation) => sum + byteLength(encodeSpan(trace, observation)),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(3 * MIB);
  }
  expect((await tables(t)).outbox).toHaveLength(60);
  expect(consoleLines).toEqual([]);
});

test("record puts at most 50 observations into one call", async () => {
  const t = createTest();
  const calls: RecordArgs[] = [];
  await inMutation(t, async (ctx) =>
    client({ content: "full" })
      .trace({ seed: "s" })
      .record(
        spying(ctx, calls),
        Array.from({ length: 60 }, (_, i) => ({
          type: "event" as const,
          key: `e-${i}`,
          name: `e-${i}`,
        })),
      ),
  );

  expect(calls.map((call) => call.observations.length)).toEqual([50, 10]);
  expect((await tables(t)).outbox).toHaveLength(60);
});

test("a large trace context splits 50 small observations", async () => {
  const t = createTest();
  const calls: RecordArgs[] = [];
  // Serializes to exactly 128 KiB, the default limit.
  const metadata = { blob: "x".repeat(128 * KIB - 11) };
  await inMutation(t, async (ctx) =>
    client({ content: "full" })
      .trace({ seed: "s", metadata })
      .record(
        spying(ctx, calls),
        Array.from({ length: 50 }, (_, i) => ({
          type: "event" as const,
          key: `e-${i}`,
          name: `e-${i}`,
        })),
      ),
  );

  expect(calls.length).toBeGreaterThan(1);
  expect(calls[0]!.trace.metadata).toBe(JSON.stringify(metadata));
  expect((await tables(t)).outbox).toHaveLength(50);
  expect(consoleLines).toEqual([]);
});

test("an observation over 900 KiB is not sent, the others are", async () => {
  const t = createTest();
  const langfuse = client({ content: "full", maxFieldBytes: 2 * MIB });
  const result = await inMutation(t, async (ctx) =>
    langfuse.trace({ seed: "s" }).record(ctx, [
      { type: "span", key: "a", name: "a" },
      {
        type: "generation",
        key: "big",
        name: "big",
        modelParameters: { blob: "x".repeat(950 * KIB) },
      },
      { type: "span", key: "c", name: "c" },
    ]),
  );

  const [a, big, c] = result.observationIds;
  expect([...(await spans(t)).keys()].sort()).toEqual([a, c].sort());
  expect(consoleError.mock.calls).toEqual([
    [
      "[convex-langfuse] row_too_large",
      { traceId: result.traceId, observationId: big },
    ],
  ]);
});

test("bad usage, metadata and input are left out of a sent record", async () => {
  const t = createTest();
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const { traceId, observationId } = await inMutation(t, async (ctx) =>
    client({ content: "full" })
      .trace({ seed: "s" })
      .generation(ctx, {
        key: "k",
        name: "n",
        startTime: 1_000,
        input: cyclic,
        output: "kept",
        // A caller without types can pass anything.
        metadata: ["not", "an", "object"] as unknown as Record<string, unknown>,
        usage: { input: 3, output: -1, reasoning: 1.5, cached: NaN },
      }),
  );

  expect((await spans(t)).get(observationId)).toBe(
    encodeSpan(
      { traceId },
      {
        id: observationId,
        type: "generation",
        name: "n",
        startTime: 1_000,
        endTime: 1_000,
        output: "kept",
        usage: { input: 3 },
      },
    ),
  );
  expect(loggedCodes().sort()).toEqual(
    ["invalid_metadata", "invalid_usage", "unserializable"].sort(),
  );
});

describe("an invalid record is not sent", () => {
  const cases = [
    { code: "invalid_environment", init: { seed: "s", environment: "Prod!" } },
    { code: "invalid_id", init: { traceId: "not-a-trace-id" } },
  ] as const;

  test.each(cases)("$code is logged and ids are returned", async ({ init }) => {
    const t = createTest();
    const recorded = await inMutation(t, async (ctx) =>
      client({ content: "full" })
        .trace(init)
        .generation(ctx, { key: "k", name: "n" }),
    );
    const traceId =
      "traceId" in init ? init.traceId : await traceIdFromSeed("s");
    expect(recorded).toEqual({
      traceId,
      observationId: await observationIdFromKey(traceId, "k"),
    });
    expect((await tables(t)).outbox).toHaveLength(0);
  });

  test.each(cases)(
    '$code is thrown with onError: "throw"',
    async ({ code, init }) => {
      const t = createTest();
      const error = await inMutation(t, async (ctx) =>
        client({ content: "full", onError: "throw" })
          .trace(init)
          .generation(ctx, { key: "k", name: "n" })
          .catch((error: unknown) => error),
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(code);
      expect((await tables(t)).outbox).toHaveLength(0);
    },
  );
});

test("seeds, keys and parents resolve to the shared ids", async () => {
  const t = createTest();
  const trace = client({ content: "full" }).trace({ seed: "conversation:42" });
  const traceId = await traceIdFromSeed("conversation:42");
  const llmId = await observationIdFromKey(traceId, "llm");
  expect(await trace.id()).toBe(traceId);
  expect(await trace.observationId("llm")).toBe(llmId);

  const [generation, event] = await inMutation(t, async (ctx) => [
    await trace.generation(ctx, { key: "llm", name: "llm" }),
    await trace.event(ctx, {
      key: "tick",
      parent: { key: "llm" },
      name: "tick",
      startTime: 1_000,
      endTime: 9_000,
    }),
  ]);
  expect(generation).toEqual({ traceId, observationId: llmId });
  expect(event!.traceId).toBe(traceId);

  const span = JSON.parse((await spans(t)).get(event!.observationId)!) as Span;
  expect(span.parentSpanId).toBe(llmId);
  expect(span.endTimeUnixNano).toBe(span.startTimeUnixNano);
});

test("a stored payload equals the encoded span of the boundary values", async () => {
  const t = createTest();
  const result = await inMutation(t, async (ctx) =>
    client({ content: "full" })
      .trace({
        seed: "conversation:12",
        name: "chat",
        userId: "user-1",
        sessionId: "session-1",
        tags: ["b", "a"],
        metadata: { z: 1, a: { y: 2, b: [{ d: 1, c: 2 }] } },
        environment: "staging",
        release: "v1",
        experiment: {
          id: "exp-1",
          name: "Experiment",
          datasetId: "dataset-1",
          itemId: "item-1",
          rootObservation: { key: "root" },
          metadata: { b: 1, a: 2 },
        },
      })
      .generation(ctx, {
        key: "llm",
        parent: { key: "root" },
        name: "answer",
        startTime: 1_794_398_400_123,
        endTime: 1_794_398_401_000,
        completionStartTime: 1_794_398_400_500,
        input: { messages: [{ role: "user", content: "hi" }], a: 1 },
        output: "hello",
        metadata: { y: true, x: null },
        level: "WARNING",
        statusMessage: "slow",
        version: "3",
        model: "gpt-x",
        modelParameters: { temperature: 0.2, max_tokens: 100 },
        usage: { input: 3, output: 5 },
        cost: { input: 0.1 },
        prompt: { name: "persona", version: 2 },
      }),
  );

  const traceId = await traceIdFromSeed("conversation:12");
  const rootId = await observationIdFromKey(traceId, "root");
  const expected = encodeSpan(
    {
      traceId,
      name: "chat",
      userId: "user-1",
      sessionId: "session-1",
      tags: ["b", "a"],
      metadata: '{"a":{"b":[{"c":2,"d":1}],"y":2},"z":1}',
      environment: "staging",
      release: "v1",
      experiment: {
        id: "exp-1",
        name: "Experiment",
        datasetId: "dataset-1",
        itemId: "item-1",
        rootObservationId: rootId,
        metadata: '{"a":2,"b":1}',
      },
    },
    {
      id: await observationIdFromKey(traceId, "llm"),
      parentId: rootId,
      type: "generation",
      name: "answer",
      startTime: 1_794_398_400_123,
      endTime: 1_794_398_401_000,
      completionStartTime: 1_794_398_400_500,
      input: '{"a":1,"messages":[{"content":"hi","role":"user"}]}',
      output: "hello",
      metadata: '{"x":null,"y":true}',
      level: "WARNING",
      statusMessage: "slow",
      version: "3",
      model: "gpt-x",
      modelParameters: '{"max_tokens":100,"temperature":0.2}',
      usage: { input: 3, output: 5 },
      cost: { input: 0.1 },
      prompt: { name: "persona", version: 2 },
    },
  );
  expect(result.traceId).toBe(traceId);
  expect((await spans(t)).get(result.observationId)).toBe(expected);
});

test("observations whose redacted trace context differs keep their own context", async () => {
  const t = createTest();
  const langfuse = client({
    content: "full",
    redact: (record) => ({
      ...record,
      trace: { ...record.trace, name: `trace of ${record.observation.name}` },
    }),
  });
  const { traceId, observationIds } = await inMutation(t, async (ctx) =>
    langfuse.trace({ seed: "s", name: "original" }).record(ctx, [
      { type: "span", key: "a", name: "a", startTime: 1_000 },
      { type: "span", key: "b", name: "b", startTime: 1_000 },
    ]),
  );

  const stored = await spans(t);
  for (const [i, name] of ["a", "b"].entries()) {
    expect(stored.get(observationIds[i]!)).toBe(
      encodeSpan(
        { traceId, name: `trace of ${name}` },
        {
          id: observationIds[i]!,
          type: "span",
          name,
          startTime: 1_000,
          endTime: 1_000,
        },
      ),
    );
  }
});

test("health returns the component's health", async () => {
  const t = createTest();
  await t.mutation(api.app.note, { fail: false });
  const health = await t.query(api.app.health, {});
  expect(health).toEqual(
    await t.query(app.components.convexLangfuse.outbox.health, {}),
  );
  expect(health.pendingAtLeast).toBe(1);
});

test("log lines carry a code and ids only", async () => {
  const MARKER = "MARKER-c0de";
  const t = createTest();
  const langfuse = client({ content: "full", maxFieldBytes: 2 * MIB });
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const base = { name: MARKER, input: MARKER, statusMessage: MARKER };
  await inMutation(t, async (ctx) => {
    await langfuse.trace({ seed: MARKER }).record(ctx, [
      { ...base, type: "span", key: "usage", usage: { input: -1 } },
      {
        ...base,
        type: "span",
        key: "metadata",
        metadata: MARKER as unknown as Record<string, unknown>,
      },
      { ...base, type: "span", key: "cycle", output: cyclic },
      {
        ...base,
        type: "span",
        key: "large",
        modelParameters: { blob: MARKER.repeat(100 * KIB) },
      },
      { ...base, type: "span", key: "" },
    ]);
    await langfuse
      .trace({ seed: MARKER, environment: MARKER })
      .span(ctx, { ...base, key: "environment" });
    await client({
      content: "full",
      redact: () => {
        throw new Error(MARKER);
      },
    })
      .trace({ seed: MARKER })
      .span(ctx, { ...base, key: "redact" });
    await langfuse.trace({ seed: MARKER }).span(
      {
        runMutation: async () => {
          throw new Error(MARKER);
        },
      },
      { ...base, key: "rejected" },
    );
  });
  await t.mutation(inspect.closeGate, {});
  await inMutation(t, async (ctx) =>
    langfuse.trace({ seed: MARKER }).span(ctx, { ...base, key: "backlog" }),
  );

  expect(loggedCodes()).toEqual([
    "invalid_usage",
    "invalid_metadata",
    "unserializable",
    "row_too_large",
    "invalid_id",
    "invalid_environment",
    "redact_failed",
    "enqueue_failed",
    "backlog",
  ]);
  for (const [line, ids, ...rest] of consoleError.mock.calls) {
    expect(line).toMatch(/^\[convex-langfuse\] [a-z_]+$/);
    expect(rest).toEqual([]);
    expect(Object.keys(ids as object).sort()).toEqual([
      "observationId",
      "traceId",
    ]);
    const { traceId, observationId } = ids as Record<string, string>;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(observationId).toMatch(/^([0-9a-f]{16})?$/);
  }
  expect(JSON.stringify(consoleLines)).not.toContain(MARKER);
});
