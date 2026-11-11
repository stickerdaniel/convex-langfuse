// Test-only fake of the Langfuse OTLP endpoint, a driver for the exporter
// loop under fake timers, and fixtures. Not part of the build.

import { vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { initConvexTest } from "./setup.test.js";
import { byteLength, encodeSpan } from "../shared/otlp.js";
import type { Observation, TraceContext } from "../shared/validators.js";

export type TestConvex = ReturnType<typeof initConvexTest>;

/** How the fake answers one request. */
export type Behaviour =
  | { status: number; headers?: Record<string, string> }
  | { network: true }
  | { hang: true };

export type RecordedRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Fake-clock time the request was sent. */
  at: number;
  spanIds: string[];
};

type Answer =
  | Behaviour
  | ((request: RecordedRequest) => Behaviour | Promise<Behaviour>);

type ExportBody = {
  resourceSpans: { scopeSpans: { spans: { spanId: string }[] }[] }[];
};

export type FakeLangfuse = ReturnType<typeof installFakeLangfuse>;

/**
 * Replaces global `fetch` with a fake endpoint. It records every request and
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
      const parsed = JSON.parse(body) as ExportBody;
      const request: RecordedRequest = {
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body,
        at: Date.now(),
        spanIds: parsed.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) =>
            scope.spans.map((span) => span.spanId),
          ),
        ),
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
      return new Response(null, {
        status: behaviour.status,
        headers: behaviour.headers,
      });
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
  t: TestConvex,
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
 * Inserts outbox rows with their payloads directly, without waking the
 * exporter. Returns the outbox ids in insertion order.
 */
export async function insertRows(
  t: TestConvex,
  rows: { data: string; ref?: string }[],
): Promise<Id<"outbox">[]> {
  return await t.run(async (ctx) => {
    const ids: Id<"outbox">[] = [];
    const availableAt = Date.now();
    for (const [i, { data, ref }] of rows.entries()) {
      const payloadId = await ctx.db.insert("payloads", { data });
      ids.push(
        await ctx.db.insert("outbox", {
          kind: "span",
          ref: ref ?? `${TRACE.traceId}:${spanId(i)}`,
          bytes: byteLength(data),
          availableAt,
          payloadId,
          seq: ctx.db.vars.commitTs,
        }),
      );
    }
    return ids;
  });
}

export type Tables = {
  outbox: Doc<"outbox">[];
  payloads: Doc<"payloads">[];
  deadLetters: Doc<"deadLetters">[];
  exporter: Doc<"exporter">[];
  gate: Doc<"gate">[];
};

/** Every document of the component's export tables. */
export async function tables(t: TestConvex): Promise<Tables> {
  return await t.run(async (ctx) => ({
    outbox: await ctx.db.query("outbox").collect(),
    payloads: await ctx.db.query("payloads").collect(),
    deadLetters: await ctx.db.query("deadLetters").collect(),
    exporter: await ctx.db.query("exporter").collect(),
    gate: await ctx.db.query("gate").collect(),
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

/** An exporter document with zero counters, changed by `fields`. */
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
    pendingRows: 0,
    pendingBytes: 0,
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

/** The pending counters as `health` reports them. */
export async function pendingCounted(
  t: TestConvex,
): Promise<{ rows: number; bytes: number }> {
  return (await t.query(api.outbox.health, {})).pendingCounted;
}
