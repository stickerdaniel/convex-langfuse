import { LangfuseOtelSpanAttributes } from "@langfuse/core";
import { describe, expect, test } from "vitest";
import { ATTR } from "./attributes.js";
import { buildExportBody, byteLength, encodeSpan } from "./otlp.js";
import type {
  Observation,
  ObservationType,
  TraceContext,
} from "./validators.js";

type AnyValue = {
  stringValue?: string;
  intValue?: string;
  arrayValue?: { values: { stringValue: string }[] };
};
type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: AnyValue }[];
  status?: { code: number; message?: string };
};

const trace: TraceContext = { traceId: "0123456789abcdef0123456789abcdef" };

const base: Observation = {
  id: "0123456789abcdef",
  type: "span",
  name: "step",
  startTime: 1794398400123,
  endTime: 1794398401123,
};

const maximalTrace: TraceContext = {
  traceId: "0123456789abcdef0123456789abcdef",
  name: "chat turn",
  userId: "user-1",
  sessionId: "session-1",
  tags: ["chat", "beta"],
  metadata: '{"plan":"pro"}',
  environment: "production",
  release: "2026.11.1",
  experiment: {
    id: "exp-1",
    name: "prompt v2",
    datasetId: "dataset-1",
    itemId: "item-1",
    rootObservationId: "fedcba9876543210",
    metadata: '{"run":3}',
  },
};

const maximalGeneration: Observation = {
  id: "0123456789abcdef",
  parentId: "fedcba9876543210",
  type: "generation",
  name: "llm",
  startTime: 1794398400123,
  endTime: 1794398401123,
  completionStartTime: 1794398400500,
  input: '[{"role":"user","content":"Hi"}]',
  output: '{"role":"assistant","content":"Hello"}',
  metadata: '{"attempt":1}',
  level: "WARNING",
  statusMessage: "slow",
  version: "v3",
  model: "gpt-5",
  modelParameters: '{"temperature":0.2}',
  usage: { input: 10, output: 5 },
  cost: { input: 0.001, output: 0.002 },
  prompt: { name: "chat-system", version: 4 },
};

function encode(observation: Partial<Observation>, context = trace): Span {
  return JSON.parse(encodeSpan(context, { ...base, ...observation })) as Span;
}

function attribute(span: Span, key: string): AnyValue | undefined {
  return span.attributes.find((entry) => entry.key === key)?.value;
}

function jsonAttribute(span: Span, key: string): unknown {
  const value = attribute(span, key)?.stringValue;
  return value === undefined ? undefined : JSON.parse(value);
}

/** The attribute set of the design, written out independently of `ATTR`. */
const ATTRIBUTE_NAMES = [
  "langfuse.observation.type",
  "langfuse.trace.name",
  "user.id",
  "session.id",
  "langfuse.trace.tags",
  "langfuse.trace.metadata",
  "langfuse.environment",
  "langfuse.release",
  "langfuse.version",
  "langfuse.observation.input",
  "langfuse.observation.output",
  "langfuse.observation.metadata",
  "langfuse.observation.level",
  "langfuse.observation.status_message",
  "langfuse.observation.model.name",
  "langfuse.observation.model.parameters",
  "langfuse.observation.usage_details",
  "langfuse.observation.cost_details",
  "langfuse.observation.prompt.name",
  "langfuse.observation.prompt.version",
  "langfuse.observation.completion_start_time",
  "langfuse.experiment.id",
  "langfuse.experiment.name",
  "langfuse.experiment.dataset.id",
  "langfuse.experiment.item.id",
  "langfuse.experiment.item.root_observation_id",
  "langfuse.experiment.metadata",
];

describe("attribute set", () => {
  test("a maximal generation emits exactly the 27 attributes", () => {
    const span = encode(maximalGeneration, maximalTrace);
    const emitted = span.attributes.map((entry) => entry.key);
    expect(ATTRIBUTE_NAMES).toHaveLength(27);
    expect([...emitted].sort()).toEqual([...ATTRIBUTE_NAMES].sort());
  });

  test("every ATTR name is a Langfuse SDK attribute", () => {
    const sdkNames = new Set<string>(Object.values(LangfuseOtelSpanAttributes));
    for (const name of Object.values(ATTR)) expect(sdkNames).toContain(name);
  });

  test("attributes follow the ATTR order", () => {
    const span = encode(maximalGeneration, maximalTrace);
    expect(span.attributes.map((entry) => entry.key)).toEqual(
      Object.values(ATTR),
    );
  });
});

describe("encodeSpan", () => {
  test("writes span identity, kind and nanosecond times", () => {
    const span = encode({ parentId: "fedcba9876543210" });
    expect(span).toMatchObject({
      traceId: trace.traceId,
      spanId: base.id,
      parentSpanId: "fedcba9876543210",
      name: "step",
      kind: 1,
      startTimeUnixNano: "1794398400123000000",
      endTimeUnixNano: "1794398401123000000",
    });
  });

  test("omits parentSpanId without a parent", () => {
    expect(encode({})).not.toHaveProperty("parentSpanId");
  });

  test("encodes an end time before the start time as the start time", () => {
    const span = encode({ endTime: base.startTime - 5000 });
    expect(span.endTimeUnixNano).toBe("1794398400123000000");
  });

  test.each<ObservationType>([
    "span",
    "generation",
    "event",
    "agent",
    "tool",
    "chain",
    "retriever",
    "evaluator",
    "embedding",
    "guardrail",
  ])("encodes type %s", (type) => {
    expect(attribute(encode({ type }), ATTR.observationType)).toEqual({
      stringValue: type,
    });
  });

  test("a minimal span carries only the observation type", () => {
    expect(encode({}).attributes).toEqual([
      { key: ATTR.observationType, value: { stringValue: "span" } },
    ]);
  });

  test("passes JSON strings through unchanged", () => {
    const span = encode(maximalGeneration, maximalTrace);
    expect(attribute(span, ATTR.input)?.stringValue).toBe(
      maximalGeneration.input,
    );
    expect(attribute(span, ATTR.metadata)?.stringValue).toBe('{"attempt":1}');
    expect(attribute(span, ATTR.traceMetadata)?.stringValue).toBe(
      '{"plan":"pro"}',
    );
    expect(attribute(span, ATTR.experimentMetadata)?.stringValue).toBe(
      '{"run":3}',
    );
    expect(attribute(span, ATTR.modelParameters)?.stringValue).toBe(
      '{"temperature":0.2}',
    );
  });

  test("writes trace context and experiment attributes on every span", () => {
    const span = encode({ type: "tool" }, maximalTrace);
    expect(attribute(span, ATTR.traceTags)).toEqual({
      arrayValue: {
        values: [{ stringValue: "chat" }, { stringValue: "beta" }],
      },
    });
    expect(attribute(span, ATTR.userId)).toEqual({ stringValue: "user-1" });
    expect(attribute(span, ATTR.environment)).toEqual({
      stringValue: "production",
    });
    expect(attribute(span, ATTR.experimentId)).toEqual({
      stringValue: "exp-1",
    });
    expect(attribute(span, ATTR.experimentName)).toEqual({
      stringValue: "prompt v2",
    });
    expect(attribute(span, ATTR.experimentDatasetId)).toEqual({
      stringValue: "dataset-1",
    });
    expect(attribute(span, ATTR.experimentItemId)).toEqual({
      stringValue: "item-1",
    });
    expect(attribute(span, ATTR.experimentItemRootObservationId)).toEqual({
      stringValue: "fedcba9876543210",
    });
    expect(attribute(span, ATTR.experimentMetadata)).toEqual({
      stringValue: '{"run":3}',
    });
  });

  test("omits an empty tags array", () => {
    const span = encode({}, { ...trace, tags: [] });
    expect(attribute(span, ATTR.traceTags)).toBeUndefined();
  });

  test("writes the observation version and completion start time", () => {
    const span = encode(maximalGeneration, maximalTrace);
    expect(attribute(span, ATTR.version)).toEqual({ stringValue: "v3" });
    expect(attribute(span, ATTR.completionStartTime)).toEqual({
      stringValue: "2026-11-11T12:00:00.500Z",
    });
  });

  test("is deterministic", () => {
    expect(encodeSpan(maximalTrace, maximalGeneration)).toBe(
      encodeSpan(maximalTrace, { ...maximalGeneration }),
    );
  });
});

describe("cost", () => {
  test("appends total as the sum when missing", () => {
    const span = encode({ cost: { input: 0.001, input_audio_tokens: 0.002 } });
    expect(jsonAttribute(span, ATTR.cost)).toEqual({
      input: 0.001,
      input_audio_tokens: 0.002,
      total: 0.003,
    });
  });

  test("keeps a given total", () => {
    const span = encode({ cost: { input: 0.001, output: 0.002, total: 0.5 } });
    expect(jsonAttribute(span, ATTR.cost)).toEqual({
      input: 0.001,
      output: 0.002,
      total: 0.5,
    });
  });

  test("drops non-finite values", () => {
    const span = encode({ cost: { input: 0.001, output: Number.NaN } });
    expect(jsonAttribute(span, ATTR.cost)).toEqual({
      input: 0.001,
      total: 0.001,
    });
  });

  test("drops a negative entry before the total is built", () => {
    const span = encode({ cost: { input: -0.002, output: 0.005 } });
    expect(jsonAttribute(span, ATTR.cost)).toEqual({
      output: 0.005,
      total: 0.005,
    });
  });

  test("writes no cost when the total overflows", () => {
    const span = encode({
      cost: { input: 1e308, input_audio_tokens: 1e308 },
    });
    expect(attribute(span, ATTR.cost)).toBeUndefined();
  });

  test("writes no cost without cost data", () => {
    expect(attribute(encode({}), ATTR.cost)).toBeUndefined();
    expect(attribute(encode({ cost: {} }), ATTR.cost)).toBeUndefined();
    expect(
      attribute(encode({ cost: { input: Number.NaN } }), ATTR.cost),
    ).toBeUndefined();
  });
});

describe("usage", () => {
  test("passes custom keys through without adding a total", () => {
    const usage = { input: 10, output_reasoning_tokens: 4, cache_read: 0 };
    expect(jsonAttribute(encode({ usage }), ATTR.usage)).toEqual(usage);
  });

  test("drops negative, fractional and NaN values", () => {
    const span = encode({
      usage: { input: 10, a: -1, b: 1.5, c: Number.NaN },
    });
    expect(jsonAttribute(span, ATTR.usage)).toEqual({ input: 10 });
  });

  test("omits usage when nothing is left", () => {
    expect(attribute(encode({ usage: { a: -1 } }), ATTR.usage)).toBeUndefined();
    expect(attribute(encode({ usage: {} }), ATTR.usage)).toBeUndefined();
  });
});

describe("prompt", () => {
  const prompt = { name: "chat-system", version: 4 };

  test("links a generation to its prompt", () => {
    const span = encode({ type: "generation", prompt });
    expect(attribute(span, ATTR.promptName)).toEqual({
      stringValue: "chat-system",
    });
    expect(attribute(span, ATTR.promptVersion)).toEqual({ intValue: "4" });
  });

  test("exports the values it checked when a field reads differently later", () => {
    let reads = 0;
    const changing = {
      get name() {
        return reads++ === 0 ? "chat-system" : (undefined as unknown as string);
      },
      version: 4,
    };
    const span = encode({ type: "generation", prompt: changing });
    expect(attribute(span, ATTR.promptName)).toEqual({
      stringValue: "chat-system",
    });
    expect(attribute(span, ATTR.promptVersion)).toEqual({ intValue: "4" });
  });

  test("writes no prompt on a span", () => {
    const span = encode({ type: "span", prompt });
    expect(attribute(span, ATTR.promptName)).toBeUndefined();
    expect(attribute(span, ATTR.promptVersion)).toBeUndefined();
  });

  test.each([
    { name: "a missing version", prompt: { name: "p" } },
    { name: "version 0", prompt: { name: "p", version: 0 } },
    { name: "a fractional version", prompt: { name: "p", version: 1.5 } },
    { name: "a negative version", prompt: { name: "p", version: -1 } },
    { name: "an empty name", prompt: { name: "", version: 4 } },
    { name: "a missing name", prompt: { version: 4 } },
    { name: "a name that is no string", prompt: { name: 7, version: 4 } },
    { name: "null", prompt: null },
  ])("writes neither attribute for $name", ({ prompt }) => {
    // A caller without types can pass anything.
    const span = encode({
      type: "generation",
      prompt: prompt as typeof base.prompt,
    });
    expect(attribute(span, ATTR.promptName)).toBeUndefined();
    expect(attribute(span, ATTR.promptVersion)).toBeUndefined();
  });
});

describe("level and status", () => {
  test("ERROR sets status code 2 with the message", () => {
    const span = encode({ level: "ERROR", statusMessage: "rate limited" });
    expect(span.status).toEqual({ code: 2, message: "rate limited" });
    expect(attribute(span, ATTR.level)).toEqual({ stringValue: "ERROR" });
    expect(attribute(span, ATTR.statusMessage)).toEqual({
      stringValue: "rate limited",
    });
  });

  test("ERROR without a message sets status code 2 only", () => {
    expect(encode({ level: "ERROR" }).status).toEqual({ code: 2 });
  });

  test.each(["DEBUG", "DEFAULT", "WARNING", undefined] as const)(
    "level %s sets no status",
    (level) => {
      expect(encode({ level, statusMessage: "note" })).not.toHaveProperty(
        "status",
      );
    },
  );
});

describe("buildExportBody", () => {
  test("wraps the spans in one resource span with the Convex scope", () => {
    const a = encodeSpan(trace, base);
    const b = encodeSpan(trace, { ...base, id: "fedcba9876543210" });
    const body = JSON.parse(buildExportBody([a, b], "0.1.0"));
    expect(body.resourceSpans).toHaveLength(1);
    const [resourceSpan] = body.resourceSpans;
    expect(resourceSpan.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "convex-langfuse" } },
    ]);
    expect(resourceSpan.scopeSpans).toHaveLength(1);
    expect(resourceSpan.scopeSpans[0].scope).toEqual({
      name: "langfuse-sdk-convex",
      version: "0.1.0",
    });
    expect(resourceSpan.scopeSpans[0].spans).toEqual([
      JSON.parse(a),
      JSON.parse(b),
    ]);
  });

  test("accepts no spans", () => {
    const body = JSON.parse(buildExportBody([], "0.1.0"));
    expect(body.resourceSpans[0].scopeSpans[0].spans).toEqual([]);
  });
});

describe("byteLength", () => {
  test("counts UTF-8 bytes", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("ü")).toBe(2);
    expect(byteLength("世界")).toBe(6);
    expect(byteLength("🚀")).toBe(4);
  });
});
