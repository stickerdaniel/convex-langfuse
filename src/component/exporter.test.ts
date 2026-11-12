import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import {
  BACKOFF_CAP_MS,
  BREAKER_REJECTED_SPANS,
  LEASE_MS,
  MEASURE_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  WORKER_NAME,
} from "./constants.js";
import {
  drive,
  enableExport,
  exporterDoc,
  installFakeLangfuse,
  insertRows,
  observations,
  ownerlessPayloads,
  spanId,
  startRunByHand,
  tables,
  TRACE,
  type FakeLangfuse,
  type TestConvex,
} from "./fakeLangfuse.test-util.js";
import { initConvexTest } from "./setup.test.js";
import { encodeSpan } from "../shared/otlp.js";

let t: TestConvex;
let fake: FakeLangfuse;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  enableExport();
  fake = installFakeLangfuse();
  t = initConvexTest();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function record(from: number, count: number) {
  return await t.mutation(api.tracing.record, {
    trace: TRACE,
    observations: observations(from, count),
  });
}

const health = () => t.query(api.outbox.health, {});
const outboxEmpty = async () => (await tables(t)).outbox.length === 0;
const requestCount = (n: number) => () => fake.requests.length >= n;
/** Gaps between consecutive requests, in fake milliseconds. */
const gaps = () =>
  fake.requests.slice(1).map((request, i) => request.at - fake.requests[i]!.at);

describe("export", () => {
  test("120 records go out as 3 requests of at most 50 spans, in order", async () => {
    for (const from of [0, 40, 80]) await record(from, 40);
    await drive(t, fake);

    expect(fake.requests.map((request) => request.spanIds.length)).toEqual([
      50, 50, 20,
    ]);
    expect(fake.requests.flatMap((request) => request.spanIds)).toEqual(
      observations(0, 120).map((o) => o.id),
    );
    expect(await outboxEmpty()).toBe(true);
  });

  test("an endpoint down for three attempts loses no row and resends identical bytes", async () => {
    fake.respond({ network: true }, { network: true }, { network: true });
    await record(0, 5);
    await drive(t, fake);

    expect(fake.requests).toHaveLength(4);
    expect(new Set(fake.requests.map((request) => request.body)).size).toBe(1);
    expect(fake.requests[0]!.spanIds).toEqual(
      observations(0, 5).map((o) => o.id),
    );
    const state = await tables(t);
    expect(state.outbox).toHaveLength(0);
    expect(ownerlessPayloads(state)).toEqual([]);
    const { exporter } = await health();
    expect(exporter.consecutiveFailures).toBe(0);
    expect(exporter.accepted).toBe(5);
  });

  test.each([
    ["seconds", () => "7"],
    ["an HTTP date", () => new Date(Date.now() + 7_000).toUTCString()],
  ])(
    "a 429 with Retry-After in %s holds the next request for 7 s",
    async (_, value) => {
      fake.respond(() => ({
        status: 429,
        headers: { "Retry-After": value() },
      }));
      await record(0, 1);
      await drive(t, fake);

      expect(fake.requests).toHaveLength(2);
      expect(gaps()[0]).toBeGreaterThanOrEqual(7_000);
      expect(gaps()[0]).toBeLessThan(7_000 + 2_000);
    },
  );

  test("repeated 500 responses back off up to 5 minutes and no further", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    fake.fallback = { status: 500 };
    await record(0, 1);
    await drive(t, fake, { until: requestCount(14) });

    // In whole seconds; the fixed jitter takes 0.1 % off each backoff.
    const seconds = gaps().map((gap) => Math.round(gap / 1_000));
    expect(seconds.slice(0, 3)).toEqual([2, 4, 8]);
    // From 2^9 s on the cap holds.
    expect(seconds.slice(-5)).toEqual([300, 300, 300, 300, 300]);
    expect(Math.max(...gaps())).toBeLessThanOrEqual(BACKOFF_CAP_MS);
  });

  test("401 and 302 back off as config errors until kick, and a 200 resets", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    fake.respond({ status: 401 }, { status: 302 });
    await record(0, 1);
    let backoffUntil: number | undefined;
    await drive(t, fake, {
      until: async () => {
        const { exporter } = await health();
        if (fake.requests.length === 1) backoffUntil ??= exporter.backoffUntil;
        return fake.requests.length === 2 && !!exporter.backoffUntil;
      },
    });
    expect(backoffUntil).toBeDefined();
    expect(fake.requests[1]!.at).toBeGreaterThanOrEqual(backoffUntil!);

    const { exporter } = await health();
    expect(exporter.lastError).toMatchObject({ class: "config", status: 302 });
    expect(exporter.consecutiveFailures).toBe(2);
    expect(exporter.backoffUntil! - Date.now()).toBeGreaterThan(1_000);

    const kickedAt = Date.now();
    await t.mutation(internal.exporter.kick, {});
    await drive(t, fake, { until: requestCount(3) });
    // At once: well before the pending backoff would have ended.
    expect(fake.requests[2]!.at - kickedAt).toBeLessThan(100);
    await drive(t, fake);
    expect((await health()).exporter.consecutiveFailures).toBe(0);
    expect(await outboxEmpty()).toBe(true);
  });

  test("a request that never resolves is aborted after 20 s and sent again", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    fake.respond({ hang: true });
    await record(0, 2);
    await drive(t, fake);

    expect(fake.requests).toHaveLength(2);
    expect(gaps()[0]).toBeGreaterThanOrEqual(REQUEST_TIMEOUT_MS);
    expect(fake.requests[1]!.body).toBe(fake.requests[0]!.body);
    expect(await outboxEmpty()).toBe(true);
  });
});

describe("rejection", () => {
  test("a rejected batch is isolated: the poison row is dead-lettered, the rest accepted", async () => {
    const poison = spanId(3);
    fake.fallback = (request) => ({
      status: request.spanIds.includes(poison) ? 400 : 200,
    });
    await record(0, 10);
    await drive(t, fake);

    expect(fake.requests[0]!.spanIds).toHaveLength(10);
    const state = await tables(t);
    expect(state.outbox).toHaveLength(0);
    expect(state.deadLetters).toMatchObject([
      { ref: `${TRACE.traceId}:${poison}`, reason: "rejected", status: 400 },
    ]);
    expect((await health()).exporter.accepted).toBe(9);

    const before = fake.requests.length;
    await record(10, 5);
    await drive(t, fake);
    expect(fake.requests.slice(before).map((r) => r.spanIds.length)).toEqual([
      5,
    ]);
  });

  test("systemic rejection trips the breaker after 20 dead letters", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    fake.fallback = { status: 400 };
    await record(0, 25);
    await drive(t, fake, {
      until: async () =>
        (await health()).exporter.lastError?.class === "config",
    });
    expect((await tables(t)).deadLetters).toHaveLength(BREAKER_REJECTED_SPANS);

    const before = fake.requests.length;
    await drive(t, fake, { until: requestCount(before + 3) });
    const state = await tables(t);
    expect(state.deadLetters).toHaveLength(BREAKER_REJECTED_SPANS);
    expect(state.outbox).toHaveLength(25 - BREAKER_REJECTED_SPANS);
  });
});

describe("fencing", () => {
  test("advance with a superseded generation changes nothing", async () => {
    const ids = await insertRows(t, [{ data: "a" }, { data: "b" }]);
    await t.run(async (ctx) => {
      await ctx.db.insert(
        "exporter",
        exporterDoc({
          generation: 2,
          leaseExpiresAt: Date.now() + LEASE_MS,
          runStartedAt: Date.now(),
          claimed: ids,
        }),
      );
    });
    const before = await tables(t);
    for (const report of [
      { outcome: "accepted" as const, status: 200 },
      { outcome: "transient" as const },
      undefined,
    ]) {
      expect(
        await t.mutation(internal.exporter.advance, { generation: 1, report }),
      ).toEqual({ done: true });
    }
    expect(await tables(t)).toEqual(before);
  });

  test("a batch accepted but never acknowledged is resent byte-identically after the lease", async () => {
    await insertRows(
      t,
      observations(0, 3).map((o, i) => ({
        data: encodeSpan(TRACE, o),
        ref: `${TRACE.traceId}:${spanId(i)}`,
      })),
    );
    await startRunByHand(t);
    // The run claims a batch, Langfuse accepts it, and the run dies before
    // reporting.
    const step = await t.mutation(internal.exporter.advance, { generation: 1 });
    if (!("spans" in step)) throw new Error("expected a span batch");
    const { send } = await import("./exporter.js");
    const config = {
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      baseUrl: "https://langfuse.test",
    };
    expect(await send(config, step.spans)).toMatchObject({
      outcome: "accepted",
    });
    const sentAt = Date.now();

    await t.mutation(internal.exporter.kick, {});
    await drive(t, fake);

    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.at).toBeGreaterThanOrEqual(sentAt + LEASE_MS);
    expect(fake.requests[1]!.body).toBe(fake.requests[0]!.body);
    const state = await tables(t);
    expect(state.outbox).toHaveLength(0);
    expect(state.exporter[0]!.generation).toBe(2);
  });

  test("a start right after a failure set a backoff schedules no run before it ends", async () => {
    fake.respond({ status: 503, headers: { "Retry-After": "30" } });
    await record(0, 1);
    await drive(t, fake, {
      until: async () => !!(await health()).exporter.backoffUntil,
    });
    const { backoffUntil } = (await health()).exporter;

    const result = await t.mutation(internal.exporter.dispatch, {
      op: "start",
    });
    expect(result?.debounceMs).toBeGreaterThan(0);
    await drive(t, fake);

    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.at).toBeGreaterThanOrEqual(backoffUntil!);
  });

  test("a row recorded right after the loop saw an empty queue is still exported", async () => {
    await record(0, 1);
    await drive(t, fake, { until: outboxEmpty });
    // The loop is still running, so this enqueue's ping is a no-op.
    await record(1, 1);
    await drive(t, fake);

    expect(fake.requests.map((request) => request.spanIds)).toEqual([
      [spanId(0)],
      [spanId(1)],
    ]);
  });

  test("a row recorded after the loop went idle is exported through its enqueue", async () => {
    await record(0, 1);
    await drive(t, fake);
    // Fully idle: the loop and its monitor are gone, nothing is scheduled.
    expect(
      await t.run(async (ctx) =>
        ctx.runQuery(components.batchWorker.lib.status, { name: WORKER_NAME }),
      ),
    ).toEqual({ kind: "idle" });
    expect(vi.getTimerCount()).toBe(0);

    await record(1, 1);
    await drive(t, fake);
    expect(fake.requests.map((request) => request.spanIds)).toEqual([
      [spanId(0)],
      [spanId(1)],
    ]);
  });
});

describe("backlog counting", () => {
  /** Snapshot time of the last count step that consumed every receipt, in ms. */
  const countedAt = async () => {
    const from = (await tables(t)).counter[0]?.countedFrom;
    return from === undefined ? undefined : Number(from / 1_000_000n);
  };

  /**
   * Asserts a count step at least every minute and one loop poll between
   * `from` and `to`. A chain starts at the first `dispatch` at least a minute
   * after the last one started, and the loop polls 2 s after a start. The
   * remaining 100 ms cover the commit clock, which moves 1 ms per
   * transaction.
   */
  function expectEveryMinute(samples: number[], from: number, to: number) {
    const points = [from, ...new Set(samples), to];
    for (let i = 1; i < points.length; i++) {
      expect(points[i]! - points[i - 1]!).toBeLessThanOrEqual(
        MEASURE_INTERVAL_MS + 2_000 + 100,
      );
    }
  }

  test("runs at least once a minute during a 5 minute backoff", async () => {
    fake.respond({ status: 503, headers: { "Retry-After": "300" } });
    await record(0, 1);
    await drive(t, fake, { until: requestCount(1) });
    const from = fake.requests[0]!.at;
    const samples: number[] = [];
    await drive(t, fake, {
      until: requestCount(2),
      onStep: async () => {
        const at = await countedAt();
        if (at !== undefined && at >= from) samples.push(at);
      },
    });
    expect(gaps()[0]).toBeGreaterThanOrEqual(300_000);
    expectEveryMinute(samples, from, fake.requests[1]!.at);
  });

  test("runs at least once a minute during the lease of a run that never reports", async () => {
    await insertRows(t, [{ data: encodeSpan(TRACE, observations(0, 1)[0]!) }]);
    await startRunByHand(t);
    const step = await t.mutation(internal.exporter.advance, { generation: 1 });
    expect(step.done).toBe(false);
    const from = Date.now();

    await t.mutation(internal.exporter.kick, {});
    const samples: number[] = [];
    await drive(t, fake, {
      until: requestCount(1),
      onStep: async () => {
        const at = await countedAt();
        if (at !== undefined) samples.push(at);
      },
    });
    expect(fake.requests[0]!.at).toBeGreaterThanOrEqual(from + LEASE_MS);
    expectEveryMinute(samples, from, from + LEASE_MS);
  });
});
