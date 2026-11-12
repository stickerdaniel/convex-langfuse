// Score writes and the score config sync.
//
// A score op is one outbox row of kind `scoreCreate` or `scoreDelete`. The
// component coalesces the pending ops of one score id and submits them one
// at a time in enqueue order (see `scoreKeys.ts`). Langfuse processes score
// events asynchronously and does not order two operations on one id, so the
// value Langfuse finally stores is not guaranteed and not verified.

import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api.js";
import {
  action,
  env,
  internalAction,
  internalMutation,
  mutation,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server.js";
import {
  API_TIMEOUT_MS,
  CONFIG_FRESH_MS,
  CONFIG_PAGE_LIMIT,
  CONFIG_SYNC_DEADLINE_MS,
  CONFIG_SYNC_LEASE_MS,
  CONFIG_SYNC_MAX_PAGES,
  MAX_SCORE_ID_BYTES,
  MAX_ROW_BYTES,
  MAX_SCORE_DEFINITIONS,
} from "./constants.js";
import { gateClosed, pingExporter } from "./outbox.js";
import { enqueueScoreOp, type ScoreKind } from "./scoreKeys.js";
import { vScoreDataType } from "./schema.js";
import { basicAuth, exportConfig, type ExportConfig } from "./settings.js";
import { isEnvironmentName } from "../shared/ids.js";
import { byteLength } from "../shared/otlp.js";
import { definitionFingerprint, scoreBytes } from "../shared/scores.js";

/** Codes `upsert` and `remove` throw as `ConvexError` data. */
export type ScoreErrorCode =
  | "invalid_score_id"
  | "invalid_score_name"
  | "invalid_score_value"
  | "invalid_timestamp"
  | "invalid_trace_id"
  | "invalid_observation_id"
  | "invalid_metadata"
  | "invalid_environment"
  | "score_too_large";

function refuse(code: ScoreErrorCode): never {
  throw new ConvexError(code);
}

const vEnqueueResult = v.object({
  enqueued: v.boolean(),
  reason: v.optional(v.union(v.literal("disabled"), v.literal("backlog"))),
});
type EnqueueResult = Infer<typeof vEnqueueResult>;

function validateId(id: string): void {
  const bytes = byteLength(id);
  if (bytes < 1 || bytes > MAX_SCORE_ID_BYTES) refuse("invalid_score_id");
}

/** `disabled` or `backlog` when nothing may be enqueued, else `null`. */
async function admission(ctx: MutationCtx): Promise<EnqueueResult | null> {
  if (exportConfig() === null) return { enqueued: false, reason: "disabled" };
  if (await gateClosed(ctx)) return { enqueued: false, reason: "backlog" };
  return null;
}

async function enqueue(
  ctx: MutationCtx,
  kind: ScoreKind,
  id: string,
  data: string,
): Promise<EnqueueResult> {
  await enqueueScoreOp(ctx, kind, id, data, byteLength(data));
  await pingExporter(ctx);
  return { enqueued: true };
}

/** A JSON object string as an object, or a refusal. */
function parseMetadata(metadata: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    refuse("invalid_metadata");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse("invalid_metadata");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Enqueues a score for `POST /api/public/scores`, in the caller's
 * transaction. The request body is encoded once here, with `timestamp` as an
 * ISO string, the default environment from the component env, and the
 * `configId` of a config synced less than `CONFIG_FRESH_MS` ago for the
 * definition whose `fingerprint` (`definitionFingerprint`) the caller
 * passes. Without a fingerprint the score gets no config id. A score op that
 * waits for the same id is replaced.
 *
 * Returns `reason: "disabled"` without writing when the component has no
 * export configuration, and `reason: "backlog"` while the admission gate is
 * closed. Throws a `ConvexError` with a `ScoreErrorCode` for invalid
 * arguments, an invalid environment after the default is applied, and a
 * score whose `scoreBytes` exceed `MAX_ROW_BYTES`. Re-sending a score with
 * the same id, timestamp and value is idempotent in Langfuse.
 */
export const upsert = mutation({
  args: {
    id: v.string(),
    timestamp: v.number(),
    name: v.string(),
    value: v.union(v.number(), v.string()),
    dataType: vScoreDataType,
    traceId: v.string(),
    observationId: v.optional(v.string()),
    comment: v.optional(v.string()),
    /** A JSON object string. */
    metadata: v.optional(v.string()),
    environment: v.optional(v.string()),
    fingerprint: v.optional(v.string()),
  },
  returns: vEnqueueResult,
  handler: async (ctx, args): Promise<EnqueueResult> => {
    const refused = await admission(ctx);
    if (refused) return refused;
    const { id, timestamp, name, value, dataType, traceId, fingerprint } = args;
    validateId(id);
    if (name === "") refuse("invalid_score_name");
    if (traceId === "") refuse("invalid_trace_id");
    if (args.observationId === "") refuse("invalid_observation_id");
    const valid =
      dataType === "CATEGORICAL"
        ? typeof value === "string"
        : dataType === "BOOLEAN"
          ? value === 0 || value === 1
          : typeof value === "number" && Number.isFinite(value);
    if (!valid) refuse("invalid_score_value");
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) refuse("invalid_timestamp");
    // The environment Langfuse files the score under, default included.
    const environment =
      args.environment ?? (env.LANGFUSE_TRACING_ENVIRONMENT || undefined);
    if (environment !== undefined && !isEnvironmentName(environment)) {
      refuse("invalid_environment");
    }
    const metadata =
      args.metadata === undefined ? undefined : parseMetadata(args.metadata);
    // The client's measure, with `metadata` as it is stored. For metadata
    // the client serialized, both strings are equal.
    if (
      scoreBytes({ ...args, metadata: metadata && JSON.stringify(metadata) }) >
      MAX_ROW_BYTES
    ) {
      refuse("score_too_large");
    }

    // A stored fingerprint is always set, so a score without one gets no id.
    const now = Date.now();
    const config = (
      await ctx.db
        .query("scoreConfigs")
        .withIndex("by_name", (q) => q.eq("name", name))
        .take(10)
    ).find(
      (entry) =>
        entry.fingerprint === fingerprint &&
        entry.dataType === dataType &&
        now - entry.syncedAt < CONFIG_FRESH_MS,
    );

    const body = JSON.stringify({
      id,
      timestamp: date.toISOString(),
      name,
      value,
      dataType,
      traceId,
      observationId: args.observationId,
      comment: args.comment,
      metadata,
      environment,
      configId: config?.configId,
    });
    return await enqueue(ctx, "scoreCreate", id, body);
  },
});

/**
 * Enqueues `DELETE /api/public/scores/{id}`, in the caller's transaction,
 * through the same per-id queue as `upsert`: a score op that waits for the
 * same id is replaced. Returns like `upsert`.
 */
export const remove = mutation({
  args: { id: v.string() },
  returns: vEnqueueResult,
  handler: async (ctx, { id }): Promise<EnqueueResult> => {
    const refused = await admission(ctx);
    if (refused) return refused;
    validateId(id);
    return await enqueue(ctx, "scoreDelete", id, "");
  },
});

// ── Score config sync ─────────────────────────────────────────────────────

const vDefinition = v.object({
  name: v.string(),
  dataType: vScoreDataType,
  min: v.optional(v.number()),
  max: v.optional(v.number()),
  categories: v.optional(v.array(v.string())),
});
type Definition = Infer<typeof vDefinition>;

const vSyncResult = v.object({
  status: v.union(
    v.literal("ok"),
    v.literal("running"),
    v.literal("incomplete"),
    v.literal("disabled"),
  ),
  configs: v.array(
    v.object({ name: v.string(), configId: v.string(), created: v.boolean() }),
  ),
  conflicts: v.array(
    v.object({
      name: v.string(),
      configId: v.string(),
      reason: v.union(v.literal("archived"), v.literal("incompatible")),
    }),
  ),
});
export type SyncResult = Infer<typeof vSyncResult>;

const vEntry = v.object({
  name: v.string(),
  configId: v.string(),
  dataType: vScoreDataType,
  fingerprint: v.string(),
});

/** A score config as `GET /api/public/score-configs` returns it. */
type RemoteConfig = {
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
 * Starts a sync: returns its generation and the JSON of its definitions, or
 * `null` while another sync that started less than `CONFIG_SYNC_LEASE_MS`
 * ago runs. With `definitions` it stores them for the hourly resync; without,
 * it reads the stored ones in this transaction, so a resync never runs with
 * definitions older than the last sync call. `null` too without definitions
 * when none are stored.
 */
export const reserve = internalMutation({
  args: { definitions: v.optional(v.string()) },
  returns: v.union(
    v.object({ generation: v.number(), definitions: v.string() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const sync = await ctx.db.query("scoreConfigSync").first();
    if (
      sync?.startedAt !== undefined &&
      now - sync.startedAt < CONFIG_SYNC_LEASE_MS
    ) {
      return null;
    }
    const definitions = args.definitions ?? sync?.definitions;
    if (definitions === undefined) return null;
    const generation = (sync?.generation ?? 0) + 1;
    if (sync) {
      await ctx.db.patch("scoreConfigSync", sync._id, {
        generation,
        startedAt: now,
        definitions,
      });
    } else {
      await ctx.db.insert("scoreConfigSync", {
        generation,
        startedAt: now,
        definitions,
      });
    }
    return { generation, definitions };
  },
});

/**
 * Ends sync `generation`. With `entries`, replaces the `scoreConfigs` rows
 * with them. Does nothing and returns `false` when a newer sync started.
 */
export const finish = internalMutation({
  args: {
    generation: v.number(),
    entries: v.optional(v.array(vEntry)),
    result: v.union(v.literal("ok"), v.literal("incomplete")),
  },
  returns: v.boolean(),
  handler: async (ctx, { generation, entries, result }): Promise<boolean> => {
    const sync = await ctx.db.query("scoreConfigSync").first();
    if (!sync || sync.generation !== generation) return false;
    if (entries) {
      const syncedAt = Date.now();
      const old = await ctx.db
        .query("scoreConfigs")
        .take(MAX_SCORE_DEFINITIONS + 1);
      for (const row of old) await ctx.db.delete("scoreConfigs", row._id);
      for (const entry of entries) {
        await ctx.db.insert("scoreConfigs", { ...entry, syncedAt });
      }
    }
    await ctx.db.patch("scoreConfigSync", sync._id, {
      startedAt: undefined,
      lastResult: result,
    });
    return true;
  },
});

/**
 * Langfuse's rule for a score config name at 4.78.0 (`ScoreConfigNameSchema`):
 * 1 to 80 UTF-16 code units, as zod counts them, of letters, digits, `_`,
 * space, `.`, `(`, `)` and `-`.
 */
function isConfigName(name: string): boolean {
  return (
    name.length >= 1 && name.length <= 80 && /^[\p{L}\p{N}_ .()-]+$/u.test(name)
  );
}

/**
 * Refuses definitions Langfuse would refuse or that cannot be stored as
 * given: `JSON.stringify` turns a bound that is not finite into `null`.
 */
function validateDefinitions(definitions: Definition[]): void {
  const invalid = () => {
    throw new ConvexError("invalid_score_definitions");
  };
  if (definitions.length > MAX_SCORE_DEFINITIONS) invalid();
  const names = new Set<string>();
  for (const { name, dataType, min, max, categories } of definitions) {
    if (!isConfigName(name) || names.has(name)) invalid();
    names.add(name);
    if (dataType === "CATEGORICAL") {
      if (
        !categories?.length ||
        categories.includes("") ||
        new Set(categories).size < categories.length
      ) {
        invalid();
      }
    } else if (categories !== undefined) {
      invalid();
    }
    if (dataType !== "NUMERIC" && (min !== undefined || max !== undefined)) {
      invalid();
    }
    for (const bound of [min, max]) {
      if (bound !== undefined && !Number.isFinite(bound)) invalid();
    }
    if (min !== undefined && max !== undefined && !(min < max)) invalid();
  }
}

/** Whether a remote config fits a definition and may be attached. */
function compatible(definition: Definition, remote: RemoteConfig): boolean {
  if (remote.isArchived || remote.dataType !== definition.dataType) {
    return false;
  }
  if (definition.dataType === "NUMERIC") {
    return (
      (remote.minValue ?? null) === (definition.min ?? null) &&
      (remote.maxValue ?? null) === (definition.max ?? null)
    );
  }
  if (definition.dataType === "CATEGORICAL") {
    const expected = definition.categories ?? [];
    const actual = remote.categories ?? [];
    return (
      actual.length === expected.length &&
      actual.every(
        (category, i) => category.label === expected[i] && category.value === i,
      )
    );
  }
  return true;
}

/** Oldest first, by `createdAt`, then by `id`. */
function byAge(a: RemoteConfig, b: RemoteConfig): number {
  const at = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (at !== 0) return at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function isRemoteConfig(value: unknown): value is RemoteConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.id === "string" &&
    typeof config.name === "string" &&
    typeof config.dataType === "string" &&
    typeof config.isArchived === "boolean" &&
    typeof config.createdAt === "string"
  );
}

/** One JSON request to the public API, `null` on any failure. */
async function fetchJson(
  config: ExportConfig,
  path: string,
  init: { method: "GET" | "POST"; body?: string },
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Authorization: basicAuth(config),
        "Content-Type": "application/json",
      },
    });
    if (response.status < 200 || response.status >= 300) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Every score config of the project, or `null` when a page fails, the pages
 * exceed `CONFIG_SYNC_MAX_PAGES`, or `CONFIG_SYNC_DEADLINE_MS` passes.
 */
async function listConfigs(
  config: ExportConfig,
  startedAt: number,
): Promise<RemoteConfig[] | null> {
  const byId = new Map<string, RemoteConfig>();
  for (let page = 1; ; page++) {
    if (page > CONFIG_SYNC_MAX_PAGES) return null;
    if (Date.now() - startedAt > CONFIG_SYNC_DEADLINE_MS) return null;
    const body = await fetchJson(
      config,
      `/api/public/score-configs?page=${page}&limit=${CONFIG_PAGE_LIMIT}`,
      { method: "GET" },
    );
    if (typeof body !== "object" || body === null) return null;
    const { data, meta } = body as { data?: unknown; meta?: unknown };
    const totalPages = (meta as { totalPages?: unknown } | undefined)
      ?.totalPages;
    if (!Array.isArray(data) || typeof totalPages !== "number") return null;
    if (!data.every(isRemoteConfig)) return null;
    // Offset paging can show a config twice while configs are created.
    for (const remote of data) byId.set(remote.id, remote);
    if (page >= totalPages) return [...byId.values()];
  }
}

/** Creates a config for a definition. Returns its id, or `null`. */
async function createConfig(
  config: ExportConfig,
  { name, dataType, min, max, categories }: Definition,
): Promise<string | null> {
  const body = await fetchJson(config, "/api/public/score-configs", {
    method: "POST",
    body: JSON.stringify({
      name,
      dataType,
      minValue: min,
      maxValue: max,
      categories: categories?.map((label, value) => ({ label, value })),
    }),
  });
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
}

/**
 * The work of sync `generation`, reserved at `startedAt`: lists the configs,
 * reuses or creates one per definition, and stores the result when no newer
 * sync started. A creation starts only before `CONFIG_SYNC_DEADLINE_MS`;
 * after it the run creates nothing more, stores what it has and returns
 * `incomplete`.
 */
async function runSync(
  ctx: ActionCtx,
  config: ExportConfig,
  startedAt: number,
  generation: number,
  definitions: Definition[],
): Promise<SyncResult> {
  const remote = await listConfigs(config, startedAt);
  if (!remote) {
    await ctx.runMutation(internal.scores.finish, {
      generation,
      result: "incomplete",
    });
    return { status: "incomplete", configs: [], conflicts: [] };
  }

  const result: SyncResult = { status: "ok", configs: [], conflicts: [] };
  const entries: Infer<typeof vEntry>[] = [];
  for (const definition of definitions) {
    const named = remote.filter((item) => item.name === definition.name);
    const fitting = named.filter((item) => compatible(definition, item));
    for (const item of named) {
      if (fitting.includes(item)) continue;
      result.conflicts.push({
        name: definition.name,
        configId: item.id,
        reason: item.isArchived ? "archived" : "incompatible",
      });
    }
    const oldest = fitting.sort(byAge)[0];
    const created = oldest === undefined;
    let configId: string | null = oldest?.id ?? null;
    if (created && Date.now() - startedAt <= CONFIG_SYNC_DEADLINE_MS) {
      configId = await createConfig(config, definition);
    }
    if (configId === null) {
      result.status = "incomplete";
      continue;
    }
    result.configs.push({ name: definition.name, configId, created });
    entries.push({
      name: definition.name,
      configId,
      dataType: definition.dataType,
      fingerprint: await definitionFingerprint(definition),
    });
  }

  const applied = await ctx.runMutation(internal.scores.finish, {
    generation,
    entries,
    result: result.status === "ok" ? "ok" : "incomplete",
  });
  if (!applied) result.status = "incomplete";
  return result;
}

/**
 * Makes Langfuse hold a compatible score config for every definition and
 * stores which one each name uses. Single-flight: a call while another sync
 * runs returns `running`. A run that cannot read every page returns
 * `incomplete` and creates and stores nothing. For each definition the
 * oldest compatible config is used, or one is created; archived and
 * incompatible configs of a defined name are returned as `conflicts`. A
 * failed creation, or one the run deadline left out, leaves that name
 * without a config and makes the result `incomplete`. The result is stored
 * only when no newer sync started.
 */
export const syncConfigs = action({
  args: { definitions: v.array(vDefinition) },
  returns: vSyncResult,
  handler: async (ctx, { definitions }): Promise<SyncResult> => {
    const config = exportConfig();
    if (!config) return { status: "disabled", configs: [], conflicts: [] };
    validateDefinitions(definitions);
    const startedAt = Date.now();
    const reserved = await ctx.runMutation(internal.scores.reserve, {
      definitions: JSON.stringify(definitions),
    });
    if (reserved === null) {
      return { status: "running", configs: [], conflicts: [] };
    }
    return await runSync(
      ctx,
      config,
      startedAt,
      reserved.generation,
      definitions,
    );
  },
});

/**
 * The hourly resync: a sync with the definitions of the last sync call,
 * which its reservation reads, so a sync that completed after `resyncTick`
 * scheduled this is not undone with older definitions.
 */
export const resync = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const config = exportConfig();
    if (!config) return null;
    const startedAt = Date.now();
    const reserved = await ctx.runMutation(internal.scores.reserve, {});
    if (reserved === null) return null;
    const definitions = JSON.parse(reserved.definitions) as Definition[];
    await runSync(ctx, config, startedAt, reserved.generation, definitions);
    return null;
  },
});

/**
 * Hourly: schedules `resync`, so archived or changed configs stop being
 * attached. Does nothing when no sync ever ran, while one runs, or when the
 * component is disabled.
 */
export const resyncTick = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (exportConfig() === null) return null;
    const sync = await ctx.db.query("scoreConfigSync").first();
    if (!sync) return null;
    if (
      sync.startedAt !== undefined &&
      Date.now() - sync.startedAt < CONFIG_SYNC_LEASE_MS
    ) {
      return null;
    }
    await ctx.scheduler.runAfter(0, internal.scores.resync, {});
    return null;
  },
});
