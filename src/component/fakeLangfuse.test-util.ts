// Test-only fake of the Langfuse OTLP endpoint, a driver for the exporter
// loop under fake timers, and fixtures. Not part of the build.

import { ConvexError } from "convex/values";
import { vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { initConvexTest } from "./setup.test.js";
import { byteLength, encodeSpan } from "../shared/otlp.js";
import type { Observation, TraceContext } from "../shared/validators.js";

export type TestConvex = ReturnType<typeof initConvexTest>;

/** How the fake answers one request. `body` is sent as JSON. */
export type Behaviour =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  | { network: true }
  | { hang: true };

export type RecordedRequest = {
  url: string;
  method: string;
  /** Path and query of `url`. */
  path: string;
  headers: Record<string, string>;
  body: string;
  /** Fake-clock time the request was sent. */
  at: number;
  /** Span ids of an OTLP request; empty for any other request. */
  spanIds: string[];
};

type Answer =
  | Behaviour
  | ((request: RecordedRequest) => Behaviour | Promise<Behaviour>);

type ExportBody = {
  resourceSpans: { scopeSpans: { spans: { spanId: string }[] }[] }[];
};

export type FakeLangfuse = ReturnType<typeof installFakeLangfuse>;

const OTLP_PATH = "/api/public/otel/v1/traces";

/**
 * Replaces global `fetch` with a fake Langfuse. It records every request and
 * answers from the queue filled by `respond`, then with `fallback`. An answer
 * can be a function of the recorded request.
 */
export function installFakeLangfuse() {
  const requests: RecordedRequest[] = [];
  const queue: Answer[] = [];
  const fake = {
    requests,
    /** Answer once the queue is empty. */
    fallback: { status: 200 } as Answer,
    /** Requests that hang and have not been aborted yet. */
    hanging: 0,
    /** Answers the next requests with these behaviours, in order. */
    respond(...answers: Answer[]) {
      queue.push(...answers);
    },
  };
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      const url = new URL(String(input));
      const parsed =
        url.pathname === OTLP_PATH ? (JSON.parse(body) as ExportBody) : null;
      const request: RecordedRequest = {
        url: String(input),
        method: init?.method ?? "GET",
        path: url.pathname + url.search,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body,
        at: Date.now(),
        spanIds:
          parsed?.resourceSpans.flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) =>
              scope.spans.map((span) => span.spanId),
            ),
          ) ?? [],
      };
      requests.push(request);
      const answer = queue.shift() ?? fake.fallback;
      const behaviour =
        typeof answer === "function" ? await answer(request) : answer;
      if ("network" in behaviour) throw new TypeError("fetch failed");
      if ("hang" in behaviour) {
        fake.hanging += 1;
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            fake.hanging -= 1;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return new Response(
        behaviour.body === undefined ? null : JSON.stringify(behaviour.body),
        { status: behaviour.status, headers: behaviour.headers },
      );
    },
  );
  return fake;
}

// Captured before a test installs fake timers.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realTick = () => new Promise((resolve) => realSetTimeout(resolve, 5));

/**
 * Advances the fake clock one timer at a time and lets the scheduled
 * functions it starts finish, until `until` holds or nothing is scheduled any
 * more. A hanging request is not waited for; its abort timer fires on a later
 * step. `onStep` runs after every step, for sampling state.
 */
export async function drive(
  t: Pick<TestConvex, "finishInProgressScheduledFunctions">,
  fake: FakeLangfuse,
  options: {
    until?: () => boolean | Promise<boolean>;
    onStep?: () => void | Promise<void>;
  } = {},
): Promise<void> {
  for (let step = 0; step < 100_000; step++) {
    let settled = false;
    const finished = t.finishInProgressScheduledFunctions().then(() => {
      settled = true;
    });
    while (!settled && fake.hanging === 0) {
      await Promise.race([finished, realTick()]);
    }
    await options.onStep?.();
    if (await options.until?.()) return;
    if (vi.getTimerCount() === 0) return;
    await vi.advanceTimersToNextTimerAsync();
  }
  throw new Error("drive: too many steps");
}

/**
 * Runs the functions that are scheduled for now, such as `reconcileGate`.
 * It moves the fake clock by 1 ms, because the transaction clock of
 * convex-test can run up to 1 ms ahead of it.
 */
export async function runScheduledNow(t: TestConvex): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
  await t.finishInProgressScheduledFunctions();
}

/**
 * Starts the functions that are scheduled for now, like `runScheduledNow`,
 * and gives them real time to finish. For use while an action is in flight,
 * where `runScheduledNow` would wait for that action.
 */
export async function startScheduledNow(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
  await realTick();
  await realTick();
}

export const PUBLIC_KEY = "pk-lf-test";
export const SECRET_KEY = "sk-lf-test";
export const ENDPOINT = "https://langfuse.test/api/public/otel/v1/traces";

/** Binds the env values that enable the component. */
export function enableExport(): void {
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", PUBLIC_KEY);
  vi.stubEnv("LANGFUSE_SECRET_KEY", SECRET_KEY);
  vi.stubEnv("LANGFUSE_BASE_URL", "https://langfuse.test/");
}

export const TRACE: TraceContext = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  name: "chat-turn",
};

/** A valid observation id for `n >= 0`. */
export function spanId(n: number): string {
  return (n + 1).toString(16).padStart(16, "0");
}

export function observation(
  n: number,
  extra: Partial<Observation> = {},
): Observation {
  return {
    id: spanId(n),
    type: "span",
    name: `step-${n}`,
    startTime: 1_794_398_400_000 + n,
    endTime: 1_794_398_400_000 + n + 1,
    ...extra,
  };
}

/** Observations `from` to `from + count - 1`. */
export function observations(from: number, count: number): Observation[] {
  return Array.from({ length: count }, (_, i) => observation(from + i));
}

/** An encoded span of exactly `bytes` UTF-8 bytes. */
export function spanOfBytes(n: number, bytes: number): string {
  const base = byteLength(encodeSpan(TRACE, observation(n, { input: "" })));
  const data = encodeSpan(
    TRACE,
    observation(n, { input: "x".repeat(bytes - base) }),
  );
  if (byteLength(data) !== bytes) throw new Error("spanOfBytes: size drift");
  return data;
}

/**
 * Inserts outbox rows with their payloads directly in one commit, without
 * waking the exporter, and writes one receipt for them, as an enqueue does.
 * With `receiptPerRow`, every row gets a receipt of its own. Rows are
 * available at `availableAt`, by default now. Returns the outbox ids in
 * insertion order.
 */
export async function insertRows(
  t: TestConvex,
  rows: { data: string; ref?: string }[],
  {
    receiptPerRow = false,
    availableAt = Date.now(),
  }: { receiptPerRow?: boolean; availableAt?: number } = {},
): Promise<Id<"outbox">[]> {
  return await t.run(async (ctx) => {
    const ids: Id<"outbox">[] = [];
    const receipt = (rows: number, bytes: number) =>
      ctx.db.insert("receipts", { rows, bytes, seq: ctx.db.vars.commitTs });
    let total = 0;
    for (const [i, { data, ref }] of rows.entries()) {
      const payloadId = await ctx.db.insert("payloads", { data });
      const bytes = byteLength(data);
      ids.push(
        await ctx.db.insert("outbox", {
          kind: "span",
          ref: ref ?? `${TRACE.traceId}:${spanId(i)}`,
          bytes,
          availableAt,
          payloadId,
        }),
      );
      if (receiptPerRow) await receipt(1, bytes);
      total += bytes;
    }
    if (!receiptPerRow && rows.length > 0) await receipt(rows.length, total);
    return ids;
  });
}

/** `count` rows of one byte each. */
export function oneByteRows(count: number): { data: string }[] {
  return Array.from({ length: count }, () => ({ data: "x" }));
}

/**
 * Runs one step of the current count chain, as the scheduler would. Creates
 * the counter at chain 0 when it is missing.
 */
export async function countStep(t: TestConvex): Promise<void> {
  const chain = await t.run(async (ctx) => {
    const counter = await ctx.db.query("counter").first();
    if (counter) return counter.chain;
    await ctx.db.insert("counter", { addedRows: 0, addedBytes: 0, chain: 0 });
    return 0;
  });
  await t.mutation(internal.outbox.count, { chain });
}

export type Tables = {
  outbox: Doc<"outbox">[];
  payloads: Doc<"payloads">[];
  deadLetters: Doc<"deadLetters">[];
  receipts: Doc<"receipts">[];
  counter: Doc<"counter">[];
  exporter: Doc<"exporter">[];
  gate: Doc<"gate">[];
  scoreKeys: Doc<"scoreKeys">[];
};

/** Every document of the component's export tables. */
export async function tables(t: TestConvex): Promise<Tables> {
  return await t.run(async (ctx) => ({
    outbox: await ctx.db.query("outbox").collect(),
    payloads: await ctx.db.query("payloads").collect(),
    deadLetters: await ctx.db.query("deadLetters").collect(),
    receipts: await ctx.db.query("receipts").collect(),
    counter: await ctx.db.query("counter").collect(),
    exporter: await ctx.db.query("exporter").collect(),
    gate: await ctx.db.query("gate").collect(),
    scoreKeys: await ctx.db.query("scoreKeys").collect(),
  }));
}

/** Payloads that no outbox row and no dead letter points to. */
export function ownerlessPayloads(state: Tables): Id<"payloads">[] {
  const owned = new Set(
    [...state.outbox, ...state.deadLetters].map((row) => row.payloadId),
  );
  return state.payloads
    .filter((payload) => !owned.has(payload._id))
    .map((payload) => payload._id);
}

/** Scheduled functions of the component that have not run yet. */
export async function pendingScheduled(t: TestConvex): Promise<string[]> {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((job) => job.state.kind === "pending")
      .map((job) => job.name),
  );
}

type ExporterFields = Omit<Doc<"exporter">, "_id" | "_creationTime">;

/** An exporter document with zero totals, changed by `fields`. */
export function exporterDoc(
  fields: Partial<ExporterFields> = {},
): ExporterFields {
  return {
    generation: 0,
    claimed: [],
    consecutiveFailures: 0,
    consecutiveRejected: 0,
    isolateRemaining: 0,
    accepted: 0,
    deadLettered: 0,
    expired: 0,
    removedRows: 0,
    removedBytes: 0,
    ...fields,
  };
}

/** Starts a run by hand: generation 1 with an active lease. */
export async function startRunByHand(t: TestConvex): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    const run = {
      generation: 1,
      leaseExpiresAt: now + 120_000,
      runStartedAt: now,
    };
    const existing = await ctx.db.query("exporter").first();
    if (existing) {
      await ctx.db.patch("exporter", existing._id, run);
    } else {
      await ctx.db.insert("exporter", exporterDoc(run));
    }
  });
}

/** The pending backlog as `health` reports it. */
export async function pendingCounted(
  t: TestConvex,
): Promise<{ rows: number; bytes: number }> {
  return (await t.query(api.outbox.health, {})).pendingCounted;
}

type Amount = { rows: number; bytes: number };

/** The stored added and removed totals, without the clamping of `health`. */
export async function totals(
  t: TestConvex,
): Promise<{ added: Amount; removed: Amount }> {
  return await t.run(async (ctx) => {
    const counter = await ctx.db.query("counter").first();
    const exporter = await ctx.db.query("exporter").first();
    return {
      added: { rows: counter?.addedRows ?? 0, bytes: counter?.addedBytes ?? 0 },
      removed: {
        rows: exporter?.removedRows ?? 0,
        bytes: exporter?.removedBytes ?? 0,
      },
    };
  });
}

/** Runs count steps until no receipt is left. */
export async function consumeReceipts(t: TestConvex): Promise<void> {
  while (await t.run(async (ctx) => await ctx.db.query("receipts").first())) {
    await countStep(t);
  }
}

/** The `ConvexError` data a call is refused with. */
export async function refusalCode(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConvexError) return error.data;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** A remote score config as the list endpoint returns it. */
export type RemoteConfig = {
  id: string;
  name: string;
  dataType: string;
  isArchived: boolean;
  minValue?: number | null;
  maxValue?: number | null;
  categories?: { label: string; value: number }[] | null;
  createdAt: string;
};

/**
 * Serves `remote` as the score config endpoints of `fake`, newest first like
 * Langfuse, and appends created configs to it with the ids `created-1`,
 * `created-2` and so on. `onPage` can replace the answer of a page. Any other
 * request gets a 200.
 */
export function serveConfigs(
  fake: FakeLangfuse,
  remote: RemoteConfig[],
  onPage?: (page: number) => Promise<{ status: number } | undefined>,
): void {
  let created = 0;
  fake.fallback = async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/public/score-configs") return { status: 200 };
    if (request.method === "POST") {
      const body = JSON.parse(request.body) as Omit<RemoteConfig, "id">;
      created += 1;
      const config: RemoteConfig = {
        ...body,
        id: `created-${created}`,
        isArchived: false,
        createdAt: new Date().toISOString(),
      };
      remote.push(config);
      return { status: 200, body: config };
    }
    const page = Number(url.searchParams.get("page"));
    const limit = Number(url.searchParams.get("limit"));
    const replaced = await onPage?.(page);
    if (replaced) return replaced;
    const sorted = [...remote].reverse();
    return {
      status: 200,
      body: {
        data: sorted.slice((page - 1) * limit, page * limit),
        meta: {
          page,
          limit,
          totalItems: sorted.length,
          totalPages: Math.ceil(sorted.length / limit),
        },
      },
    };
  };
}
