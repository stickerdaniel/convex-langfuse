import type {
  FunctionReturnType,
  GenericActionCtx,
  GenericDataModel,
} from "convex/server";
import { ConvexError } from "convex/values";
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
  MAX_DELETE_IDS,
  MAX_DETAIL_KEYS,
  MAX_PROMPT_SCOPE_BYTES,
  MAX_ROW_BYTES,
  MAX_SCORE_ID_BYTES,
  MAX_TAGS,
} from "../shared/limits.js";
import {
  byteLength,
  costDetails,
  encodeSpan,
  hasLoneSurrogate,
  isCostValue,
  promptLink,
} from "../shared/otlp.js";
import { definitionFingerprint, scoreBytes } from "../shared/scores.js";
import type {
  Level,
  Observation,
  ObservationType,
  Prompt as PromptLink,
  TraceContext,
} from "../shared/validators.js";

export { observationIdFromKey, traceIdFromSeed } from "../shared/ids.js";
export type { Level, ObservationType } from "../shared/validators.js";

export type LangfuseOptions<
  S extends ScoreDefinitions | undefined = undefined,
> = {
  /** "full" exports input, output, status messages and score comments. "none" removes them. Required: there is no default. */
  content: "full" | "none";
  /** Sees every record before it leaves the app. Returns the record to export, or null to drop it. */
  redact?: (record: ExportRecord) => ExportRecord | null;
  /** Limit for a serialized input, output or score comment in UTF-8 bytes. Default 131072. */
  maxFieldBytes?: number;
  /** "log" (default) never throws from a recording method. "throw" rethrows. */
  onError?: "log" | "throw";
  /** Score names with their data types, from `defineScores`. They type `score` and are synced by `syncScoreConfigs`. */
  scores?: S;
};

/** The data type of a score name and the values it allows. */
export type ScoreDefinition =
  | { dataType: "BOOLEAN" }
  | { dataType: "NUMERIC"; min?: number; max?: number }
  | { dataType: "CATEGORICAL"; categories: readonly [string, ...string[]] };

export type ScoreDefinitions = Record<string, ScoreDefinition>;

/**
 * Declares score names for the `scores` option, keeping their literal types,
 * so `score` accepts only defined names with values of their type.
 *
 * ```ts
 * const scores = defineScores({
 *   helpful: { dataType: "BOOLEAN" },
 *   rating: { dataType: "NUMERIC", min: 1, max: 5 },
 *   tone: { dataType: "CATEGORICAL", categories: ["formal", "casual"] },
 * });
 * ```
 */
export function defineScores<const D extends ScoreDefinitions>(
  definitions: D,
): D {
  return definitions;
}

/** The value type of a score definition. */
export type ScoreValue<D extends ScoreDefinition> = D extends {
  dataType: "BOOLEAN";
}
  ? boolean
  : D extends { dataType: "NUMERIC" }
    ? number
    : D extends { categories: readonly (infer C)[] }
      ? C
      : never;

/** A score with an `id` needs its `timestamp`, so a re-send overwrites it. */
type ScoreIdentity =
  | { id: string; timestamp: number }
  | { id?: undefined; timestamp?: number };

type ScoreTarget = {
  trace: { seed: string; traceId?: never } | { traceId: string; seed?: never };
  observation?: ObservationRef;
  comment?: string;
  metadata?: Record<string, unknown>;
} & ScoreIdentity;

/**
 * What `score` takes. With definitions, `name` is a defined name and `value`
 * has its type; without, any name with a boolean, number or string value.
 * Times are epoch milliseconds.
 */
export type ScoreInit<S extends ScoreDefinitions | undefined = undefined> =
  (S extends ScoreDefinitions
    ? {
        [N in keyof S & string]: { name: N; value: ScoreValue<S[N]> };
      }[keyof S & string]
    : { name: string; value: boolean | number | string }) &
    ScoreTarget;

/** The result of `syncScoreConfigs`, as `scores.syncConfigs` returns it. */
export type SyncResult = FunctionReturnType<
  ComponentApi["scores"]["syncConfigs"]
>;

/** A chat message as the Langfuse SDKs model it: a message or a placeholder. */
export type ChatMessage =
  | { role: string; content: string }
  | { type: "placeholder"; name: string };

/**
 * A cached prompt. `version` is absent for a fallback. `source` tells where
 * the bytes came from: link an observation to the prompt (`prompt: { name,
 * version }`) only when it is `"langfuse"`. `snapshotId` names the immutable
 * snapshot, so equal ids mean equal bytes.
 */
export type Prompt = {
  name: string;
  version?: number;
  source: "langfuse" | "fallback";
  snapshotId: string;
  /** The prompt's config, parsed from JSON. */
  config: unknown;
} & (
  | { type: "text"; prompt: string }
  | { type: "chat"; prompt: ChatMessage[] }
);

/** What `prompts.pin` stores and pins when the cache holds no prompt. */
export type PromptFallback =
  | { type: "text"; prompt: string; config?: Record<string, unknown> }
  | { type: "chat"; prompt: ChatMessage[]; config?: Record<string, unknown> };

/** A prompt name with a label (default `production`) or a version, not both. */
export type PromptSelector = { name: string } & (
  | { label?: string; version?: never }
  | { version: number; label?: never }
);

/** The result of `prompts.sync`, as the component returns it. */
export type PromptSyncResult = FunctionReturnType<
  ComponentApi["prompts"]["sync"]
>;

/**
 * The component's prompt cache. It holds what Langfuse served and never
 * fetches on a read. The signed webhook refreshes a prompt and the prompts
 * that reference it; a rolling refresh schedules every tracked name again
 * no later than the first 5-minute tick after its last attempt is 13 minutes
 * old, plus 99.8 s. Template compilation is not part of the component:
 * compile `prompt` with the variables of the call site.
 *
 * A name, label or scope with a lone surrogate, and a scope over 256 UTF-8
 * bytes, are refused with a `ConvexError` before the component call:
 * `invalid_prompt_name`, `invalid_prompt_selector` or `invalid_prompt_scope`.
 */
export interface Prompts {
  /**
   * The cached prompt for a label (default `production`) or a version, or
   * `null` on a miss. A version is served as the last refresh resolved it,
   * while a label or a pin still holds that snapshot; a pin on an older
   * resolution of the version does not keep the version readable. From a
   * query, it is reactive: the query reruns when a refresh moves the label.
   * Throws on a label and a version together.
   */
  get(ctx: RunQueryCtx, selector: PromptSelector): Promise<Prompt | null>;
  /**
   * The prompt a scope, such as a conversation, uses for a name. The first
   * call resolves like `get`, stores `fallback` on a miss, and pins the
   * result for `ttlMs` (default 7 days); every later call for the scope and
   * name returns the same bytes until the pin expires, whatever its label,
   * version or fallback. Returns `null` on a miss without a fallback. Runs
   * in the caller's transaction. A scope has at most 256 UTF-8 bytes. A lone
   * surrogate in the fallback's text or config is stored as U+FFFD.
   */
  pin(
    ctx: RunMutationCtx,
    args: PromptSelector & {
      scope: string;
      fallback?: PromptFallback;
      ttlMs?: number;
    },
  ): Promise<Prompt | null>;
  /**
   * Turns the cache on and schedules refreshes: for `names`, or for every
   * prompt of the project. Run it from an action after deploying; the
   * refreshes run in the background. Without it or a webhook delivery, the
   * cache stays empty. A listing that stops at its page cap of 50 pages
   * returns `incomplete`. A name has 1 to 256 UTF-8 bytes;
   * `invalid_prompt_name` refuses another.
   */
  sync(
    ctx: RunActionCtx,
    args?: { names?: string[] },
  ): Promise<PromptSyncResult>;
}

type StoredPrompt = NonNullable<
  FunctionReturnType<ComponentApi["prompts"]["get"]>
>;

/** A prompt as the component stores it, with its JSON parsed. */
function decodePrompt(stored: StoredPrompt): Prompt {
  const { name, version, source, snapshotId } = stored;
  const base = {
    name,
    ...(version === undefined ? {} : { version }),
    source,
    snapshotId,
    config: JSON.parse(stored.config) as unknown,
  };
  return stored.type === "chat"
    ? {
        ...base,
        type: "chat",
        prompt: JSON.parse(stored.prompt) as ChatMessage[],
      }
    : { ...base, type: "text", prompt: stored.prompt };
}

/**
 * Refuses a name, label or scope with a lone surrogate before the component
 * call, which Convex would refuse: a replaced character would name another
 * prompt or scope. Refuses a scope over `MAX_PROMPT_SCOPE_BYTES` too, as the
 * component does.
 */
function checkPromptArgs({
  name,
  label,
  scope,
}: {
  name: string;
  label?: string;
  scope?: string;
}): void {
  if (hasLoneSurrogate(name)) throw new ConvexError("invalid_prompt_name");
  if (label !== undefined && hasLoneSurrogate(label)) {
    throw new ConvexError("invalid_prompt_selector");
  }
  if (
    scope !== undefined &&
    (hasLoneSurrogate(scope) || byteLength(scope) > MAX_PROMPT_SCOPE_BYTES)
  ) {
    throw new ConvexError("invalid_prompt_scope");
  }
}

function promptsOf(component: ComponentApi): Prompts {
  return {
    async get(ctx, { name, label, version }) {
      checkPromptArgs({ name, label });
      const stored = await ctx.runQuery(component.prompts.get, {
        name,
        label,
        version,
      });
      return stored && decodePrompt(stored);
    },
    async pin(ctx, { scope, name, label, version, fallback, ttlMs }) {
      checkPromptArgs({ name, label, scope });
      const stored = await ctx.runMutation(component.prompts.pin, {
        scope,
        name,
        label,
        version,
        ttlMs,
        fallback: fallback && {
          type: fallback.type,
          prompt:
            fallback.type === "chat"
              ? wellFormedJson(fallback.prompt)
              : wellFormed(fallback.prompt),
          config:
            fallback.config === undefined
              ? undefined
              : wellFormedJson(fallback.config),
        },
      });
      return stored && decodePrompt(stored);
    },
    async sync(ctx, args = {}) {
      for (const name of args.names ?? []) checkPromptArgs({ name });
      return await ctx.runAction(component.prompts.sync, args);
    },
  };
}

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
 * What `redact` sees, before serialization: one observation with its trace
 * fields, or one score. Changes to the ids are ignored, and so is a changed
 * `experiment.rootObservation`; a removed one is not exported. A hook returns
 * a record of the kind it got. The record and its trace, observation or score
 * are shallow copies: nested values such as `tags`, `input` or `metadata`
 * are the caller's own objects, so build new ones instead of changing them
 * in place.
 */
export type ExportRecord =
  | {
      kind: "observation";
      traceId: string;
      observationId: string;
      parentObservationId?: string;
      trace: TraceFields;
      observation: ObservationFields & { type: ObservationType };
    }
  | {
      kind: "score";
      traceId: string;
      observationId?: string;
      score: {
        name: string;
        value: boolean | number | string;
        comment?: string;
        metadata?: Record<string, unknown>;
      };
    };

/**
 * Fixed codes a recording or score method logs, or throws as the `Error`
 * message with `onError: "throw"`. A record dropped by `redact` is not
 * logged.
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
  | "invalid_score"
  | "score_too_large"
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
 * A copy with every lone surrogate replaced by U+FFFD, in strings and
 * object keys at any depth. A string cut inside an emoji holds one. Convex
 * refuses an argument with such a string, which would fail the whole
 * component call.
 */
function wellFormed<T>(value: T): T;
function wellFormed(value: unknown): unknown {
  // In Unicode mode a surrogate pair is one code point, so the category
  // "surrogate" matches only the lone ones.
  if (typeof value === "string") return value.replace(/\p{Cs}/gu, "\ufffd");
  if (Array.isArray(value)) return value.map((item) => wellFormed(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        wellFormed(key),
        wellFormed(item),
      ]),
    );
  }
  return value;
}

/**
 * `value` as JSON with every lone surrogate replaced by U+FFFD. Parsing the
 * JSON first applies `toJSON`, and `JSON.stringify` would only escape a
 * lone surrogate, which parses back into one.
 */
function wellFormedJson(value: unknown): string {
  return JSON.stringify(
    wellFormed(JSON.parse(JSON.stringify(value)) as unknown),
  );
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

/**
 * An input, output or comment as text cut to `limit` UTF-8 bytes: a string
 * as it is, anything else as sorted-key JSON. Adds `unserializable` to
 * `problems` and returns `undefined` for a value without a JSON form.
 */
function serializeContent(
  value: unknown,
  limit: number,
  problems: Set<ErrorCode>,
): string | undefined {
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
  return truncate(text, limit);
}

/**
 * A value that converts to a JSON object, as a sorted-key JSON string,
 * replaced by a marker object above `limit` UTF-8 bytes. Langfuse drops
 * metadata that is not a JSON object, so the check runs on the converted
 * value. Adds a code to `problems` and returns `undefined` for anything else.
 */
function serializeObject(
  value: unknown,
  limit: number,
  problems: Set<ErrorCode>,
): string | undefined {
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
  return byteLength(text) > limit ? DROPPED_METADATA : text;
}

/**
 * The score data type and the value to send for a score value: `BOOLEAN` as 1
 * or 0. With a definition, the value must have its type and lie within its
 * range or categories; without, its JS type picks the data type. `null` for
 * a value that does not fit.
 */
function scoreValue(
  value: unknown,
  definition: ScoreDefinition | undefined,
):
  | { dataType: "BOOLEAN" | "NUMERIC"; value: number }
  | { dataType: "CATEGORICAL"; value: string }
  | null {
  const dataType =
    definition?.dataType ??
    (typeof value === "boolean"
      ? "BOOLEAN"
      : typeof value === "number"
        ? "NUMERIC"
        : "CATEGORICAL");
  switch (dataType) {
    case "BOOLEAN":
      return typeof value === "boolean"
        ? { dataType, value: value ? 1 : 0 }
        : null;
    case "NUMERIC": {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      const { min, max } =
        definition?.dataType === "NUMERIC"
          ? definition
          : { min: undefined, max: undefined };
      if (
        (min !== undefined && value < min) ||
        (max !== undefined && value > max)
      ) {
        return null;
      }
      return { dataType, value };
    }
    case "CATEGORICAL":
      // A replaced character would name another category.
      if (typeof value !== "string" || hasLoneSurrogate(value)) return null;
      if (
        definition?.dataType === "CATEGORICAL" &&
        !definition.categories.includes(value)
      ) {
        return null;
      }
      return { dataType, value };
  }
}

/** A score id has 1 to `MAX_SCORE_ID_BYTES` UTF-8 bytes and no lone surrogate. */
function isScoreId(id: string): boolean {
  const bytes = byteLength(id);
  return bytes >= 1 && bytes <= MAX_SCORE_ID_BYTES && !hasLoneSurrogate(id);
}

/** A score definition of the `scores` option as `scores.syncConfigs` takes it. */
function configDefinition(name: string, definition: ScoreDefinition) {
  switch (definition.dataType) {
    case "BOOLEAN":
      return { name, dataType: definition.dataType };
    case "NUMERIC":
      return {
        name,
        dataType: definition.dataType,
        ...(definition.min === undefined ? {} : { min: definition.min }),
        ...(definition.max === undefined ? {} : { max: definition.max }),
      };
    case "CATEGORICAL":
      return {
        name,
        dataType: definition.dataType,
        categories: [...definition.categories],
      };
  }
}

/**
 * The code for a component call that threw. A bad
 * `LANGFUSE_TRACING_ENVIRONMENT` refuses every call without an environment
 * of its own, so that refusal keeps its code.
 */
function callFailure(error: unknown): ErrorCode {
  return error instanceof ConvexError && error.data === "invalid_environment"
    ? "invalid_environment"
    : "enqueue_failed";
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
export class Langfuse<
  const S extends ScoreDefinitions | undefined = undefined,
> {
  readonly #component: ComponentApi;
  readonly #options: LangfuseOptions<S>;
  /** `definitionFingerprint` per defined score name, computed once. */
  readonly #fingerprints = new Map<string, Promise<string>>();
  /** The prompt cache: `get`, `pin` and `sync`. */
  readonly prompts: Prompts;

  constructor(component: ComponentApi, options: LangfuseOptions<S>) {
    this.#component = component;
    this.#options = options;
    this.prompts = promptsOf(component);
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
   * Records a score in the caller's transaction and returns its id, also for
   * a score that was not sent. Without `id`, the id is a new UUID and the
   * timestamp `Date.now()`. A defined score is checked against its
   * definition before the component call; a boolean is sent as 1 or 0.
   * Processing follows the observations: `redact`, content mode (which
   * removes `comment`), serialization of `metadata`. Errors follow `onError`.
   * A defined score carries the fingerprint of its definition, so the
   * component attaches a synced config id only while the config was synced
   * for that definition.
   *
   * The component coalesces pending operations per score id and submits
   * them one at a time in enqueue order; Langfuse does not order two
   * operations on one id, so the value it finally stores is not guaranteed.
   * Keep the app's own record of the score as the source of truth: re-sending
   * the same id, timestamp and value is idempotent.
   */
  async score(
    ctx: RunMutationCtx,
    init: ScoreInit<S>,
  ): Promise<{ scoreId: string }> {
    const scoreId = init.id ?? crypto.randomUUID();
    const timestamp = init.timestamp ?? Date.now();
    const traceId = await resolveTraceId(init.trace).catch(() => "");
    const observationId = await tryResolveRef(traceId, init.observation);
    const ids = { traceId };
    const maxFieldBytes =
      this.#options.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;

    // 1. redact on a shallow copy. Nested values stay the caller's objects.
    const record: ExportRecord = {
      kind: "score",
      traceId,
      ...(observationId === undefined ? {} : { observationId }),
      score: {
        name: init.name,
        value: init.value,
        ...(init.comment === undefined ? {} : { comment: init.comment }),
        ...(init.metadata === undefined ? {} : { metadata: init.metadata }),
      },
    };
    let redacted: ExportRecord | null;
    try {
      redacted = this.#options.redact ? this.#options.redact(record) : record;
    } catch {
      this.#fail("redact_failed", ids);
      return { scoreId };
    }
    if (redacted === null) return { scoreId };
    if (redacted.kind !== "score") {
      this.#fail("redact_failed", ids);
      return { scoreId };
    }
    const { name, value, comment, metadata } = redacted.score;

    // 2. Content mode, 3. serialization and truncation. Every string sent
    // is well-formed UTF-16; the name, the id and a categorical value are
    // refused below instead.
    const problems = new Set<ErrorCode>();
    const args = wellFormed({
      comment:
        this.#options.content === "full"
          ? serializeContent(comment, maxFieldBytes, problems)
          : undefined,
      metadata: serializeObject(metadata, maxFieldBytes, problems),
    });
    for (const code of problems) this.#fail(code, ids);

    // 4. Validation and size.
    if (
      !isTraceId(traceId) ||
      (observationId !== undefined && !isObservationId(observationId))
    ) {
      this.#fail("invalid_id", ids);
      return { scoreId };
    }
    // With definitions, only a defined name is a score.
    const { scores } = this.#options;
    const definition =
      scores && Object.hasOwn(scores, name) ? scores[name] : undefined;
    const typed = scoreValue(value, definition);
    if (
      typed === null ||
      name === "" ||
      hasLoneSurrogate(name) ||
      (scores !== undefined && definition === undefined) ||
      !isScoreId(scoreId) ||
      !Number.isFinite(timestamp)
    ) {
      this.#fail("invalid_score", ids);
      return { scoreId };
    }
    const upsert = {
      id: scoreId,
      timestamp,
      name,
      ...typed,
      traceId,
      ...(observationId === undefined ? {} : { observationId }),
      ...(args.comment === undefined ? {} : { comment: args.comment }),
      ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
    };
    // The component holds the same measure against the same limit.
    if (scoreBytes(upsert) > MAX_ROW_BYTES) {
      this.#fail("score_too_large", ids);
      return { scoreId };
    }
    const fingerprint =
      definition && (await this.#fingerprint(name, definition));

    let result;
    try {
      result = await ctx.runMutation(this.#component.scores.upsert, {
        ...upsert,
        ...(fingerprint === undefined ? {} : { fingerprint }),
      });
    } catch (error) {
      this.#fail(callFailure(error), ids);
      return { scoreId };
    }
    if (result.reason === "backlog") this.#fail("backlog", ids);
    return { scoreId };
  }

  /**
   * Records the deletion of a score in the caller's transaction. It replaces
   * an operation of the same id that waits to be sent. Errors follow
   * `onError`. Langfuse does not order two operations on one id, so a
   * deletion right after a write is not guaranteed to win.
   */
  async deleteScore(
    ctx: RunMutationCtx,
    { id }: { id: string },
  ): Promise<void> {
    const ids = { traceId: "" };
    if (!isScoreId(id)) {
      this.#fail("invalid_score", ids);
      return;
    }
    let result;
    try {
      result = await ctx.runMutation(this.#component.scores.remove, { id });
    } catch {
      this.#fail("enqueue_failed", ids);
      return;
    }
    if (result.reason === "backlog") this.#fail("backlog", ids);
  }

  /**
   * Records requests to delete traces in Langfuse, in the caller's
   * transaction, in requests of up to 100 trace ids, in order. Each request
   * is recorded durably and submitted at least once, after the observations
   * enqueued before it; completed erasure is not verified. Ignores
   * `onError`: on an enabled component every failure throws, so the caller's
   * mutation rolls back. A disabled component returns `enqueued: false` with
   * `reason: "disabled"`; an empty list returns `enqueued: false`.
   */
  async deleteTraces(
    ctx: RunMutationCtx,
    { traces }: { traces: Array<{ seed: string } | { traceId: string }> },
  ): Promise<{ enqueued: boolean; reason?: "disabled" }> {
    const traceIds = await Promise.all(
      traces.map((trace) =>
        "traceId" in trace ? trace.traceId : traceIdFromSeed(trace.seed),
      ),
    );
    if (traceIds.length === 0) return { enqueued: false };
    for (let i = 0; i < traceIds.length; i += MAX_DELETE_IDS) {
      const result = await ctx.runMutation(this.#component.traces.remove, {
        traceIds: traceIds.slice(i, i + MAX_DELETE_IDS),
      });
      if (result.reason === "disabled") {
        return { enqueued: false, reason: "disabled" };
      }
    }
    return { enqueued: true };
  }

  /**
   * Makes Langfuse hold a score config for every name of the `scores`
   * option, creating missing ones, and lets the component attach their ids
   * to scores. Run it from an action after deploying changed definitions;
   * the component repeats it hourly. Throws without `scores`, and throws a
   * `ConvexError` with `invalid_score_definitions` for definitions Langfuse
   * refuses, as the component does, also for a name or category with a lone
   * surrogate, which Convex would refuse as an argument.
   */
  async syncScoreConfigs(ctx: RunActionCtx): Promise<SyncResult> {
    const { scores } = this.#options;
    if (scores === undefined) {
      throw new Error("syncScoreConfigs: the scores option is not set");
    }
    const definitions = Object.entries(scores).map(([name, definition]) =>
      configDefinition(name, definition),
    );
    if (
      definitions.some(({ name, categories = [] }) =>
        [name, ...categories].some(hasLoneSurrogate),
      )
    ) {
      throw new ConvexError("invalid_score_definitions");
    }
    return await ctx.runAction(this.#component.scores.syncConfigs, {
      definitions,
    });
  }

  /**
   * `definitionFingerprint` of the definition of `name`, computed once per
   * client: the definitions of a client do not change.
   */
  #fingerprint(name: string, definition: ScoreDefinition): Promise<string> {
    let fingerprint = this.#fingerprints.get(name);
    if (fingerprint === undefined) {
      fingerprint = definitionFingerprint(configDefinition(name, definition));
      this.#fingerprints.set(name, fingerprint);
    }
    return fingerprint;
  }

  /**
   * Logs `code` with ids only, or throws it with `onError: "throw"`. Never
   * logs field content or error messages, which can carry user data. An id
   * the caller passed is logged only when it is a valid id: an invalid one
   * can be any text. A score line carries the trace id only, because a
   * valid score id can be any text too.
   */
  #fail(code: ErrorCode, ids: Recorded | { traceId: string }): void {
    if (this.#options.onError === "throw") throw new CodeError(code);
    const traceId = isTraceId(ids.traceId) ? ids.traceId : "";
    console.error(
      `[convex-langfuse] ${code}`,
      "observationId" in ids
        ? {
            traceId,
            observationId: isObservationId(ids.observationId)
              ? ids.observationId
              : "",
          }
        : { traceId },
    );
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
      } catch (error) {
        this.#fail(callFailure(error), ids);
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
    if (redacted.kind !== "observation") {
      this.#fail("redact_failed", ids);
      return null;
    }
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
    const content = (value: unknown) =>
      serializeContent(value, maxFieldBytes, problems);
    const jsonObject = (value: unknown) =>
      serializeObject(value, maxFieldBytes, problems);

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
    let link: PromptLink | undefined;
    if (observation.type === "generation" && observation.prompt !== undefined) {
      link = promptLink(observation.prompt);
      if (!link) problems.add("invalid_prompt");
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
      prompt: link,
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
export type RunActionCtx = {
  runAction: GenericActionCtx<GenericDataModel>["runAction"];
};
