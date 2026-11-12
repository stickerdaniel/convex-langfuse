import type {
  FunctionReturnType,
  GenericActionCtx,
  GenericDataModel,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  isEnvironmentName,
  isObservationId,
  isTraceId,
  observationIdFromKey,
  traceIdFromSeed,
} from "../shared/ids.js";
import {
  CLIENT_CALL_BYTES,
  MAX_CALL_RECORDS,
  MAX_DETAIL_KEYS,
  MAX_ROW_BYTES,
  MAX_TAGS,
} from "../shared/limits.js";
import {
  byteLength,
  costDetails,
  encodeSpan,
  isCostValue,
  isPromptLink,
} from "../shared/otlp.js";
import type {
  Level,
  Observation,
  ObservationType,
  Prompt,
  TraceContext,
} from "../shared/validators.js";

export { observationIdFromKey, traceIdFromSeed } from "../shared/ids.js";
export type { Level, ObservationType } from "../shared/validators.js";

export type LangfuseOptions = {
  /** "full" exports input, output and status messages. "none" removes them. Required: there is no default. */
  content: "full" | "none";
  /** Sees every record before it leaves the app. Returns the record to export, or null to drop it. */
  redact?: (record: ExportRecord) => ExportRecord | null;
  /** Limit for a serialized input or output in UTF-8 bytes. Default 131072. */
  maxFieldBytes?: number;
  /** "log" (default) never throws from a recording method. "throw" rethrows. */
  onError?: "log" | "throw";
};

/** An observation named by a key, hashed together with the trace id, or by its id. */
export type ObservationRef =
  | { key: string; id?: never }
  | { id: string; key?: never };

/** Trace-level fields, written on every observation of the trace. */
export type TraceFields = {
  name?: string;
  userId?: string;
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  environment?: string;
  release?: string;
  experiment?: {
    id: string;
    name: string;
    datasetId?: string;
    itemId?: string;
    rootObservation?: ObservationRef;
    metadata?: Record<string, unknown>;
  };
};

/** A trace named by a seed, hashed like `createTraceId` of the Langfuse SDK, or by its id. */
export type TraceInit = (
  | { seed: string; traceId?: never }
  | { traceId: string; seed?: never }
) &
  TraceFields;

/** Observation fields other than its identity. Times are epoch milliseconds. */
export type ObservationFields = {
  name: string;
  /** Default `Date.now()`. */
  startTime?: number;
  /** Default `startTime`. An event always ends at its start time. */
  endTime?: number;
  completionStartTime?: number;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: Level;
  statusMessage?: string;
  version?: string;
  model?: string;
  modelParameters?: Record<string, unknown>;
  usage?: Record<string, number>;
  cost?: Record<string, number>;
  /** Exported only on a generation, with a non-empty name and a positive integer version. */
  prompt?: { name: string; version: number };
};

export type ObservationInit = ObservationRef & {
  parent?: ObservationRef;
} & ObservationFields;

/**
 * What `redact` sees: one observation with its trace fields, before
 * serialization. Changes to the ids are ignored, and so is a changed
 * `experiment.rootObservation`; a removed one is not exported. The record,
 * its trace and its observation are shallow copies: nested values such as
 * `tags`, `input` or `metadata` are the caller's own objects, so build new
 * ones instead of changing them in place.
 */
export type ExportRecord = {
  kind: "observation";
  traceId: string;
  observationId: string;
  parentObservationId?: string;
  trace: TraceFields;
  observation: ObservationFields & { type: ObservationType };
};

/**
 * Fixed codes a recording method logs, or throws as the `Error` message with
 * `onError: "throw"`. A record dropped by `redact` is not logged.
 */
export type ErrorCode =
  | "invalid_id"
  | "invalid_environment"
  | "invalid_metadata"
  | "invalid_tags"
  | "unserializable"
  | "invalid_usage"
  | "invalid_cost"
  | "invalid_prompt"
  | "row_too_large"
  | "redact_failed"
  | "backlog"
  | "enqueue_failed";

/** The component's export state, as `outbox.health` returns it. */
export type Health = FunctionReturnType<ComponentApi["outbox"]["health"]>;

/** Ids of one recorded observation. */
export type Recorded = { traceId: string; observationId: string };

/**
 * One trace. Its recording methods return the ids, also for a record that
 * was not sent. With `onError: "log"` they never throw. The same key recorded
 * twice gives two rows in Langfuse; make the recording mutation idempotent or
 * put the attempt in the key.
 *
 * In a mutation, every component call of a method is part of the caller's
 * transaction: the observations commit or roll back with it. An action has
 * no transaction: each component call commits on its own, so a `record` that
 * needs several calls can enqueue the first and fail on a later one.
 */
export interface Trace {
  /** The trace id, derived from the seed or given. */
  id(): Promise<string>;
  /** The observation id for a key in this trace. */
  observationId(key: string): Promise<string>;
  /** Records an LLM call. Only a generation exports its `prompt` link. */
  generation(ctx: RunMutationCtx, init: ObservationInit): Promise<Recorded>;
  /** Records a unit of work with a duration. */
  span(ctx: RunMutationCtx, init: ObservationInit): Promise<Recorded>;
  /** Records a point in time; `endTime` is ignored. */
  event(ctx: RunMutationCtx, init: ObservationInit): Promise<Recorded>;
  /** Records several observations of any of the ten types with as few component calls as possible. */
  record(
    ctx: RunMutationCtx,
    observations: Array<ObservationInit & { type: ObservationType }>,
  ): Promise<{ traceId: string; observationIds: string[] }>;
}

const DEFAULT_MAX_FIELD_BYTES = 131_072;
const DROPPED_METADATA = '{"dropped":"too_large"}';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Thrown with `onError: "throw"`; its message is the code. */
class CodeError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A copy of a parsed JSON value with object keys sorted at every depth. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]: [string, unknown]) => [key, sortKeys(item)]),
  );
}

/**
 * `value` as `JSON.stringify` converts it, with object keys sorted at every
 * depth, so equal values give equal strings. The conversion is the native
 * one: `toJSON` gets its key, boxed primitives are unboxed and members
 * without a JSON form are dropped. `undefined` when JSON has no
 * representation for the value. Throws on a cycle or a bigint.
 */
function sortedJson(value: unknown): unknown {
  const text = JSON.stringify(value) as string | undefined;
  return text === undefined ? undefined : sortKeys(JSON.parse(text));
}

/**
 * A copy with every lone surrogate replaced by U+FFFD, in strings at any
 * depth. A string cut inside an emoji holds one. Convex refuses an argument
 * with such a string, which would fail the whole component call.
 */
function wellFormed<T>(value: T): T;
function wellFormed(value: unknown): unknown {
  // In Unicode mode a surrogate pair is one code point, so the category
  // "surrogate" matches only the lone ones.
  if (typeof value === "string") return value.replace(/\p{Cs}/gu, "\ufffd");
  if (Array.isArray(value)) return value.map((item) => wellFormed(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, wellFormed(item)]),
    );
  }
  return value;
}

/**
 * Cuts `text` to at most `limit` UTF-8 bytes on a character boundary and
 * appends a marker with the number of bytes removed.
 */
function truncate(text: string, limit: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= limit) return text;
  let cut = Math.max(0, limit);
  // Back off over continuation bytes (0b10xxxxxx) to a character start.
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
  const kept = decoder.decode(bytes.subarray(0, cut));
  return `${kept}…[truncated ${bytes.byteLength - cut} bytes]`;
}

/**
 * The entries of a usage or cost record that `keep` accepts, under keys
 * Convex accepts in a record: 1 to 1,024 printable ASCII characters, not
 * starting with `$` or `_`. `invalid` tells that the value was not a plain
 * object, had more than `MAX_DETAIL_KEYS` entries, or lost an entry.
 */
function details(
  value: unknown,
  keep: (value: number) => boolean,
): { kept?: Record<string, number>; invalid: boolean } {
  if (value === undefined) return { invalid: false };
  if (!isPlainObject(value)) return { invalid: true };
  const entries = Object.entries(value);
  if (entries.length > MAX_DETAIL_KEYS) return { invalid: true };
  const kept = entries.filter(
    (entry): entry is [string, number] =>
      /^[\x20-\x7e]{1,1024}$/.test(entry[0]) &&
      !/^[$_]/.test(entry[0]) &&
      typeof entry[1] === "number" &&
      keep(entry[1]),
  );
  return {
    ...(kept.length > 0 ? { kept: Object.fromEntries(kept) } : {}),
    invalid: kept.length < entries.length,
  };
}

async function resolveTraceId(init: TraceInit): Promise<string> {
  return init.traceId ?? (await traceIdFromSeed(init.seed));
}

async function resolveRef(traceId: string, ref: ObservationRef) {
  return ref.id ?? (await observationIdFromKey(traceId, ref.key));
}

/** The id a ref names: `undefined` without a ref, "" for an empty key. */
async function tryResolveRef(
  traceId: string,
  ref: ObservationRef | undefined,
): Promise<string | undefined> {
  if (ref === undefined) return undefined;
  return await resolveRef(traceId, ref).catch(() => "");
}

/** One observation ready for the component, with its encoded size. */
type Prepared = {
  trace: TraceContext;
  observation: Observation;
  /** The serialized trace context; observations of one call share it. */
  context: string;
  bytes: number;
};

/**
 * Exports LLM traces to Langfuse through the component's transactional
 * outbox. A recording method enqueues in the caller's transaction: in a
 * mutation, the observation commits or rolls back with the caller's writes.
 *
 * ```ts
 * const langfuse = new Langfuse(components.convexLangfuse, { content: "full" });
 * const trace = langfuse.trace({ seed: `chat:${chatId}`, userId });
 * await trace.generation(ctx, { key: "llm", name: "answer", model, input, output });
 * ```
 */
export class Langfuse {
  readonly #component: ComponentApi;
  readonly #options: LangfuseOptions;

  constructor(component: ComponentApi, options: LangfuseOptions) {
    this.#component = component;
    this.#options = options;
  }

  /**
   * A handle for one trace, named by `seed` or `traceId`. Creating it does no
   * work; every observation recorded through it carries these trace fields.
   */
  trace(init: TraceInit): Trace {
    let traceId: Promise<string> | undefined;
    const id = () => (traceId ??= resolveTraceId(init));
    const one = async (
      ctx: RunMutationCtx,
      type: ObservationType,
      observation: ObservationInit,
    ): Promise<Recorded> => {
      const recorded = await this.#record(ctx, init, id, [
        { ...observation, type },
      ]);
      return {
        traceId: recorded.traceId,
        observationId: recorded.observationIds[0] ?? "",
      };
    };
    return {
      id,
      observationId: async (key) => await observationIdFromKey(await id(), key),
      generation: (ctx, observation) => one(ctx, "generation", observation),
      span: (ctx, observation) => one(ctx, "span", observation),
      event: (ctx, observation) => one(ctx, "event", observation),
      record: (ctx, observations) => this.#record(ctx, init, id, observations),
    };
  }

  /** The component's export state: gate, backlog, exporter and dead letters. */
  async health(ctx: RunQueryCtx): Promise<Health> {
    return await ctx.runQuery(this.#component.outbox.health, {});
  }

  /**
   * Logs `code` with ids only, or throws it with `onError: "throw"`. Never
   * logs field content or error messages, which can carry user data. An id
   * the caller passed is logged only when it is a valid id: an invalid one
   * can be any text.
   */
  #fail(code: ErrorCode, ids: Recorded): void {
    if (this.#options.onError === "throw") throw new CodeError(code);
    console.error(`[convex-langfuse] ${code}`, {
      traceId: isTraceId(ids.traceId) ? ids.traceId : "",
      observationId: isObservationId(ids.observationId)
        ? ids.observationId
        : "",
    });
  }

  /**
   * Prepares every observation, then sends the survivors in as few component
   * calls as the call bounds allow. Returns the ids of every observation,
   * also of those that were not sent.
   */
  async #record(
    ctx: RunMutationCtx,
    init: TraceInit,
    id: () => Promise<string>,
    items: Array<ObservationInit & { type: ObservationType }>,
  ): Promise<{ traceId: string; observationIds: string[] }> {
    const traceId = await id().catch(() => "");
    const observationIds: string[] = [];
    const prepared: Prepared[] = [];
    for (const item of items) {
      const ids: Recorded = {
        traceId,
        observationId: (await tryResolveRef(traceId, item)) ?? "",
      };
      observationIds.push(ids.observationId);
      try {
        const ready = await this.#prepare(init, item, ids);
        if (ready) prepared.push(ready);
      } catch (error) {
        if (error instanceof CodeError) throw error;
        this.#fail("enqueue_failed", ids);
      }
    }
    for (const call of groupCalls(prepared)) {
      const first = call[0]!;
      const ids = { traceId, observationId: first.observation.id };
      let result;
      try {
        result = await ctx.runMutation(this.#component.tracing.record, {
          trace: first.trace,
          observations: call.map(({ observation }) => observation),
        });
      } catch {
        this.#fail("enqueue_failed", ids);
        continue;
      }
      if (result.reason === "backlog") this.#fail("backlog", ids);
    }
    return { traceId, observationIds };
  }

  /**
   * Runs one observation through the processing steps in order: ids,
   * defaults, `redact`, content mode, serialization, truncation, usage,
   * validation and size. Returns `null` for a record that is not sent.
   * Throws only with `onError: "throw"`.
   */
  async #prepare(
    init: TraceInit,
    item: ObservationInit & { type: ObservationType },
    ids: Recorded,
  ): Promise<Prepared | null> {
    const { traceId, observationId } = ids;
    const maxFieldBytes =
      this.#options.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
    const problems = new Set<ErrorCode>();

    // 1. Ids. An empty seed or key resolves to "", which fails validation.
    // `redact` cannot change them, so they resolve before it runs.
    const parentId = await tryResolveRef(traceId, item.parent);
    const rootId = await tryResolveRef(
      traceId,
      init.experiment?.rootObservation,
    );

    // 2. Defaults.
    const { key: _key, id: _id, parent: _parent, type, ...fields } = item;
    const startTime = fields.startTime ?? Date.now();
    const endTime =
      type === "event" ? startTime : (fields.endTime ?? startTime);

    // 3. redact on shallow copies of the record, its trace and its
    // observation. Nested values stay the caller's objects.
    const { seed: _seed, traceId: _traceId, ...traceFields } = init;
    const record: ExportRecord = {
      kind: "observation",
      traceId,
      observationId,
      ...(parentId === undefined ? {} : { parentObservationId: parentId }),
      trace: {
        ...traceFields,
        ...(traceFields.experiment
          ? { experiment: { ...traceFields.experiment } }
          : {}),
      },
      observation: { ...fields, type, startTime, endTime },
    };
    let redacted: ExportRecord | null;
    try {
      redacted = this.#options.redact ? this.#options.redact(record) : record;
    } catch {
      this.#fail("redact_failed", ids);
      return null;
    }
    if (redacted === null) return null;
    const { trace: fieldsOfTrace } = redacted;
    let observation = redacted.observation;

    // 4. Content mode. Anything but "full" removes content.
    if (this.#options.content !== "full") {
      const {
        input: _input,
        output: _output,
        statusMessage: _statusMessage,
        ...rest
      } = observation;
      observation = rest;
    }

    // 5. and 6. Serialization and truncation.
    const content = (value: unknown): string | undefined => {
      if (value === undefined) return undefined;
      let text: string | undefined;
      try {
        text =
          typeof value === "string"
            ? value
            : (JSON.stringify(sortedJson(value)) as string | undefined);
      } catch {
        text = undefined;
      }
      if (text === undefined) {
        problems.add("unserializable");
        return undefined;
      }
      return truncate(text, maxFieldBytes);
    };
    // Langfuse drops metadata that is not a JSON object, so the check runs
    // on the converted value.
    const jsonObject = (value: unknown): string | undefined => {
      if (value === undefined) return undefined;
      let json: unknown;
      try {
        json = sortedJson(value);
      } catch {
        problems.add("unserializable");
        return undefined;
      }
      if (typeof json !== "object" || json === null || Array.isArray(json)) {
        problems.add("invalid_metadata");
        return undefined;
      }
      const text = JSON.stringify(json);
      return byteLength(text) > maxFieldBytes ? DROPPED_METADATA : text;
    };

    const { experiment } = fieldsOfTrace;
    // A removed root ref is not exported; a changed one keeps its first id.
    const rootObservationId =
      experiment?.rootObservation === undefined ? undefined : rootId;
    // Tags are sent as given: an array of at most `MAX_TAGS` strings.
    let { tags } = fieldsOfTrace;
    if (
      tags !== undefined &&
      !(
        Array.isArray(tags) &&
        tags.length <= MAX_TAGS &&
        tags.every((tag) => typeof tag === "string")
      )
    ) {
      problems.add("invalid_tags");
      tags = undefined;
    }
    // Every string sent to the component is well-formed UTF-16, and the
    // sizes below are measured on these values.
    const trace: TraceContext = wellFormed({
      traceId,
      name: fieldsOfTrace.name,
      userId: fieldsOfTrace.userId,
      sessionId: fieldsOfTrace.sessionId,
      tags,
      metadata: jsonObject(fieldsOfTrace.metadata),
      environment: fieldsOfTrace.environment,
      release: fieldsOfTrace.release,
      experiment: experiment && {
        id: experiment.id,
        name: experiment.name,
        datasetId: experiment.datasetId,
        itemId: experiment.itemId,
        rootObservationId,
        metadata: jsonObject(experiment.metadata),
      },
    });

    const input = content(observation.input);
    const output = content(observation.output);
    const metadata = jsonObject(observation.metadata);
    const modelParameters = jsonObject(observation.modelParameters);

    // 7. Usage and cost: exactly the entries the encoder exports, under
    // keys Convex accepts. The record sent to the component then holds
    // nothing the encoded span does not, so the span size bounds it.
    const usage = details(
      observation.usage,
      (value) => Number.isSafeInteger(value) && value >= 0,
    );
    if (usage.invalid) problems.add("invalid_usage");
    const cost = details(observation.cost, isCostValue);
    // A cost record whose sum is not finite exports nothing.
    const exported = cost.kept && costDetails(cost.kept) !== undefined;
    if (cost.invalid || (cost.kept && !exported)) problems.add("invalid_cost");
    // Only a generation exports its prompt link, and only a complete one.
    const { prompt } = observation;
    let promptLink: Prompt | undefined;
    if (observation.type === "generation" && prompt !== undefined) {
      if (isPromptLink(prompt)) {
        promptLink = { name: prompt.name, version: prompt.version };
      } else {
        problems.add("invalid_prompt");
      }
    }

    const encoded: Observation = wellFormed({
      id: observationId,
      parentId,
      type: observation.type,
      name: observation.name,
      startTime: observation.startTime ?? startTime,
      endTime:
        observation.type === "event"
          ? (observation.startTime ?? startTime)
          : (observation.endTime ?? endTime),
      completionStartTime: observation.completionStartTime,
      input,
      output,
      metadata,
      level: observation.level,
      statusMessage: observation.statusMessage,
      version: observation.version,
      model: observation.model,
      modelParameters,
      usage: usage.kept,
      cost: exported ? cost.kept : undefined,
      prompt: promptLink,
    });
    for (const code of problems) this.#fail(code, ids);

    // 8. Validation.
    const ownIds = [observationId, parentId, rootObservationId];
    if (
      !isTraceId(traceId) ||
      ownIds.some((value) => value !== undefined && !isObservationId(value))
    ) {
      this.#fail("invalid_id", ids);
      return null;
    }
    if (
      trace.environment !== undefined &&
      !isEnvironmentName(trace.environment)
    ) {
      this.#fail("invalid_environment", ids);
      return null;
    }

    // 9. Size, with the encoder the component uses.
    let bytes: number;
    try {
      bytes = byteLength(encodeSpan(trace, encoded));
    } catch {
      // A time that is not a finite number cannot be encoded.
      this.#fail("unserializable", ids);
      return null;
    }
    if (bytes > MAX_ROW_BYTES) {
      this.#fail("row_too_large", ids);
      return null;
    }
    return {
      trace,
      observation: encoded,
      context: JSON.stringify(trace),
      bytes,
    };
  }
}

/**
 * Splits observations, in order, into component calls: one call holds
 * observations with the same trace context, at most `MAX_CALL_RECORDS` of
 * them and at most `CLIENT_CALL_BYTES` of encoded spans.
 */
function groupCalls(prepared: Prepared[]): Prepared[][] {
  const calls: Prepared[][] = [];
  let call: Prepared[] = [];
  let bytes = 0;
  for (const item of prepared) {
    const first = call[0];
    if (
      first &&
      (first.context !== item.context ||
        call.length === MAX_CALL_RECORDS ||
        bytes + item.bytes > CLIENT_CALL_BYTES)
    ) {
      calls.push(call);
      call = [];
      bytes = 0;
    }
    call.push(item);
    bytes += item.bytes;
  }
  if (call.length > 0) calls.push(call);
  return calls;
}

// Structural ctx types: they accept the mutation and action ctx of any app,
// whose data model is a concrete set of tables and so not assignable to
// `GenericActionCtx<GenericDataModel>` itself.
export type RunQueryCtx = {
  runQuery: GenericActionCtx<GenericDataModel>["runQuery"];
};
export type RunMutationCtx = {
  runMutation: GenericActionCtx<GenericDataModel>["runMutation"];
};
