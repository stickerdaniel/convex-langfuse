// Prompt cache.
//
// Langfuse resolves a prompt and the prompts it references at request time.
// The cache stores every resolved result as an immutable snapshot and maps
// each label of a tracked prompt name to one. A refresh of a name lists its
// labels, fetches the prompt behind each and applies the results in
// mutations fenced by the name's generation. Refreshes come from the signed
// webhook (`http.ts`), from `sync`, and from a tick that refreshes every
// tracked name at least every `PROMPT_REFRESH_INTERVAL_MS`, which also
// repairs refreshes that failed or never arrived. A pin keeps one snapshot
// per scope and name, so a scope keeps its prompt bytes while labels move.
//
// No prompt function reads or writes the export tables.

import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  action,
  internalAction,
  internalMutation,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import {
  HEALTH_COUNT_CAP,
  MAX_PROMPT_LABELS,
  MAX_PROMPT_NAMES,
  MAX_SNAPSHOT_BYTES,
  PIN_TTL_MS,
  PROMPT_APPLY_BYTES,
  PROMPT_LIST_INTERVAL_MS,
  PROMPT_LIST_MAX_PAGES,
  PROMPT_PAGE_LIMIT,
  PROMPT_REFRESH_INTERVAL_MS,
  PROMPT_TICK_BATCH,
  PROMPT_TIMEOUT_MS,
  RETENTION_BATCH,
  SNAPSHOT_GRACE_MS,
  SNAPSHOT_SCAN_BYTES,
  SNAPSHOT_SCAN_ROWS,
} from "./constants.js";
import { vPromptSource, vPromptType } from "./schema.js";
import { basicAuth, exportConfig, type ExportConfig } from "./settings.js";
import { byteLength } from "../shared/otlp.js";

/** Codes `get`, `pin` and `sync` throw as `ConvexError` data. */
export type PromptErrorCode =
  | "invalid_prompt_selector"
  | "invalid_prompt_name"
  | "invalid_fallback"
  | "invalid_ttl"
  | "prompt_too_large"
  | "prompt_list_failed";

function refuse(code: PromptErrorCode): never {
  throw new ConvexError(code);
}

// ── Snapshots ──────────────────────────────────────────────────────────────

/** What a snapshot holds besides its key and fetch time. */
type Content = Omit<
  Doc<"promptSnapshots">,
  "_id" | "_creationTime" | "key" | "fetchedAt"
>;

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** The snapshot key: equal for equal content and provenance only. */
async function snapshotKey(content: Content): Promise<string> {
  const { name, source, version, type, prompt, config, resolutionGraph } =
    content;
  return await sha256Hex(
    JSON.stringify([
      name,
      source,
      version ?? null,
      type,
      prompt,
      config,
      resolutionGraph ?? null,
    ]),
  );
}

/** Summed UTF-8 bytes of the prompt, the config and the resolution graph. */
function contentBytes(
  content: Pick<Content, "prompt" | "config" | "resolutionGraph">,
): number {
  return (
    byteLength(content.prompt) +
    byteLength(content.config) +
    byteLength(content.resolutionGraph ?? "")
  );
}

/** The snapshot with this content, inserted when no equal one exists. */
async function storeSnapshot(
  ctx: MutationCtx,
  content: Content,
): Promise<Doc<"promptSnapshots">> {
  const key = await snapshotKey(content);
  const existing = await ctx.db
    .query("promptSnapshots")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  if (existing) return existing;
  const id = await ctx.db.insert("promptSnapshots", {
    key,
    ...content,
    fetchedAt: Date.now(),
  });
  return (await ctx.db.get("promptSnapshots", id))!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([key, item]) => [key, sortKeys(item)]),
  );
}

/** JSON with object keys sorted at every depth, so equal values give equal strings. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

type GraphNode = { name?: unknown; version?: unknown };

function byNameThenVersion(a: GraphNode, b: GraphNode): number {
  return (
    compareStrings(String(a.name), String(b.name)) ||
    Number(a.version) - Number(b.version)
  );
}

/**
 * A resolution graph `{ root, dependencies: { [parentId]: node[] } }` as
 * canonical JSON: every dependency list sorted by name, then version, and
 * object keys sorted. The same graph in another order gives the same string.
 */
function canonicalGraph(graph: Record<string, unknown>): string {
  const { dependencies } = graph;
  return canonicalJson({
    ...graph,
    dependencies: isRecord(dependencies)
      ? Object.fromEntries(
          Object.entries(dependencies).map(([parent, nodes]) => [
            parent,
            Array.isArray(nodes)
              ? [...(nodes as GraphNode[])].sort(byNameThenVersion)
              : nodes,
          ]),
        )
      : dependencies,
  });
}

/** Every prompt name a resolution graph mentions other than `name`. */
function graphNames(graph: Record<string, unknown>, name: string): string[] {
  const names = new Set<string>();
  const { dependencies } = graph;
  if (isRecord(dependencies)) {
    for (const nodes of Object.values(dependencies)) {
      if (!Array.isArray(nodes)) continue;
      for (const node of nodes as GraphNode[]) {
        if (typeof node?.name === "string") names.add(node.name);
      }
    }
  }
  names.delete(name);
  return [...names];
}

// ── Reads ──────────────────────────────────────────────────────────────────

const vPrompt = v.object({
  name: v.string(),
  version: v.optional(v.number()),
  type: vPromptType,
  /** The text, or JSON of the chat message array. */
  prompt: v.string(),
  /** JSON. */
  config: v.string(),
  source: vPromptSource,
  snapshotId: v.id("promptSnapshots"),
});
export type Prompt = Infer<typeof vPrompt>;

function toPrompt(snapshot: Doc<"promptSnapshots">): Prompt {
  const { name, version, type, prompt, config, source, _id } = snapshot;
  return {
    name,
    ...(version === undefined ? {} : { version }),
    type,
    prompt,
    config,
    source,
    snapshotId: _id,
  };
}

const selectorArgs = {
  name: v.string(),
  /** Default `production`. */
  label: v.optional(v.string()),
  version: v.optional(v.number()),
};
type Selector = { name: string; label?: string; version?: number };

function checkSelector({ label, version }: Selector): void {
  if (label !== undefined && version !== undefined) {
    refuse("invalid_prompt_selector");
  }
}

async function labelRow(
  ctx: QueryCtx,
  name: string,
  label: string,
): Promise<Doc<"promptLabels"> | null> {
  return await ctx.db
    .query("promptLabels")
    .withIndex("by_name_label", (q) => q.eq("name", name).eq("label", label))
    .unique();
}

async function nameRow(
  ctx: QueryCtx,
  name: string,
): Promise<Doc<"promptNames"> | null> {
  return await ctx.db
    .query("promptNames")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
}

/**
 * The cached snapshot for a selector: the one a label maps to, or the
 * newest Langfuse snapshot of a version. `null` on a miss.
 */
async function resolve(
  ctx: QueryCtx,
  selector: Selector,
): Promise<Doc<"promptSnapshots"> | null> {
  checkSelector(selector);
  const { name, version } = selector;
  if (version !== undefined) {
    // Fallback snapshots have no version, so this finds Langfuse ones only.
    return await ctx.db
      .query("promptSnapshots")
      .withIndex("by_name_version", (q) =>
        q.eq("name", name).eq("version", version),
      )
      .order("desc")
      .first();
  }
  const row = await labelRow(ctx, name, selector.label ?? "production");
  return row && (await ctx.db.get("promptSnapshots", row.snapshotId));
}

/**
 * The cached prompt for a label (default `production`) or a version, or
 * `null` when the cache holds none. Reads only the cache; a miss starts no
 * fetch. Throws `invalid_prompt_selector` for a label and a version
 * together.
 */
export const get = query({
  args: selectorArgs,
  returns: v.union(vPrompt, v.null()),
  handler: async (ctx, selector): Promise<Prompt | null> => {
    const snapshot = await resolve(ctx, selector);
    return snapshot && toPrompt(snapshot);
  },
});

/**
 * Stores a fallback as a snapshot with `source: "fallback"`, or reuses an
 * equal one. A chat fallback is a JSON message array, its config a JSON
 * value; both are stored as canonical JSON.
 */
async function storeFallback(
  ctx: MutationCtx,
  name: string,
  fallback: { type: "text" | "chat"; prompt: string; config?: string },
): Promise<Doc<"promptSnapshots">> {
  let prompt = fallback.prompt;
  let config: string;
  try {
    if (fallback.type === "chat") {
      const messages: unknown = JSON.parse(prompt);
      if (!Array.isArray(messages) || !messages.every(isRecord)) {
        refuse("invalid_fallback");
      }
      prompt = canonicalJson(messages);
    }
    config = canonicalJson(JSON.parse(fallback.config ?? "{}"));
  } catch (error) {
    if (error instanceof ConvexError) throw error;
    refuse("invalid_fallback");
  }
  if (contentBytes({ prompt, config }) > MAX_SNAPSHOT_BYTES) {
    refuse("prompt_too_large");
  }
  return await storeSnapshot(ctx, {
    name,
    source: "fallback",
    type: fallback.type,
    prompt,
    config,
  });
}

/**
 * The prompt a scope uses for a name. A pin of the scope and name that has
 * not expired returns its snapshot unchanged, whatever the label, version
 * and fallback of this call. Otherwise it resolves like `get`; on a miss it
 * stores `fallback` as a snapshot, and without a fallback it returns `null`
 * and stores nothing. The result is pinned for `ttlMs` (default
 * `PIN_TTL_MS`) from now. Runs in the caller's transaction.
 */
export const pin = mutation({
  args: {
    scope: v.string(),
    ...selectorArgs,
    fallback: v.optional(
      v.object({
        type: vPromptType,
        /** The text, or JSON of the chat message array. */
        prompt: v.string(),
        /** JSON, default `{}`. */
        config: v.optional(v.string()),
      }),
    ),
    ttlMs: v.optional(v.number()),
  },
  returns: v.union(vPrompt, v.null()),
  handler: async (ctx, args): Promise<Prompt | null> => {
    checkSelector(args);
    const { scope, name, fallback, ttlMs = PIN_TTL_MS } = args;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) refuse("invalid_ttl");
    const now = Date.now();
    const existing = await ctx.db
      .query("promptPins")
      .withIndex("by_scope_name", (q) => q.eq("scope", scope).eq("name", name))
      .unique();
    if (existing && existing.expiresAt > now) {
      const pinned = await ctx.db.get("promptSnapshots", existing.snapshotId);
      if (pinned) return toPrompt(pinned);
    }
    const snapshot =
      (await resolve(ctx, args)) ??
      (fallback ? await storeFallback(ctx, name, fallback) : null);
    if (!snapshot) return null;
    const pinned = { snapshotId: snapshot._id, expiresAt: now + ttlMs };
    if (existing) {
      await ctx.db.patch("promptPins", existing._id, pinned);
    } else {
      await ctx.db.insert("promptPins", { scope, name, ...pinned });
    }
    return toPrompt(snapshot);
  },
});

// ── Refresh ────────────────────────────────────────────────────────────────

/**
 * The next generation of a name. Generations grow with the clock, so a
 * refresh reserved for a deleted row cannot match a later row of the same
 * name.
 */
function nextGeneration(previous: number, now: number): number {
  return Math.max(previous + 1, now);
}

/**
 * Reserves a refresh for each distinct name: creates its `promptNames` row
 * when missing, raises its generation and sets `attemptedAt`. A missing name
 * finds no row once `MAX_PROMPT_NAMES` are tracked and counts as overflow.
 * With `onlyNew`, tracked names are skipped.
 */
async function reserveNames(
  ctx: MutationCtx,
  names: string[],
  { onlyNew = false }: { onlyNew?: boolean } = {},
): Promise<{
  reserved: { name: string; generation: number }[];
  overflow: number;
}> {
  const now = Date.now();
  const reserved: { name: string; generation: number }[] = [];
  let overflow = 0;
  let free: number | undefined;
  for (const name of new Set(names)) {
    const row = await nameRow(ctx, name);
    if (row) {
      if (onlyNew) continue;
      const generation = nextGeneration(row.generation, now);
      await ctx.db.patch("promptNames", row._id, {
        generation,
        attemptedAt: now,
      });
      reserved.push({ name, generation });
      continue;
    }
    free ??=
      MAX_PROMPT_NAMES -
      (await ctx.db.query("promptNames").take(MAX_PROMPT_NAMES)).length;
    if (free <= 0) {
      overflow += 1;
      continue;
    }
    free -= 1;
    const generation = nextGeneration(0, now);
    await ctx.db.insert("promptNames", {
      name,
      generation,
      dependsOn: [],
      attemptedAt: now,
    });
    reserved.push({ name, generation });
  }
  return { reserved, overflow };
}

/**
 * Reserves a refresh for each name and schedules it. Returns how many names
 * it scheduled and how many found no free slot.
 */
async function requestRefresh(
  ctx: MutationCtx,
  names: string[],
  options: { onlyNew?: boolean } = {},
): Promise<{ tracked: number; overflow: number }> {
  const { reserved, overflow } = await reserveNames(ctx, names, options);
  for (const { name, generation } of reserved) {
    await ctx.scheduler.runAfter(0, internal.prompts.refresh, {
      name,
      generation,
    });
  }
  return { tracked: reserved.length, overflow };
}

/**
 * Reserves a refresh for each name, as `requestRefresh` does, without
 * scheduling it. Returns the generation per name, `null` for a name that is
 * not tracked and finds no free slot.
 */
export const reserve = internalMutation({
  args: { names: v.array(v.string()) },
  returns: v.array(v.union(v.number(), v.null())),
  handler: async (ctx, { names }) => {
    const { reserved } = await reserveNames(ctx, names);
    const generations = new Map(
      reserved.map(({ name, generation }) => [name, generation]),
    );
    return names.map((name) => generations.get(name) ?? null);
  },
});

const vCount = v.object({ tracked: v.number(), overflow: v.number() });

async function getOrCreateSync(ctx: MutationCtx): Promise<Doc<"promptSync">> {
  const existing = await ctx.db.query("promptSync").first();
  if (existing) return existing;
  const id = await ctx.db.insert("promptSync", {});
  return (await ctx.db.get("promptSync", id))!;
}

/**
 * `requestRefresh` in a mutation of its own, for `sync` and `list`. With
 * `start`, it creates the `promptSync` row, which turns the tick on.
 */
export const request = internalMutation({
  args: {
    names: v.array(v.string()),
    onlyNew: v.optional(v.boolean()),
    start: v.optional(v.boolean()),
  },
  returns: vCount,
  handler: async (ctx, { names, onlyNew, start }) => {
    if (start) await getOrCreateSync(ctx);
    return await requestRefresh(ctx, names, { onlyNew });
  },
});

/** A JSON response, or a fixed code for what went wrong. */
type Fetched =
  | { ok: true; body: unknown }
  | { ok: false; status?: number; error: string };

/** One GET request to the public API, with Basic auth and a timeout. */
async function getJson(config: ExportConfig, path: string): Promise<Fetched> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROMPT_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { Authorization: basicAuth(config) },
    });
    if (response.status !== 200) {
      return {
        ok: false,
        status: response.status,
        error: `http_${response.status}`,
      };
    }
    try {
      return { ok: true, body: (await response.json()) as unknown };
    } catch {
      return { ok: false, error: "invalid_response" };
    }
  } catch {
    return {
      ok: false,
      error: controller.signal.aborted ? "timeout" : "network",
    };
  } finally {
    clearTimeout(timeout);
  }
}

const vCandidate = v.object({
  version: v.number(),
  type: vPromptType,
  prompt: v.string(),
  config: v.string(),
  resolutionGraph: v.optional(v.string()),
});
type Candidate = Infer<typeof vCandidate>;

/**
 * What a refresh learned about one label: `ok` points it to a snapshot of
 * the candidate, `gone` removes it, `failed` keeps its mapping.
 */
const vLabelResult = v.union(
  v.object({
    label: v.string(),
    outcome: v.literal("ok"),
    candidate: vCandidate,
  }),
  v.object({ label: v.string(), outcome: v.literal("gone") }),
  v.object({ label: v.string(), outcome: v.literal("failed") }),
);
type LabelResult = Infer<typeof vLabelResult>;

/** The end of a refresh, applied with the last batch of label results. */
const vDone = v.object({
  /** Every label of the name, or `null` when the listing failed. */
  listed: v.union(v.array(v.string()), v.null()),
  /** Other prompt names in the resolution graphs of the fetched labels. */
  dependsOn: v.array(v.string()),
  /** A label kept its old mapping, so `dependsOn` adds to the old one. */
  partial: v.boolean(),
  error: v.optional(v.string()),
});
type Done = Infer<typeof vDone>;

/** The candidate in a `GET /api/public/v2/prompts/{name}` body, or `null`. */
function parsePrompt(
  name: string,
  body: unknown,
): { candidate: Candidate; dependsOn: string[] } | null {
  if (!isRecord(body) || body.name !== name) return null;
  const { version, type, prompt, config, resolutionGraph } = body;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    return null;
  }
  let text: string;
  if (type === "text" && typeof prompt === "string") {
    text = prompt;
  } else if (
    type === "chat" &&
    Array.isArray(prompt) &&
    prompt.every(isRecord)
  ) {
    text = canonicalJson(prompt);
  } else {
    return null;
  }
  const graph = resolutionGraph ?? null;
  if (graph !== null && !isRecord(graph)) return null;
  return {
    candidate: {
      version,
      type,
      prompt: text,
      config: canonicalJson(config ?? {}),
      ...(graph === null ? {} : { resolutionGraph: canonicalGraph(graph) }),
    },
    dependsOn: graph === null ? [] : graphNames(graph, name),
  };
}

/** The labels of `name` in a `GET /api/public/v2/prompts?name=` body, or `null`. */
function parseListing(name: string, body: unknown): string[] | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  const entry: unknown = body.data.find(
    (item: unknown) => isRecord(item) && item.name === name,
  );
  // No entry: the prompt does not exist, so none of its labels do.
  if (entry === undefined) return [];
  const labels = (entry as Record<string, unknown>).labels;
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string")) {
    return null;
  }
  return labels as string[];
}

function promptPath(name: string): string {
  return `/api/public/v2/prompts/${encodeURIComponent(name)}`;
}

/**
 * Lists `name`, fetches the resolved prompt behind each of its labels, at
 * most `MAX_PROMPT_LABELS`, and returns the per-label results and the end of
 * the refresh. Errors are fixed codes: `http_<status>`, `network`,
 * `timeout`, `invalid_response`, `oversize`, `too_many_labels`.
 */
async function fetchName(
  config: ExportConfig,
  name: string,
): Promise<{ labels: LabelResult[]; done: Done }> {
  const listing = await getJson(
    config,
    `/api/public/v2/prompts?name=${encodeURIComponent(name)}&page=1&limit=1`,
  );
  const listed = listing.ok ? parseListing(name, listing.body) : null;
  if (listed === null) {
    const error = listing.ok ? "invalid_response" : listing.error;
    return {
      labels: [],
      done: { listed: null, dependsOn: [], partial: true, error },
    };
  }
  const distinct = [...new Set(listed)].sort();
  const kept = distinct.slice(0, MAX_PROMPT_LABELS);
  const fetched = await Promise.all(
    kept.map(async (label) => await fetchLabel(config, name, label)),
  );
  const errors = fetched.flatMap(({ error }) => error ?? []);
  if (kept.length < distinct.length) errors.unshift("too_many_labels");
  return {
    labels: fetched.map(({ result }) => result),
    done: {
      listed: kept,
      dependsOn: [
        ...new Set(fetched.flatMap(({ dependsOn }) => dependsOn)),
      ].sort(),
      partial: fetched.some(({ result }) => result.outcome === "failed"),
      error: errors[0],
    },
  };
}

/** Fetches the resolved prompt behind one label of `name`. */
async function fetchLabel(
  config: ExportConfig,
  name: string,
  label: string,
): Promise<{ result: LabelResult; error?: string; dependsOn: string[] }> {
  const fetched = await getJson(
    config,
    `${promptPath(name)}?label=${encodeURIComponent(label)}`,
  );
  if (!fetched.ok) {
    // 404: the prompt or the label is gone; 409: a dependency is.
    const gone = fetched.status === 404 || fetched.status === 409;
    return {
      result: { label, outcome: gone ? "gone" : "failed" },
      error: fetched.error,
      dependsOn: [],
    };
  }
  const parsed = parsePrompt(name, fetched.body);
  if (!parsed) {
    return {
      result: { label, outcome: "failed" },
      error: "invalid_response",
      dependsOn: [],
    };
  }
  if (contentBytes(parsed.candidate) > MAX_SNAPSHOT_BYTES) {
    return {
      result: { label, outcome: "gone" },
      error: "oversize",
      dependsOn: [],
    };
  }
  return {
    result: { label, outcome: "ok", candidate: parsed.candidate },
    dependsOn: parsed.dependsOn,
  };
}

/** Label results in order, in batches of at most `PROMPT_APPLY_BYTES` of candidates. */
function batches(labels: LabelResult[]): LabelResult[][] {
  const result: LabelResult[][] = [[]];
  let bytes = 0;
  for (const label of labels) {
    const size = label.outcome === "ok" ? contentBytes(label.candidate) : 0;
    if (bytes + size > PROMPT_APPLY_BYTES && result.at(-1)!.length > 0) {
      result.push([]);
      bytes = 0;
    }
    result.at(-1)!.push(label);
    bytes += size;
  }
  return result;
}

/**
 * Refreshes one name for generation `generation`: lists its labels, fetches
 * the resolved prompt behind each, and passes the results to `apply` in
 * batches, the last one with the end of the refresh. Stops once `apply`
 * reports a newer generation. Does nothing when the component is disabled.
 */
export const refresh = internalAction({
  args: { name: v.string(), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, { name, generation }) => {
    const config = exportConfig();
    if (!config) return null;
    const { labels, done } = await fetchName(config, name);
    const parts = batches(labels);
    for (const [i, part] of parts.entries()) {
      const current = await ctx.runMutation(internal.prompts.apply, {
        name,
        generation,
        labels: part,
        ...(i === parts.length - 1 ? { done } : {}),
      });
      if (!current) break;
    }
    return null;
  },
});

/**
 * Applies label results of refresh `generation` of `name`; returns `false`
 * and changes nothing when the generation is not current. `ok` points the
 * label to the snapshot of its candidate, inserted or reused; `gone` removes
 * the label; `failed` keeps its mapping. With `done`, it also removes the
 * labels the listing no longer shows (all of them when the prompt is gone,
 * none when the listing failed), records the first error, and sets
 * `refreshedAt` and `dependsOn`. A name without labels and without an error
 * is no longer tracked.
 */
export const apply = internalMutation({
  args: {
    name: v.string(),
    generation: v.number(),
    labels: v.array(vLabelResult),
    done: v.optional(vDone),
  },
  returns: v.boolean(),
  handler: async (ctx, { name, generation, labels, done }) => {
    const row = await nameRow(ctx, name);
    if (!row || row.generation !== generation) return false;
    for (const result of labels) {
      const existing = await labelRow(ctx, name, result.label);
      if (result.outcome === "ok") {
        const { _id: snapshotId } = await storeSnapshot(ctx, {
          name,
          source: "langfuse",
          ...result.candidate,
        });
        if (!existing) {
          await ctx.db.insert("promptLabels", {
            name,
            label: result.label,
            snapshotId,
          });
        } else if (existing.snapshotId !== snapshotId) {
          await ctx.db.patch("promptLabels", existing._id, { snapshotId });
        }
      } else if (result.outcome === "gone" && existing) {
        await ctx.db.delete("promptLabels", existing._id);
      }
    }
    if (!done) return true;

    const current = await ctx.db
      .query("promptLabels")
      .withIndex("by_name_label", (q) => q.eq("name", name))
      .take(2 * MAX_PROMPT_LABELS);
    let left = current.length;
    if (done.listed !== null) {
      const listed = new Set(done.listed);
      for (const label of current) {
        if (listed.has(label.label)) continue;
        await ctx.db.delete("promptLabels", label._id);
        left -= 1;
      }
    }
    if (left === 0 && done.error === undefined) {
      await ctx.db.delete("promptNames", row._id);
      return true;
    }
    const dependsOn = done.partial
      ? [...new Set([...row.dependsOn, ...done.dependsOn])].sort()
      : done.dependsOn;
    await ctx.db.patch("promptNames", row._id, {
      refreshedAt: Date.now(),
      dependsOn,
      error: done.error,
    });
    return true;
  },
});

// ── Triggers ───────────────────────────────────────────────────────────────

/**
 * Every 5 minutes: requests a refresh for up to `PROMPT_TICK_BATCH` tracked
 * names whose last attempt is at least `PROMPT_REFRESH_INTERVAL_MS` old,
 * oldest first, and schedules `list` once the last listing is
 * `PROMPT_LIST_INTERVAL_MS` old. Writes and schedules nothing before the
 * first `sync` or webhook created `promptSync`, or while the component is
 * disabled.
 */
export const tick = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const sync = await ctx.db.query("promptSync").first();
    if (!sync || exportConfig() === null) return null;
    const now = Date.now();
    const due = await ctx.db
      .query("promptNames")
      .withIndex("by_attemptedAt", (q) =>
        q.lte("attemptedAt", now - PROMPT_REFRESH_INTERVAL_MS),
      )
      .take(PROMPT_TICK_BATCH);
    await requestRefresh(
      ctx,
      due.map((row) => row.name),
    );
    if (
      sync.lastListAt === undefined ||
      now - sync.lastListAt >= PROMPT_LIST_INTERVAL_MS
    ) {
      await ctx.scheduler.runAfter(0, internal.prompts.list, {});
    }
    return null;
  },
});

/** Sets `lastListAt` after a listing read every page. */
export const listed = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const sync = await getOrCreateSync(ctx);
    await ctx.db.patch("promptSync", sync._id, { lastListAt: Date.now() });
    return null;
  },
});

/**
 * Pages through every prompt name of the project, at most
 * `PROMPT_LIST_MAX_PAGES` pages, and requests a refresh for the names of
 * each page; with `onlyNew`, only for names that are not tracked. Sets
 * `lastListAt` when it read every page. Returns the summed counts, or `null`
 * when a page failed.
 */
async function listAndRequest(
  ctx: ActionCtx,
  config: ExportConfig,
  onlyNew: boolean,
): Promise<{ tracked: number; overflow: number } | null> {
  const total = { tracked: 0, overflow: 0 };
  for (let page = 1; page <= PROMPT_LIST_MAX_PAGES; page++) {
    const fetched = await getJson(
      config,
      `/api/public/v2/prompts?page=${page}&limit=${PROMPT_PAGE_LIMIT}`,
    );
    if (!fetched.ok || !isRecord(fetched.body)) return null;
    const { data, meta } = fetched.body;
    const totalPages = isRecord(meta) ? meta.totalPages : undefined;
    if (!Array.isArray(data) || typeof totalPages !== "number") return null;
    const names = data
      .map((item: unknown) => (isRecord(item) ? item.name : undefined))
      .filter(
        (name): name is string => typeof name === "string" && name !== "",
      );
    const counts = await ctx.runMutation(internal.prompts.request, {
      names,
      onlyNew,
    });
    total.tracked += counts.tracked;
    total.overflow += counts.overflow;
    if (page >= totalPages) {
      await ctx.runMutation(internal.prompts.listed, {});
      return total;
    }
  }
  return total;
}

/**
 * Hourly from the tick: starts tracking prompt names the cache does not
 * know yet. A failed listing is repeated by the next tick.
 */
export const list = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const config = exportConfig();
    if (config) await listAndRequest(ctx, config, true);
    return null;
  },
});

const vSyncResult = v.object({
  status: v.union(v.literal("ok"), v.literal("disabled")),
  /** Names a refresh was scheduled for. */
  tracked: v.number(),
  /** Names not tracked because `MAX_PROMPT_NAMES` are. */
  overflow: v.number(),
});
export type SyncResult = Infer<typeof vSyncResult>;

/**
 * Turns the prompt cache on and schedules refreshes. With `names`, for those
 * names; without, for every name the list endpoint returns. Refreshes run in
 * the background and apply within seconds. Returns `disabled` without
 * writing when the component has no export configuration. Throws
 * `prompt_list_failed` when a page of the listing fails and
 * `invalid_prompt_name` for an empty name.
 */
export const sync = action({
  args: { names: v.optional(v.array(v.string())) },
  returns: vSyncResult,
  handler: async (ctx, { names }): Promise<SyncResult> => {
    const config = exportConfig();
    if (!config) return { status: "disabled", tracked: 0, overflow: 0 };
    if (names?.some((name) => name === "")) refuse("invalid_prompt_name");
    const counts = await ctx.runMutation(internal.prompts.request, {
      names: names ?? [],
      start: true,
    });
    if (names) return { status: "ok", ...counts };
    const listedCounts = await listAndRequest(ctx, config, false);
    if (!listedCounts) refuse("prompt_list_failed");
    return { status: "ok", ...listedCounts };
  },
});

/**
 * A verified webhook delivery for prompt `name`: records `lastWebhookAt`,
 * creating `promptSync`, and requests a refresh for the name and for every
 * tracked name whose resolution graphs reference it. A replayed delivery
 * causes one more refresh, which reuses the existing snapshots.
 */
export const webhook = internalMutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, { name }) => {
    const sync = await getOrCreateSync(ctx);
    await ctx.db.patch("promptSync", sync._id, { lastWebhookAt: Date.now() });
    if (exportConfig() === null) return null;
    const dependents = (
      await ctx.db.query("promptNames").take(MAX_PROMPT_NAMES)
    )
      .filter((row) => row.dependsOn.includes(name))
      .map((row) => row.name);
    await requestRefresh(ctx, [name, ...dependents]);
    return null;
  },
});

// ── Health and retention ───────────────────────────────────────────────────

export const vPromptHealth = v.object({
  tracked: v.number(),
  lastListAt: v.optional(v.number()),
  lastWebhookAt: v.optional(v.number()),
  /** The oldest `attemptedAt` of a tracked name. */
  oldestAttemptAt: v.optional(v.number()),
  /** Tracked names whose last refresh recorded an error, capped. */
  errors: v.number(),
});

/** The prompt part of `outbox.health`. */
export async function promptHealth(
  ctx: QueryCtx,
): Promise<Infer<typeof vPromptHealth>> {
  const sync = await ctx.db.query("promptSync").first();
  const names = await ctx.db.query("promptNames").take(HEALTH_COUNT_CAP);
  const oldest = await ctx.db
    .query("promptNames")
    .withIndex("by_attemptedAt")
    .first();
  return {
    tracked: names.length,
    lastListAt: sync?.lastListAt,
    lastWebhookAt: sync?.lastWebhookAt,
    oldestAttemptAt: oldest?.attemptedAt,
    errors: names.filter((row) => row.error !== undefined).length,
  };
}

/** Deletes up to `RETENTION_BATCH` expired pins; returns how many. */
export async function deleteExpiredPins(
  ctx: MutationCtx,
  now: number,
): Promise<number> {
  const expired = await ctx.db
    .query("promptPins")
    .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
    .take(RETENTION_BATCH);
  for (const row of expired) await ctx.db.delete("promptPins", row._id);
  return expired.length;
}

async function referenced(
  ctx: QueryCtx,
  snapshotId: Id<"promptSnapshots">,
): Promise<boolean> {
  return (
    (await ctx.db
      .query("promptLabels")
      .withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId))
      .first()) !== null ||
    (await ctx.db
      .query("promptPins")
      .withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId))
      .first()) !== null
  );
}

/**
 * Deletes snapshots fetched more than `SNAPSHOT_GRACE_MS` ago that no label
 * and no pin references, oldest first, starting at `fetchedAt >= from`. It
 * reads at most `SNAPSHOT_SCAN_ROWS` snapshots and about
 * `SNAPSHOT_SCAN_BYTES`, and deletes at most `RETENTION_BATCH`. Returns the
 * `fetchedAt` to continue from, or `undefined` once the scan reached the
 * end.
 */
export async function collectSnapshots(
  ctx: MutationCtx,
  now: number,
  from: number | undefined,
): Promise<number | undefined> {
  const cutoff = now - SNAPSHOT_GRACE_MS;
  const scan = ctx.db
    .query("promptSnapshots")
    .withIndex("by_fetchedAt", (q) =>
      from === undefined
        ? q.lt("fetchedAt", cutoff)
        : q.gte("fetchedAt", from).lt("fetchedAt", cutoff),
    );
  const unreferenced: Id<"promptSnapshots">[] = [];
  let rows = 0;
  let bytes = 0;
  let next: number | undefined;
  for await (const snapshot of scan) {
    if (
      unreferenced.length === RETENTION_BATCH ||
      rows === SNAPSHOT_SCAN_ROWS ||
      bytes > SNAPSHOT_SCAN_BYTES
    ) {
      next = snapshot.fetchedAt;
      break;
    }
    rows += 1;
    bytes += contentBytes(snapshot);
    if (!(await referenced(ctx, snapshot._id))) unreferenced.push(snapshot._id);
  }
  for (const id of unreferenced) await ctx.db.delete("promptSnapshots", id);
  // A scan that could not move past one `fetchedAt` stops until the next sweep.
  return next === from ? undefined : next;
}
