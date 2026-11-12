// Prompt cache.
//
// Langfuse resolves a prompt and the prompts it references at request time.
// The cache stores every resolved result as an immutable snapshot and maps
// each label of a tracked prompt name to one, and each fetched version to
// the snapshot it last resolved to. A refresh of a name lists its labels,
// fetches the prompt behind each and stores the snapshots in steps that
// publish nothing, then publishes every pointer of the name at once in one
// mutation fenced by the name's token. Refreshes come from the signed
// webhook (`http.ts`), from `sync`, and from a tick that reserves every name
// whose last attempt is `PROMPT_REFRESH_INTERVAL_MS` old, which also repairs
// refreshes that failed or never arrived. A pin keeps one snapshot per scope
// and name, so a scope keeps its prompt bytes while labels move.
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
  MAX_PROMPT_DEPENDENCIES,
  MAX_PROMPT_LABELS,
  MAX_PROMPT_NAME_BYTES,
  MAX_PROMPT_NAMES,
  MAX_PROMPT_RESPONSE_BYTES,
  MAX_PROMPT_SCOPE_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_DOCUMENT_BYTES,
  PIN_TTL_MS,
  PROMPT_LIST_INTERVAL_MS,
  PROMPT_LIST_MAX_PAGES,
  PROMPT_PAGE_LIMIT,
  PROMPT_REFRESH_INTERVAL_MS,
  PROMPT_REFRESH_MAX_MS,
  PROMPT_REFRESH_SPACING_MS,
  PROMPT_STEP_LABELS,
  PROMPT_TIMEOUT_MS,
  RETENTION_BATCH,
  SNAPSHOT_GRACE_MS,
} from "./constants.js";
import { vPromptSource, vPromptType } from "./schema.js";
import { basicAuth, exportConfig, type ExportConfig } from "./settings.js";
import { byteLength } from "../shared/otlp.js";

/** Codes `get`, `pin` and `sync` throw as `ConvexError` data. */
export type PromptErrorCode =
  | "invalid_prompt_selector"
  | "invalid_prompt_name"
  | "invalid_prompt_scope"
  | "invalid_fallback"
  | "invalid_ttl"
  | "prompt_too_large"
  | "prompt_list_failed";

function refuse(code: PromptErrorCode): never {
  throw new ConvexError(code);
}

/** A name the cache can track: 1 to `MAX_PROMPT_NAME_BYTES` UTF-8 bytes. */
function isPromptName(name: string): boolean {
  return name !== "" && byteLength(name) <= MAX_PROMPT_NAME_BYTES;
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

/** The id of the snapshot with this content, inserted when no equal one exists. */
async function storeSnapshot(
  ctx: MutationCtx,
  content: Content,
): Promise<Id<"promptSnapshots">> {
  const key = await snapshotKey(content);
  const existing = await ctx.db
    .query("promptSnapshots")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  if (existing) return existing._id;
  return await ctx.db.insert("promptSnapshots", {
    key,
    ...content,
    fetchedAt: Date.now(),
  });
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

/**
 * The names a `dependsOn` keeps: a name longer than `MAX_PROMPT_NAME_BYTES`
 * is dropped, never truncated, then the rest are sorted and cut to
 * `MAX_PROMPT_DEPENDENCIES`. `cut` tells that a name was dropped or cut.
 * Applied to its own result plus more names, it gives the same as applied
 * to all names at once.
 */
function boundDependencies(names: Iterable<string>): {
  names: string[];
  cut: boolean;
} {
  const distinct = [...new Set(names)];
  const kept = distinct.filter(isPromptName).sort(compareStrings);
  return {
    names: kept.slice(0, MAX_PROMPT_DEPENDENCIES),
    cut: kept.length < distinct.length || kept.length > MAX_PROMPT_DEPENDENCIES,
  };
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

async function versionRow(
  ctx: QueryCtx,
  name: string,
  version: number,
): Promise<Doc<"promptVersions"> | null> {
  return await ctx.db
    .query("promptVersions")
    .withIndex("by_name_version", (q) =>
      q.eq("name", name).eq("version", version),
    )
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
 * The cached snapshot for a selector: the one a label maps to, or the one a
 * version resolved to in the last refresh that fetched it, while a label or
 * a pin still holds that snapshot. A pin on an older resolution of the
 * version does not keep the version readable. `null` on a miss.
 */
async function resolve(
  ctx: QueryCtx,
  { name, label, version }: Selector,
): Promise<Doc<"promptSnapshots"> | null> {
  const row =
    version === undefined
      ? await labelRow(ctx, name, label ?? "production")
      : await versionRow(ctx, name, version);
  return row && (await ctx.db.get("promptSnapshots", row.snapshotId));
}

/**
 * The cached prompt for a label (default `production`) or a version, or
 * `null` when the cache holds none, also for a name the cache cannot track.
 * A version is served as the last refresh resolved it, while a label or a
 * pin still holds that snapshot; a pin on an older resolution of the
 * version does not keep the version readable. Reads only the cache; a miss
 * starts no fetch. Throws `invalid_prompt_selector` for a label and a
 * version together.
 */
export const get = query({
  args: selectorArgs,
  returns: v.union(vPrompt, v.null()),
  handler: async (ctx, selector): Promise<Prompt | null> => {
    checkSelector(selector);
    if (!isPromptName(selector.name)) return null;
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
  const id = await storeSnapshot(ctx, {
    name,
    source: "fallback",
    type: fallback.type,
    prompt,
    config,
  });
  return (await ctx.db.get("promptSnapshots", id))!;
}

/**
 * The prompt a scope uses for a name. A pin of the scope and name that has
 * not expired returns its snapshot unchanged, whatever the label, version
 * and fallback of this call. Otherwise it resolves like `get`; on a miss it
 * stores `fallback` as a snapshot, and without a fallback it returns `null`
 * and stores nothing. The result is pinned for `ttlMs` (default
 * `PIN_TTL_MS`) from now. Runs in the caller's transaction. Throws
 * `invalid_prompt_name` for a name the cache cannot track and
 * `invalid_prompt_scope` for a scope over `MAX_PROMPT_SCOPE_BYTES`.
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
    if (!isPromptName(name)) refuse("invalid_prompt_name");
    if (byteLength(scope) > MAX_PROMPT_SCOPE_BYTES) {
      refuse("invalid_prompt_scope");
    }
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

// ── Reservation ────────────────────────────────────────────────────────────

type Reserved = { name: string; token: string };

/**
 * Reserves a refresh of a tracked name: a new token, which fences every
 * refresh reserved before, and `attemptedAt`. It clears `staged`: the
 * refresh that staged those snapshots is fenced and publishes nothing. A
 * random token never repeats, also not after the row was deleted and
 * created again.
 */
async function reserveRow(
  ctx: MutationCtx,
  row: Doc<"promptNames">,
  now: number,
): Promise<Reserved> {
  const token = crypto.randomUUID();
  await ctx.db.patch("promptNames", row._id, {
    token,
    attemptedAt: now,
    staged: undefined,
  });
  return { name: row.name, token };
}

/**
 * Reserves a refresh for each distinct name, creating its `promptNames` row
 * when missing. A name the cache cannot track (`isPromptName`) and a missing
 * name once `MAX_PROMPT_NAMES` are tracked reserve nothing and count as
 * overflow. With `onlyNew`, tracked names are skipped. `sync`, the listing
 * and the webhook all reserve through here.
 */
async function reserveNames(
  ctx: MutationCtx,
  names: string[],
  { onlyNew = false }: { onlyNew?: boolean } = {},
): Promise<{ reserved: Reserved[]; overflow: number }> {
  const now = Date.now();
  const reserved: Reserved[] = [];
  let overflow = 0;
  let free: number | undefined;
  for (const name of new Set(names)) {
    if (!isPromptName(name)) {
      overflow += 1;
      continue;
    }
    const row = await nameRow(ctx, name);
    if (row) {
      if (!onlyNew) reserved.push(await reserveRow(ctx, row, now));
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
    const token = crypto.randomUUID();
    await ctx.db.insert("promptNames", {
      name,
      token,
      dependsOn: [],
      attemptedAt: now,
    });
    reserved.push({ name, token });
  }
  return { reserved, overflow };
}

/** Schedules the reserved refreshes, `spacingMs` apart. */
async function scheduleRefreshes(
  ctx: MutationCtx,
  reserved: Reserved[],
  spacingMs = 0,
): Promise<void> {
  for (const [i, { name, token }] of reserved.entries()) {
    await ctx.scheduler.runAfter(i * spacingMs, internal.prompts.refresh, {
      name,
      token,
    });
  }
}

/**
 * Reserves a refresh for each name, as `reserveNames` does, without
 * scheduling it. Returns the token per name, `null` for a name that reserved
 * nothing.
 */
export const reserve = internalMutation({
  args: { names: v.array(v.string()) },
  returns: v.array(v.union(v.string(), v.null())),
  handler: async (ctx, { names }) => {
    const { reserved } = await reserveNames(ctx, names);
    const tokens = new Map(reserved.map(({ name, token }) => [name, token]));
    return names.map((name) => tokens.get(name) ?? null);
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
 * Reserves and schedules a refresh for each name, for `sync` and `list`.
 * Returns how many names it scheduled and how many reserved nothing. With
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
    const { reserved, overflow } = await reserveNames(ctx, names, { onlyNew });
    await scheduleRefreshes(ctx, reserved);
    return { tracked: reserved.length, overflow };
  },
});

// ── Refresh ────────────────────────────────────────────────────────────────

/** A JSON response, or a fixed code for what went wrong. */
type Fetched =
  | { ok: true; body: unknown }
  | { ok: false; status?: number; error: string };

/**
 * The body as text, or `null` once it exceeds `MAX_PROMPT_RESPONSE_BYTES`.
 * A larger `Content-Length` is refused before the body is read; otherwise
 * the body is read as a stream that is cancelled at the cap.
 */
async function boundedText(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("Content-Length") ?? 0);
  if (declared > MAX_PROMPT_RESPONSE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > MAX_PROMPT_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * One GET request to the public API, with Basic auth and a timeout. A body
 * over `MAX_PROMPT_RESPONSE_BYTES` gives `oversize`.
 */
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
    const text = await boundedText(response);
    if (text === null) return { ok: false, error: "oversize" };
    try {
      return { ok: true, body: JSON.parse(text) as unknown };
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
 * What a refresh publishes for one label: `ok` points it to a stored
 * snapshot of `version`, `gone` removes it, `failed` keeps its mapping.
 */
const vLabelResult = v.union(
  v.object({
    label: v.string(),
    outcome: v.literal("ok"),
    snapshotId: v.id("promptSnapshots"),
    version: v.number(),
  }),
  v.object({ label: v.string(), outcome: v.literal("gone") }),
  v.object({ label: v.string(), outcome: v.literal("failed") }),
);
type LabelResult = Infer<typeof vLabelResult>;

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

/** What fetching one label gave: a candidate, or a fixed error code. */
type LabelFetch =
  | { outcome: "ok"; candidate: Candidate; dependsOn: string[] }
  | { outcome: "gone" | "failed"; error: string };

/** Fetches the resolved prompt behind one label of `name`. */
async function fetchLabel(
  config: ExportConfig,
  name: string,
  label: string,
): Promise<LabelFetch> {
  const fetched = await getJson(
    config,
    `${promptPath(name)}?label=${encodeURIComponent(label)}`,
  );
  if (!fetched.ok) {
    // 404: the prompt or the label is gone; 409: a dependency is. A response
    // over the cap is removed as an oversize snapshot is.
    const gone =
      fetched.status === 404 ||
      fetched.status === 409 ||
      fetched.error === "oversize";
    return { outcome: gone ? "gone" : "failed", error: fetched.error };
  }
  const parsed = parsePrompt(name, fetched.body);
  if (!parsed) return { outcome: "failed", error: "invalid_response" };
  if (contentBytes(parsed.candidate) > MAX_SNAPSHOT_BYTES) {
    return { outcome: "gone", error: "oversize" };
  }
  return { outcome: "ok", ...parsed };
}

/**
 * Refreshes one name for the reservation `token`. It lists the name's
 * labels, at most `MAX_PROMPT_LABELS`, then fetches them
 * `PROMPT_STEP_LABELS` at a time and stores each step's snapshots with
 * `store`, which publishes nothing. Of a stored step it keeps only label,
 * snapshot id, version and the bounded dependency names, so it holds at most
 * one step of candidates at once: `PROMPT_STEP_LABELS` × `MAX_SNAPSHOT_BYTES`,
 * 3.5 MiB of prompt text, plus the responses of that step while they are
 * parsed, each read up to `MAX_PROMPT_RESPONSE_BYTES`. Last, `publish`
 * applies the whole result at once. It stops once `store` reports a newer
 * reservation. Does nothing when the component is disabled. Errors are
 * fixed codes: `http_<status>`, `network`, `timeout`,
 * `invalid_response`, `oversize`, `too_many_labels`,
 * `too_many_dependencies`; the first one is recorded.
 */
export const refresh = internalAction({
  args: { name: v.string(), token: v.string() },
  returns: v.null(),
  handler: async (ctx, { name, token }) => {
    const config = exportConfig();
    if (!config) return null;
    const listing = await getJson(
      config,
      `/api/public/v2/prompts?name=${encodeURIComponent(name)}&page=1&limit=1`,
    );
    const listed = listing.ok ? parseListing(name, listing.body) : null;
    if (listed === null) {
      await ctx.runMutation(internal.prompts.publish, {
        name,
        token,
        labels: [],
        listed: null,
        dependsOn: [],
        complete: false,
        error: listing.ok ? "invalid_response" : listing.error,
      });
      return null;
    }
    const distinct = [...new Set(listed)].sort();
    const kept = distinct.slice(0, MAX_PROMPT_LABELS);
    const errors = kept.length < distinct.length ? ["too_many_labels"] : [];
    const labels: LabelResult[] = [];
    let dependencies = boundDependencies([]);
    for (let i = 0; i < kept.length; i += PROMPT_STEP_LABELS) {
      const step = kept.slice(i, i + PROMPT_STEP_LABELS);
      const fetched = await Promise.all(
        step.map(async (label) => await fetchLabel(config, name, label)),
      );
      const candidates = fetched.flatMap((result) =>
        result.outcome === "ok" ? [result.candidate] : [],
      );
      const ids =
        candidates.length === 0
          ? []
          : await ctx.runMutation(internal.prompts.store, {
              name,
              token,
              candidates,
            });
      if (ids === null) return null;
      let stored = 0;
      for (const [j, result] of fetched.entries()) {
        const label = step[j]!;
        if (result.outcome !== "ok") {
          labels.push({ label, outcome: result.outcome });
          errors.push(result.error);
          continue;
        }
        labels.push({
          label,
          outcome: "ok",
          snapshotId: ids[stored++]!,
          version: result.candidate.version,
        });
        const merged = boundDependencies([
          ...dependencies.names,
          ...result.dependsOn,
        ]);
        dependencies = {
          names: merged.names,
          cut: dependencies.cut || merged.cut,
        };
      }
    }
    if (dependencies.cut) errors.push("too_many_dependencies");
    await ctx.runMutation(internal.prompts.publish, {
      name,
      token,
      labels,
      listed: kept,
      dependsOn: dependencies.names,
      complete:
        kept.length === distinct.length &&
        labels.every(({ outcome }) => outcome === "ok"),
      error: errors[0],
    });
    return null;
  },
});

/**
 * Stores the snapshots of one refresh step, inserting or reusing each, and
 * returns their ids in order. Publishes nothing. It adds the ids to the
 * name's `staged`, timed by the token's first `store`; the retention sweep
 * keeps a staged snapshot for `PROMPT_REFRESH_MAX_MS` from then. A snapshot
 * no refresh publishes stays unreferenced, and the sweep collects it once
 * that time is over. Returns `null` and stores nothing when `token` is not
 * the name's current one.
 */
export const store = internalMutation({
  args: {
    name: v.string(),
    token: v.string(),
    candidates: v.array(vCandidate),
  },
  returns: v.union(v.array(v.id("promptSnapshots")), v.null()),
  handler: async (ctx, { name, token, candidates }) => {
    const row = await nameRow(ctx, name);
    if (!row || row.token !== token) return null;
    const ids: Id<"promptSnapshots">[] = [];
    for (const candidate of candidates) {
      ids.push(
        await storeSnapshot(ctx, { name, source: "langfuse", ...candidate }),
      );
    }
    const staged = row.staged ?? { at: Date.now(), snapshotIds: [] };
    await ctx.db.patch("promptNames", row._id, {
      staged: {
        at: staged.at,
        snapshotIds: [...new Set([...staged.snapshotIds, ...ids])],
      },
    });
    return ids;
  },
});

/** Points version `version` of `name` to `snapshotId`. */
async function pointVersion(
  ctx: MutationCtx,
  name: string,
  version: number,
  snapshotId: Id<"promptSnapshots">,
): Promise<void> {
  const existing = await versionRow(ctx, name, version);
  if (!existing) {
    await ctx.db.insert("promptVersions", { name, version, snapshotId });
  } else if (existing.snapshotId !== snapshotId) {
    await ctx.db.patch("promptVersions", existing._id, { snapshotId });
  }
}

/**
 * Publishes the result of refresh `token` of `name` in one transaction, so a
 * reader sees all of it or none; changes nothing when `token` is not the
 * name's current one. `ok` points the label and its version to their stored
 * snapshot; `gone` removes the label; `failed` keeps its mapping. It removes
 * the labels the listing no longer shows (all of them when the prompt is
 * gone, none when the listing failed), records `error`, and clears
 * `staged`. `dependsOn` replaces the stored names only when the refresh
 * is `complete`, every listed label resolved; otherwise it adds to them, so
 * a dependency that is gone for now still reaches this name through the
 * webhook. A name without labels and without an error is no longer tracked.
 */
export const publish = internalMutation({
  args: {
    name: v.string(),
    token: v.string(),
    labels: v.array(vLabelResult),
    /** Every label of the name, or `null` when the listing failed. */
    listed: v.union(v.array(v.string()), v.null()),
    /** Other prompt names in the resolution graphs of the `ok` labels. */
    dependsOn: v.array(v.string()),
    complete: v.boolean(),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { name, token, labels, listed, dependsOn, complete, error },
  ) => {
    const row = await nameRow(ctx, name);
    if (!row || row.token !== token) return null;
    for (const result of labels) {
      const existing = await labelRow(ctx, name, result.label);
      if (result.outcome === "ok") {
        const { snapshotId } = result;
        if (!existing) {
          await ctx.db.insert("promptLabels", {
            name,
            label: result.label,
            snapshotId,
          });
        } else if (existing.snapshotId !== snapshotId) {
          await ctx.db.patch("promptLabels", existing._id, { snapshotId });
        }
        await pointVersion(ctx, name, result.version, snapshotId);
      } else if (result.outcome === "gone" && existing) {
        await ctx.db.delete("promptLabels", existing._id);
      }
    }

    const current = await ctx.db
      .query("promptLabels")
      .withIndex("by_name_label", (q) => q.eq("name", name))
      .take(2 * MAX_PROMPT_LABELS);
    let left = current.length;
    if (listed !== null) {
      const shown = new Set(listed);
      for (const label of current) {
        if (shown.has(label.label)) continue;
        await ctx.db.delete("promptLabels", label._id);
        left -= 1;
      }
    }
    if (left === 0 && error === undefined) {
      await ctx.db.delete("promptNames", row._id);
      return null;
    }
    await ctx.db.patch("promptNames", row._id, {
      staged: undefined,
      dependsOn: complete
        ? dependsOn
        : boundDependencies([...row.dependsOn, ...dependsOn]).names,
      error,
    });
    return null;
  },
});

// ── Triggers ───────────────────────────────────────────────────────────────

/**
 * Every 5 minutes: reserves every tracked name whose last attempt is at
 * least `PROMPT_REFRESH_INTERVAL_MS` old, at most `MAX_PROMPT_NAMES`, and
 * schedules their refreshes `PROMPT_REFRESH_SPACING_MS` apart, the last of
 * 500 at 99.8 s. So every due name is reserved and scheduled no later than
 * the first tick after it became due plus 99.8 s. Schedules `list` once the
 * last listing is `PROMPT_LIST_INTERVAL_MS` old. Writes and schedules
 * nothing before the first `sync` or webhook created `promptSync`, or while
 * the component is disabled.
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
      .take(MAX_PROMPT_NAMES);
    const reserved: Reserved[] = [];
    for (const row of due) reserved.push(await reserveRow(ctx, row, now));
    await scheduleRefreshes(ctx, reserved, PROMPT_REFRESH_SPACING_MS);
    if (
      sync.lastListAt === undefined ||
      now - sync.lastListAt >= PROMPT_LIST_INTERVAL_MS
    ) {
      await ctx.scheduler.runAfter(0, internal.prompts.list, {});
    }
    return null;
  },
});

/** Sets `lastListAt` after a listing ended, on its last page or at the page cap. */
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
 * `lastListAt` once it read the last page or stopped at the page cap, so
 * the next listing is due `PROMPT_LIST_INTERVAL_MS` later either way.
 * Returns the summed counts and whether it read every page, or `null` when
 * a page failed.
 */
async function listAndRequest(
  ctx: ActionCtx,
  config: ExportConfig,
  onlyNew: boolean,
): Promise<{ tracked: number; overflow: number; complete: boolean } | null> {
  const total = { tracked: 0, overflow: 0 };
  for (let page = 1; ; page++) {
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
    if (page >= totalPages || page === PROMPT_LIST_MAX_PAGES) {
      await ctx.runMutation(internal.prompts.listed, {});
      return { ...total, complete: page >= totalPages };
    }
  }
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
  /**
   * `incomplete`: the listing stopped at `PROMPT_LIST_MAX_PAGES` pages, so
   * names on later pages are not tracked.
   */
  status: v.union(
    v.literal("ok"),
    v.literal("incomplete"),
    v.literal("disabled"),
  ),
  /** Names a refresh was scheduled for. */
  tracked: v.number(),
  /**
   * Listed names not tracked: `MAX_PROMPT_NAMES` are, or the name has more
   * than `MAX_PROMPT_NAME_BYTES`.
   */
  overflow: v.number(),
});
export type SyncResult = Infer<typeof vSyncResult>;

/**
 * Turns the prompt cache on and schedules refreshes. With `names`, for those
 * names; without, for every name the list endpoint returns. Refreshes run in
 * the background. Returns `disabled` without writing when the component has
 * no export configuration. Throws `prompt_list_failed` when a page of the
 * listing fails and `invalid_prompt_name` for a name that is empty or has
 * more than `MAX_PROMPT_NAME_BYTES`.
 */
export const sync = action({
  args: { names: v.optional(v.array(v.string())) },
  returns: vSyncResult,
  handler: async (ctx, { names }): Promise<SyncResult> => {
    const config = exportConfig();
    if (!config) return { status: "disabled", tracked: 0, overflow: 0 };
    if (names?.some((name) => !isPromptName(name))) {
      refuse("invalid_prompt_name");
    }
    const counts = await ctx.runMutation(internal.prompts.request, {
      names: names ?? [],
      start: true,
    });
    if (names) return { status: "ok", ...counts };
    const listing = await listAndRequest(ctx, config, false);
    if (!listing) refuse("prompt_list_failed");
    const { complete, ...listed } = listing;
    return { status: complete ? "ok" : "incomplete", ...listed };
  },
});

/**
 * A verified webhook delivery for prompt `name`: records `lastWebhookAt`,
 * creating `promptSync`, and requests a refresh for the name and for every
 * tracked name whose `dependsOn` holds it. A name the cache cannot track
 * reserves nothing. A replayed delivery causes one more refresh, which
 * reuses the existing snapshots.
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
    ).filter((row) => row.dependsOn.includes(name));
    const { reserved } = await reserveNames(ctx, [name]);
    const now = Date.now();
    for (const row of dependents)
      reserved.push(await reserveRow(ctx, row, now));
    await scheduleRefreshes(ctx, reserved);
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
 * Whether the current refresh of the row staged the snapshot less than
 * `PROMPT_REFRESH_MAX_MS` ago, so it may still publish it. `store` can stage
 * an old snapshot it reused.
 */
function staged(
  row: Doc<"promptNames"> | null,
  snapshotId: Id<"promptSnapshots">,
  now: number,
): boolean {
  return (
    row?.staged !== undefined &&
    row.staged.at > now - PROMPT_REFRESH_MAX_MS &&
    row.staged.snapshotIds.includes(snapshotId)
  );
}

/** Where a snapshot collection pass continues. */
export const vSnapshotPass = v.object({
  /** The `paginate` cursor of `by_fetchedAt`, `null` at the start. */
  cursor: v.union(v.string(), v.null()),
  /** Snapshots fetched before this are collected in this pass. */
  cutoff: v.number(),
});
export type SnapshotPass = Infer<typeof vSnapshotPass>;

/**
 * One step of a snapshot collection pass, within `bytes` of reads and
 * deletions. It reads one page of snapshots fetched before the pass's cutoff
 * and deletes those that no label and no pin references, unless the running
 * refresh of their name staged them (`staged`), with their version
 * pointers. A pass without `pass` starts at `now - SNAPSHOT_GRACE_MS`.
 * Returns the pass to continue in the next sweep, or `undefined` once it
 * read the last page.
 */
export async function collectSnapshots(
  ctx: MutationCtx,
  now: number,
  bytes: number,
  pass: SnapshotPass = { cursor: null, cutoff: now - SNAPSHOT_GRACE_MS },
): Promise<SnapshotPass | undefined> {
  // A page ends with the snapshot that reaches `maximumBytesRead`, so it
  // reads at most that plus one snapshot, and deleting all of it costs as
  // much again. A budget too small for that waits for the next sweep.
  const maximumBytesRead = Math.floor(bytes / 2) - MAX_SNAPSHOT_DOCUMENT_BYTES;
  if (maximumBytesRead <= 0) return pass;
  const { page, isDone, continueCursor } = await ctx.db
    .query("promptSnapshots")
    .withIndex("by_fetchedAt", (q) => q.lt("fetchedAt", pass.cutoff))
    .paginate({
      cursor: pass.cursor,
      numItems: RETENTION_BATCH,
      maximumBytesRead,
    });
  const names = new Map<string, Doc<"promptNames"> | null>();
  for (const snapshot of page) {
    if (await referenced(ctx, snapshot._id)) continue;
    if (!names.has(snapshot.name)) {
      names.set(snapshot.name, await nameRow(ctx, snapshot.name));
    }
    if (staged(names.get(snapshot.name) ?? null, snapshot._id, now)) continue;
    // A snapshot has one name and version, so one pointer at most.
    const pointer = await ctx.db
      .query("promptVersions")
      .withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshot._id))
      .first();
    if (pointer) await ctx.db.delete("promptVersions", pointer._id);
    await ctx.db.delete("promptSnapshots", snapshot._id);
  }
  return isDone ? undefined : { cursor: continueCursor, cutoff: pass.cutoff };
}
