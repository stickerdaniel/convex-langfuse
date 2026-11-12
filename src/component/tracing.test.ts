import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import { MAX_CALL_BYTES, MAX_ROW_BYTES, WORKER_NAME } from "./constants.js";
import {
  drive,
  enableExport,
  ENDPOINT,
  installFakeLangfuse,
  insertRows,
  observation,
  PUBLIC_KEY,
  SECRET_KEY,
  spanOfBytes,
  startRunByHand,
  tables,
  TRACE,
  type TestConvex,
} from "./fakeLangfuse.test-util.js";
import { initConvexTest } from "./setup.test.js";
import { buildExportBody, byteLength, encodeSpan } from "../shared/otlp.js";
import { VERSION } from "../shared/version.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function refusalCode(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConvexError) return error.data;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** An observation whose encoded span has exactly `bytes` bytes. */
function observationOfBytes(n: number, bytes: number) {
  const base = byteLength(encodeSpan(TRACE, observation(n, { input: "" })));
  return observation(n, { input: "x".repeat(bytes - base) });
}

describe("record", () => {
  test("a record is sent once with the Langfuse headers and the encoded span", async () => {
    enableExport();
    vi.stubEnv("LANGFUSE_TRACING_ENVIRONMENT", "staging");
    const fake = installFakeLangfuse();
    const t = initConvexTest();

    const input = observation(0, { type: "generation", model: "gpt-x" });
    expect(
      await t.mutation(api.tracing.record, {
        trace: TRACE,
        observations: [input],
      }),
    ).toEqual({ enqueued: 1 });
    await drive(t, fake);

    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request!.url).toBe(ENDPOINT);
    expect(request!.headers).toEqual({
      authorization: `Basic ${btoa(`${PUBLIC_KEY}:${SECRET_KEY}`)}`,
      "content-type": "application/json",
      "x-langfuse-ingestion-version": "4",
    });
    const span = encodeSpan({ ...TRACE, environment: "staging" }, input);
    expect(request!.body).toBe(buildExportBody([span], VERSION));
  });

  test("a call over 4 MiB and a span over 900 KiB are refused", async () => {
    enableExport();
    const t = initConvexTest();
    const quarter = Math.ceil(MAX_CALL_BYTES / 5) + 1;
    expect(
      await refusalCode(
        t.mutation(api.tracing.record, {
          trace: TRACE,
          observations: [0, 1, 2, 3, 4].map((n) =>
            observationOfBytes(n, quarter),
          ),
        }),
      ),
    ).toBe("call_too_large");
    expect(
      await refusalCode(
        t.mutation(api.tracing.record, {
          trace: TRACE,
          observations: [observationOfBytes(0, MAX_ROW_BYTES + 1)],
        }),
      ),
    ).toBe("row_too_large");
    expect((await tables(t)).outbox).toHaveLength(0);
  });

  test("env defaults do not count against the 900 KiB of a span", async () => {
    enableExport();
    vi.stubEnv("LANGFUSE_TRACING_ENVIRONMENT", "production");
    vi.stubEnv("LANGFUSE_RELEASE", "release-".repeat(20));
    const t = initConvexTest();
    // The client measures spans with this encoder and without the defaults.
    expect(
      await t.mutation(api.tracing.record, {
        trace: TRACE,
        observations: [observationOfBytes(0, MAX_ROW_BYTES)],
      }),
    ).toEqual({ enqueued: 1 });
    const [row] = (await tables(t)).outbox;
    expect(row!.bytes).toBeGreaterThan(MAX_ROW_BYTES);
    expect(
      await refusalCode(
        t.mutation(api.tracing.record, {
          trace: TRACE,
          observations: [observationOfBytes(1, MAX_ROW_BYTES + 1)],
        }),
      ),
    ).toBe("row_too_large");
  });

  test("an invalid default environment refuses a call without its own", async () => {
    enableExport();
    vi.stubEnv("LANGFUSE_TRACING_ENVIRONMENT", "Production");
    const t = initConvexTest();
    expect(
      await refusalCode(
        t.mutation(api.tracing.record, {
          trace: TRACE,
          observations: [observation(0)],
        }),
      ),
    ).toBe("invalid_environment");
    expect((await tables(t)).outbox).toHaveLength(0);

    expect(
      await t.mutation(api.tracing.record, {
        trace: { ...TRACE, environment: "staging" },
        observations: [observation(1)],
      }),
    ).toEqual({ enqueued: 1 });
  });

  test("env defaults do not count against the 4 MiB of a call", async () => {
    enableExport();
    // The largest release Convex allows, 6 JSON bytes per character.
    vi.stubEnv("LANGFUSE_RELEASE", "\u001f".repeat(8_192));
    const t = initConvexTest({ transactionLimits: true });
    // 50 spans of just under 3 MiB, as the client splits them.
    const each = Math.floor((3 * 1024 * 1024) / 50);
    expect(
      await t.mutation(api.tracing.record, {
        trace: TRACE,
        observations: Array.from({ length: 50 }, (_, n) =>
          observationOfBytes(n, each),
        ),
      }),
    ).toEqual({ enqueued: 50 });
    expect((await tables(t)).outbox).toHaveLength(50);

    const over = Math.ceil(MAX_CALL_BYTES / 50) + 1;
    expect(
      await refusalCode(
        t.mutation(api.tracing.record, {
          trace: TRACE,
          observations: Array.from({ length: 50 }, (_, n) =>
            observationOfBytes(n, over),
          ),
        }),
      ),
    ).toBe("call_too_large");
    expect((await tables(t)).outbox).toHaveLength(50);
  });

  test("a 4 MiB call and the largest claims stay inside transaction limits", async () => {
    enableExport();
    const t = initConvexTest({ transactionLimits: true });
    const fifth = Math.floor(MAX_CALL_BYTES / 5);
    const call = [0, 1, 2, 3].map((n) => observationOfBytes(n, fifth));
    call.push(observationOfBytes(4, MAX_CALL_BYTES - 4 * fifth));
    expect(
      await t.mutation(api.tracing.record, {
        trace: TRACE,
        observations: call,
      }),
    ).toEqual({ enqueued: 5 });

    // 50 rows of 512 KiB in total, claimed in one batch.
    const fresh = initConvexTest({ transactionLimits: true });
    const each = Math.floor((512 * 1024) / 50);
    await insertRows(
      fresh,
      Array.from({ length: 50 }, (_, n) => ({ data: spanOfBytes(n, each) })),
    );
    await startRunByHand(fresh);
    const step = await fresh.mutation(internal.exporter.advance, {
      generation: 1,
    });
    expect(step.done === false && step.spans).toHaveLength(50);

    // One 900 KiB row, claimed alone.
    const single = initConvexTest({ transactionLimits: true });
    await insertRows(single, [{ data: spanOfBytes(0, MAX_ROW_BYTES) }]);
    await startRunByHand(single);
    const alone = await single.mutation(internal.exporter.advance, {
      generation: 1,
    });
    expect(alone.done === false && alone.spans).toHaveLength(1);
  });
});

describe("disabled", () => {
  async function expectDisabled(t: TestConvex) {
    expect(
      await t.mutation(api.tracing.record, {
        trace: TRACE,
        observations: [observation(0)],
      }),
    ).toEqual({ enqueued: 0, reason: "disabled" });
    expect(await tables(t)).toEqual({
      outbox: [],
      payloads: [],
      deadLetters: [],
      receipts: [],
      counter: [],
      exporter: [],
      gate: [],
    });
    const worker = await t.run(async (ctx) =>
      ctx.runQuery(components.batchWorker.lib.status, { name: WORKER_NAME }),
    );
    expect(worker).toBeNull();
  }

  test("without keys, record changes nothing", async () => {
    vi.stubEnv("LANGFUSE_BASE_URL", "https://langfuse.test");
    await expectDisabled(initConvexTest());
  });

  test("with keys but without a base URL, record changes nothing", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", PUBLIC_KEY);
    vi.stubEnv("LANGFUSE_SECRET_KEY", SECRET_KEY);
    await expectDisabled(initConvexTest());
  });
});
