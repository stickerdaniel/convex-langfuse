// Skill cache.
//
// The cache stores the `production` and `latest` version of every tracked
// skill name, with the content of each file, and serves them from Convex.
// Reads never call Langfuse. A request on a name (from the signed webhook in
// `http.ts`, `sync`, a listing page or the daily refresh) raises its
// `requested` count and makes it eligible. A batch-worker loop named
// `SKILL_WORKER_NAME` drives one fenced run at a time, as the exporter's
// loop does: the run action alternates between `advance`, which applies the
// previous request's result and hands out the next request, and one HTTP
// request. Requests start at least `SKILL_REQUEST_SPACING_MS` after the end
// of the one before, and a 429 pauses every request. A name refresh fetches
// `production`, then `latest` unless the first response holds it, stores
// each version with its files in one transaction (`store`) and sets both
// pointers at once (`publish`). The payload of a webhook is never used as
// state.
//
// No skill function reads or writes the export or prompt tables.

import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { ConvexError, v, type Infer } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import {
  HEALTH_COUNT_CAP,
  LEASE_MS,
  MAX_SKILL_BYTES,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_FILES,
  MAX_SKILL_FRONTMATTER_BYTES,
  MAX_SKILL_FRONTMATTER_DEPTH,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_NAMES,
  MAX_SKILL_PATH_LENGTH,
  MAX_SKILL_RESPONSE_BYTES,
  MAX_SKILL_VERSION_ROWS,
  PROMPT_TIMEOUT_MS,
  RETENTION_BATCH,
  RUN_BUDGET_MS,
  SKILL_BACKGROUND_SHARE_MS,
  SKILL_BACKOFF_MS,
  SKILL_COOLDOWN_MAX_MS,
  SKILL_COOLDOWN_MIN_MS,
  SKILL_COOLDOWN_MS,
  SKILL_FULL_REFRESH_MS,
  SKILL_LIST_INTERVAL_MS,
  SKILL_LIST_MAX_PAGES,
  SKILL_LIST_PAGE_LIMIT,
  SKILL_MAX_WAIT_MS,
  SKILL_REQUEST_DELAY_MS,
  SKILL_REQUEST_SPACING_MS,
  SKILL_SELECT_WINDOW,
  SKILL_SWEEP_BYTES,
  SKILL_TICK_NAMES,
  SKILL_UNPUBLISHED_GRACE_MS,
  SKILL_VERSION_WINDOW_MS,
  SKILL_WORKER_NAME,
} from "./constants.js";
import { canonicalJson, compareStrings, isRecord } from "./prompts.js";
import { parseRetryAfter } from "./retry.js";
import { vSkillLabel, type SkillLabel } from "./schema.js";
import { basicAuth, exportConfig, type ExportConfig } from "./settings.js";
import { sha256Hex } from "../shared/hash.js";
import { byteLength, hasLoneSurrogate } from "../shared/otlp.js";

/** Codes `get` and `sync` throw as `ConvexError` data. */
export type SkillErrorCode = "invalid_skill_name" | "invalid_skill_selector";

function refuse(code: SkillErrorCode): never {
  throw new ConvexError(code);
}

/** A name Langfuse accepts for a skill: lowercase words joined by hyphens. */
function isSkillName(name: string): boolean {
  return (
    name.length <= MAX_SKILL_NAME_LENGTH &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
  );
}

/** Poll interval of the loop while a run holds the lease. */
const LEASE_POLL_MS = 2_000;

async function nameRow(
  ctx: QueryCtx,
  name: string,
): Promise<Doc<"skillNames"> | null> {
  return await ctx.db
    .query("skillNames")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
}

async function labelRow(
  ctx: QueryCtx,
  name: string,
  label: SkillLabel,
): Promise<Doc<"skillLabels"> | null> {
  return await ctx.db
    .query("skillLabels")
    .withIndex("by_name_label", (q) => q.eq("name", name).eq("label", label))
    .unique();
}

async function getFetcher(ctx: QueryCtx): Promise<Doc<"skillFetcher"> | null> {
  return await ctx.db.query("skillFetcher").first();
}

async function getSync(ctx: QueryCtx): Promise<Doc<"skillSync"> | null> {
  return await ctx.db.query("skillSync").first();
}

// ── Reads ──────────────────────────────────────────────────────────────────

const vSkill = v.object({
  name: v.string(),
  version: v.number(),
  description: v.string(),
  /** Canonical JSON of the frontmatter object. */
  frontmatter: v.string(),
  /** Sorted by path. */
  files: v.array(v.object({ path: v.string(), content: v.string() })),
  /** Equal for equal file sets. */
  snapshotId: v.string(),
});
export type Skill = Infer<typeof vSkill>;

/**
 * The version `get({ version })` serves: the row a label holds with that
 * number, otherwise, of the rows with that number, one that a label held
 * within `SKILL_VERSION_WINDOW_MS` and that the sweep is not deleting, the
 * latest published one if Langfuse recreated the number. The scan reads the
 * `MAX_SKILL_VERSION_ROWS` newest rows.
 */
async function windowedVersion(
  ctx: QueryCtx,
  name: string,
  version: number,
  now: number,
): Promise<Doc<"skillVersions"> | null> {
  for (const label of ["production", "latest"] as const) {
    const pointer = await labelRow(ctx, name, label);
    if (pointer?.version !== version) continue;
    const held = await ctx.db.get("skillVersions", pointer.versionId);
    if (held && !held.deleting) return held;
  }
  const rows = await ctx.db
    .query("skillVersions")
    .withIndex("by_name_version", (q) =>
      q.eq("name", name).eq("version", version),
    )
    .order("desc")
    .take(MAX_SKILL_VERSION_ROWS);
  let served: Doc<"skillVersions"> | null = null;
  let servedAt = -Infinity;
  for (const row of rows) {
    if (row.publishedAt === undefined || row.deleting) continue;
    if (
      row.releasedAt !== undefined &&
      row.releasedAt <= now - SKILL_VERSION_WINDOW_MS
    ) {
      continue;
    }
    if (row.publishedAt > servedAt) {
      served = row;
      servedAt = row.publishedAt;
    }
  }
  return served;
}

/**
 * The cached skill for a label (default `production`) or a version, or
 * `null` on a miss. A version is served while a label holds it or held it
 * within the last 7 days, as last fetched. Reads only the cache; a miss
 * starts no fetch. Throws `invalid_skill_selector` for a label and a version
 * together or a version that is not a positive integer, and
 * `invalid_skill_name` for a name Langfuse cannot hold.
 */
export const get = query({
  args: {
    name: v.string(),
    label: v.optional(vSkillLabel),
    version: v.optional(v.number()),
  },
  returns: v.union(vSkill, v.null()),
  handler: async (ctx, { name, label, version }): Promise<Skill | null> => {
    if (
      version !== undefined &&
      (label !== undefined || !Number.isSafeInteger(version) || version < 1)
    ) {
      refuse("invalid_skill_selector");
    }
    if (!isSkillName(name)) refuse("invalid_skill_name");
    let found: Doc<"skillVersions"> | null;
    if (version === undefined) {
      const pointer = await labelRow(ctx, name, label ?? "production");
      found = pointer && (await ctx.db.get("skillVersions", pointer.versionId));
      // `publish` never points a label at a version the sweep is deleting.
      if (found?.deleting) found = null;
    } else {
      found = await windowedVersion(ctx, name, version, Date.now());
    }
    if (!found) return null;
    const stored = found;
    const files = await ctx.db
      .query("skillFiles")
      .withIndex("by_version", (q) => q.eq("versionId", stored._id))
      .take(MAX_SKILL_FILES);
    return {
      name,
      version: stored.version,
      description: stored.description,
      frontmatter: stored.frontmatter,
      files: files
        .map(({ path, content }) => ({ path, content }))
        .sort((a, b) => compareStrings(a.path, b.path)),
      snapshotId: stored.snapshotId,
    };
  },
});

// ── Requests ───────────────────────────────────────────────────────────────

/**
 * Makes sure the skill loop runs. Read-only while the loop is running, so
 * requests do not conflict with it; wakes a loop that waits.
 */
async function pingSkills(ctx: MutationCtx): Promise<void> {
  await ping(ctx, components.batchWorker, {
    name: SKILL_WORKER_NAME,
    workQuery: internal.skills.nextWork,
    workerMutation: internal.skills.dispatch,
    config: { debounceMs: 0 },
  });
}

/** Schedules `wake` at `at`, for a time the loop may have missed. */
async function scheduleWake(ctx: MutationCtx, at: number): Promise<void> {
  await ctx.scheduler.runAt(at, internal.skills.wake, {});
}

/** Spreads first daily refreshes over the day: FNV-1a of the name. */
function dailyOffset(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash = Math.imul(hash ^ name.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash % SKILL_FULL_REFRESH_MS;
}

async function freeSlots(ctx: QueryCtx): Promise<number> {
  return (
    MAX_SKILL_NAMES -
    (await ctx.db.query("skillSlots").take(MAX_SKILL_NAMES)).length
  );
}

/** Starts tracking `name` without a request. The caller checks the bound. */
async function track(
  ctx: MutationCtx,
  name: string,
  now: number,
  watch: boolean,
): Promise<Doc<"skillNames">> {
  const id = await ctx.db.insert("skillNames", {
    name,
    requested: 0,
    priority: 1,
    failures: 0,
    fullDueAt: now + dailyOffset(name),
    watch,
  });
  await ctx.db.insert("skillSlots", { name });
  return (await ctx.db.get("skillNames", id))!;
}

/**
 * A webhook or `sync` request: due `SKILL_REQUEST_DELAY_MS` from now, or
 * earlier if already due, at priority 0. It overrides a name's retry time,
 * never the global cooldown. Schedules a wake at the new due time.
 */
async function requestNow(
  ctx: MutationCtx,
  row: Doc<"skillNames">,
  now: number,
): Promise<void> {
  const eligibleAt = Math.min(
    row.eligibleAt ?? Infinity,
    now + SKILL_REQUEST_DELAY_MS,
  );
  await ctx.db.patch("skillNames", row._id, {
    requested: row.requested + 1,
    priority: 0,
    eligibleAt,
    queuedAt: row.queuedAt ?? now,
  });
  if (eligibleAt !== row.eligibleAt) await scheduleWake(ctx, eligibleAt);
}

/**
 * The fields of a background request (listing, daily refresh): due now, at
 * priority 1 unless a priority-0 request is pending.
 */
function backgroundRequest(row: Doc<"skillNames">, now: number) {
  const pending = row.eligibleAt !== undefined;
  return {
    requested: row.requested + 1,
    priority: pending && row.priority === 0 ? (0 as const) : (1 as const),
    eligibleAt: Math.min(row.eligibleAt ?? Infinity, now),
    queuedAt: row.queuedAt ?? now,
  };
}

const vSyncResult = v.object({
  /** `incomplete`: a name was not tracked, because 500 names are. */
  status: v.union(v.literal("ok"), v.literal("incomplete")),
  /** Names the cache tracks after the call. */
  tracked: v.number(),
});
export type SyncResult = Infer<typeof vSyncResult>;

/**
 * Turns the skill cache on. Without `names` it tracks every skill of the
 * project from now on: the listing and the webhook add new ones. With
 * `names` it adds those names and requests a refresh for each; it never
 * removes a name, and a name given here stays tracked while Langfuse has
 * no such skill. Refreshes run in the background, so content appears
 * eventually. Throws `invalid_skill_name` for a name Langfuse cannot hold.
 */
export const sync = mutation({
  args: { names: v.optional(v.array(v.string())) },
  returns: vSyncResult,
  handler: async (ctx, { names }): Promise<SyncResult> => {
    if (names?.some((name) => !isSkillName(name))) {
      refuse("invalid_skill_name");
    }
    const now = Date.now();
    const existing = await getSync(ctx);
    const mode = names === undefined ? "all" : (existing?.mode ?? "names");
    if (!existing) {
      await ctx.db.insert("skillSync", { mode });
    } else if (existing.mode !== mode) {
      await ctx.db.patch("skillSync", existing._id, { mode });
    }
    let incomplete = false;
    let free: number | undefined;
    for (const name of new Set(names)) {
      let row = await nameRow(ctx, name);
      if (!row) {
        free ??= await freeSlots(ctx);
        if (free <= 0) {
          incomplete = true;
          continue;
        }
        free -= 1;
        row = await track(ctx, name, now, true);
      } else if (!row.watch) {
        await ctx.db.patch("skillNames", row._id, { watch: true });
      }
      await requestNow(ctx, row, now);
    }
    await pingSkills(ctx);
    // In mode `all`, the last listing walk shows whether every name fit.
    if (
      mode === "all" &&
      (await getFetcher(ctx))?.listError === "too_many_skills"
    ) {
      incomplete = true;
    }
    return {
      status: incomplete ? "incomplete" : "ok",
      tracked: MAX_SKILL_NAMES - (await freeSlots(ctx)),
    };
  },
});

/**
 * A verified `skill-version` delivery for `name`: a request on a tracked
 * name, and in mode `all` on a new name within the bound. Writes only the
 * name's rows. Does nothing before the first `sync`.
 */
export const webhook = internalMutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, { name }) => {
    const sync = await getSync(ctx);
    if (!sync || !isSkillName(name)) return null;
    const now = Date.now();
    let row = await nameRow(ctx, name);
    if (!row) {
      if (sync.mode !== "all" || (await freeSlots(ctx)) <= 0) return null;
      row = await track(ctx, name, now, false);
    }
    await requestNow(ctx, row, now);
    await pingSkills(ctx);
    return null;
  },
});

/**
 * Every 5 minutes: pings the loop, which also starts a listing that is due,
 * and queues up to `SKILL_TICK_NAMES` names whose daily refresh is due as
 * background requests, moving each one's `fullDueAt` a day ahead at once.
 * Does nothing before the first `sync`.
 */
export const tick = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (!(await getSync(ctx))) return null;
    const now = Date.now();
    const due = await ctx.db
      .query("skillNames")
      .withIndex("by_fullDueAt", (q) => q.lte("fullDueAt", now))
      .take(SKILL_TICK_NAMES);
    for (const row of due) {
      await ctx.db.patch("skillNames", row._id, {
        ...backgroundRequest(row, now),
        fullDueAt: row.fullDueAt + SKILL_FULL_REFRESH_MS,
      });
    }
    await pingSkills(ctx);
    return null;
  },
});

/**
 * Scheduled at every future time the loop works toward. batch-worker
 * confirms only a `batch` with a dependency read, so a loop transaction
 * that saw no work can go idle although a concurrent request created work
 * due later. This write conflicts with such a transaction through
 * `nextWork`'s read of `skillWake`, and the `ping` wakes a waiting loop.
 */
export const wake = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const at = Date.now();
    const row = await ctx.db.query("skillWake").first();
    if (row) {
      await ctx.db.patch("skillWake", row._id, { at });
    } else {
      await ctx.db.insert("skillWake", { at });
    }
    await pingSkills(ctx);
    return null;
  },
});

// ── Loop ───────────────────────────────────────────────────────────────────

const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } =
  defineBatchWorkerValidators({
    batch: {
      op: v.union(v.literal("start"), v.literal("wait")),
      ms: v.optional(v.number()),
    },
  });

function leaseActive(
  fetcher: Doc<"skillFetcher"> | null,
  now: number,
): boolean {
  return (fetcher?.leaseExpiresAt ?? 0) > now;
}

/** When the next listing page is due; never before the first `sync`. */
function listingAt(
  fetcher: Doc<"skillFetcher"> | null,
  sync: Doc<"skillSync"> | null,
): number {
  if (!sync) return Infinity;
  if (fetcher?.list || fetcher?.lastListAt === undefined) return 0;
  return fetcher.lastListAt + SKILL_LIST_INTERVAL_MS;
}

/** When the first pending request of `priority` is due, or `Infinity`. */
async function nameAt(ctx: QueryCtx, priority: 0 | 1): Promise<number> {
  const row = await ctx.db
    .query("skillNames")
    .withIndex("by_priority_eligibleAt", (q) =>
      q.eq("priority", priority).gte("eligibleAt", 0),
    )
    .first();
  return row?.eligibleAt ?? Infinity;
}

/**
 * When the next request may start: the earliest due work of the three
 * sources, held back by the spacing and a cooldown. `Infinity` without work.
 */
async function startAt(
  ctx: QueryCtx,
  fetcher: Doc<"skillFetcher"> | null,
  sync: Doc<"skillSync"> | null,
): Promise<number> {
  const due = Math.min(
    await nameAt(ctx, 0),
    await nameAt(ctx, 1),
    listingAt(fetcher, sync),
  );
  return Math.max(
    due,
    fetcher?.nextRequestAt ?? 0,
    fetcher?.cooldownUntil ?? 0,
  );
}

/** The work query of the batch-worker loop. Runs on a stale snapshot. */
export const nextWork = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx) => {
    // The value is not used: the read makes a concurrent `wake` conflict.
    await ctx.db.query("skillWake").first();
    if (exportConfig() === null) return { kind: "idle" as const };
    const now = Date.now();
    const fetcher = await getFetcher(ctx);
    if (leaseActive(fetcher, now)) {
      return { batch: { op: "wait" as const, ms: LEASE_POLL_MS } };
    }
    const at = await startAt(ctx, fetcher, await getSync(ctx));
    if (at === Infinity) return { kind: "idle" as const };
    if (at <= now) return { batch: { op: "start" as const } };
    return { kind: "idle" as const, timeoutMs: at - now };
  },
});

/**
 * The worker mutation of the batch-worker loop. Starts a run by bumping
 * `generation` and taking a lease when the next request may start, which
 * it checks again because `nextWork` read a stale snapshot. Always returns
 * a `debounceMs`, so the loop stays `running` and a `ping` stays read-only.
 */
export const dispatch = internalMutation({
  args: vMutationArgs,
  returns: vMutationReturns,
  handler: async (ctx, { op, ms }) => {
    if (op === "wait") return { debounceMs: ms ?? LEASE_POLL_MS };
    const now = Date.now();
    let fetcher = await getFetcher(ctx);
    if (leaseActive(fetcher, now)) return { debounceMs: LEASE_POLL_MS };
    if (
      exportConfig() === null ||
      (await startAt(ctx, fetcher, await getSync(ctx))) > now
    ) {
      return { debounceMs: LEASE_POLL_MS };
    }
    if (!fetcher) {
      const id = await ctx.db.insert("skillFetcher", {
        generation: 0,
        nextRequestAt: 0,
      });
      fetcher = (await ctx.db.get("skillFetcher", id))!;
    }
    const generation = fetcher.generation + 1;
    await ctx.db.patch("skillFetcher", fetcher._id, {
      generation,
      leaseExpiresAt: now + LEASE_MS,
      runStartedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.skills.run, { generation });
    return { debounceMs: LEASE_POLL_MS };
  },
});

const vListEntry = v.object({
  name: v.string(),
  latestVersion: v.number(),
  productionVersion: v.union(v.number(), v.null()),
});
type ListEntry = Infer<typeof vListEntry>;

const vPage = v.union(
  v.object({
    ok: v.literal(true),
    entries: v.array(vListEntry),
    hasNextPage: v.boolean(),
  }),
  v.object({ ok: v.literal(false), error: v.string() }),
);
type Page = Infer<typeof vPage>;

const vReport = v.object({
  /** When the response arrived. */
  end: v.number(),
  /** Set for a 429, with the wait `Retry-After` asked for. */
  limited: v.optional(v.object({ retryAfterMs: v.optional(v.number()) })),
  /** A listing page's result; absent for a name GET and a 429. */
  page: v.optional(vPage),
});
/** What the run reports about the request `advance` handed out last. */
type Report = Infer<typeof vReport>;

const vStep = v.union(
  v.object({ kind: v.literal("done") }),
  v.object({ kind: v.literal("wait"), ms: v.number() }),
  v.object({ kind: v.literal("label"), name: v.string(), label: vSkillLabel }),
  v.object({ kind: v.literal("list"), page: v.number() }),
);
type Step = Infer<typeof vStep>;

/**
 * Of the first `SKILL_SELECT_WINDOW` names of `priority` that are due at
 * `now`, the one queued first.
 */
async function dueName(
  ctx: QueryCtx,
  priority: 0 | 1,
  now: number,
): Promise<Doc<"skillNames"> | null> {
  const rows = await ctx.db
    .query("skillNames")
    .withIndex("by_priority_eligibleAt", (q) =>
      q.eq("priority", priority).gte("eligibleAt", 0).lte("eligibleAt", now),
    )
    .take(SKILL_SELECT_WINDOW);
  let first: Doc<"skillNames"> | null = null;
  for (const row of rows) {
    if (first === null || (row.queuedAt ?? now) < (first.queuedAt ?? now)) {
      first = row;
    }
  }
  return first;
}

/** The fetcher fields `advance` changes besides the lease. */
type FetcherPatch = Partial<
  Pick<
    Doc<"skillFetcher">,
    "nextRequestAt" | "cooldownUntil" | "list" | "lastListAt" | "listError"
  >
>;

type Choice =
  | { kind: "name"; row: Doc<"skillNames">; background: boolean }
  | { kind: "list" };

/**
 * The next request: background work (a priority-1 name or a listing page,
 * alternating) when none was handed out for `SKILL_BACKGROUND_SHARE_MS`,
 * otherwise a priority-0 name, otherwise background work. `null` when
 * nothing is due.
 */
async function choose(
  ctx: QueryCtx,
  fetcher: Doc<"skillFetcher">,
  sync: Doc<"skillSync"> | null,
  now: number,
): Promise<Choice | null> {
  const urgent = await dueName(ctx, 0, now);
  const background = await dueName(ctx, 1, now);
  const listing = listingAt(fetcher, sync) <= now;
  const starved =
    fetcher.lastBackgroundAt === undefined ||
    now - fetcher.lastBackgroundAt >= SKILL_BACKGROUND_SHARE_MS;
  if ((background || listing) && (starved || !urgent)) {
    if (background && (!listing || fetcher.lastBackgroundKind === "list")) {
      return { kind: "name", row: background, background: true };
    }
    return { kind: "list" };
  }
  return urgent && { kind: "name", row: urgent, background: false };
}

/**
 * Applies one listing page to the walk in `fetcher.list`. A tracked name
 * whose `production` or `latest` number differs from its label rows gets a
 * background request; in mode `all` a new name is tracked and requested
 * within the bound. A walk ends at the last page, at an error or after
 * `SKILL_LIST_MAX_PAGES` pages. Only a walk that reached the last page
 * requests the names it never saw, whose refresh confirms a deletion.
 * Returns the fetcher fields to write.
 */
async function applyPage(
  ctx: MutationCtx,
  walk: NonNullable<Doc<"skillFetcher">["list"]>,
  sync: Doc<"skillSync"> | null,
  page: Page,
  now: number,
): Promise<FetcherPatch> {
  let overflow = walk.overflow ?? false;
  const end = async (listError: string | undefined) => {
    await scheduleWake(ctx, now + SKILL_LIST_INTERVAL_MS);
    return {
      list: undefined,
      lastListAt: now,
      listError: listError ?? (overflow ? "too_many_skills" : undefined),
    };
  };
  if (!page.ok) return await end(page.error);
  const seen = new Set(walk.seen);
  let free: number | undefined;
  for (const entry of page.entries) {
    const row = await nameRow(ctx, entry.name);
    if (!row) {
      if (sync?.mode !== "all") continue;
      free ??= await freeSlots(ctx);
      if (free <= 0) {
        overflow = true;
        continue;
      }
      free -= 1;
      const tracked = await track(ctx, entry.name, now, false);
      await ctx.db.patch(
        "skillNames",
        tracked._id,
        backgroundRequest(tracked, now),
      );
      seen.add(entry.name);
      continue;
    }
    seen.add(entry.name);
    if (await moved(ctx, entry)) {
      await ctx.db.patch("skillNames", row._id, backgroundRequest(row, now));
    }
  }
  if (page.hasNextPage) {
    if (walk.page < SKILL_LIST_MAX_PAGES) {
      return {
        list: {
          ...walk,
          page: walk.page + 1,
          seen: [...seen],
          ...(overflow ? { overflow } : {}),
        },
      };
    }
    return await end("too_many_skills");
  }
  // A name tracked after the walk started can be missing from earlier pages.
  const tracked = await ctx.db.query("skillNames").take(MAX_SKILL_NAMES);
  for (const row of tracked) {
    if (seen.has(row.name) || row._creationTime >= walk.startedAt) continue;
    await ctx.db.patch("skillNames", row._id, backgroundRequest(row, now));
  }
  return await end(undefined);
}

/** Whether a listing entry's numbers differ from the cached pointers. */
async function moved(ctx: QueryCtx, entry: ListEntry): Promise<boolean> {
  const production = await labelRow(ctx, entry.name, "production");
  const latest = await labelRow(ctx, entry.name, "latest");
  return (
    (production?.version ?? null) !== entry.productionVersion ||
    latest?.version !== entry.latestVersion
  );
}

/**
 * Applies the previous request's result, then hands out the next request,
 * a wait of at most `SKILL_MAX_WAIT_MS`, or `done`; renews the lease.
 * Fenced by `generation`: a superseded run gets `done` and changes nothing.
 *
 * A result sets `nextRequestAt` to its end plus `SKILL_REQUEST_SPACING_MS`.
 * A hand-out sets it to `PROMPT_TIMEOUT_MS` plus the spacing from now, so a
 * run that dies with a request in flight leaves a bound that covers that
 * request. A 429 sets `cooldownUntil` for every request and ends the run.
 * A request is handed out only while the run is within `RUN_BUDGET_MS`.
 * `latestOf` names the claimed name whose `latest` GET comes next.
 */
export const advance = internalMutation({
  args: {
    generation: v.number(),
    report: v.optional(vReport),
    latestOf: v.optional(v.string()),
  },
  returns: vStep,
  handler: async (ctx, { generation, report, latestOf }): Promise<Step> => {
    const fetcher = await getFetcher(ctx);
    if (!fetcher || fetcher.generation !== generation) return { kind: "done" };
    const now = Date.now();
    const sync = await getSync(ctx);
    const patch: FetcherPatch = {};
    const endRun = async (): Promise<Step> => {
      await ctx.db.patch("skillFetcher", fetcher._id, {
        ...patch,
        leaseExpiresAt: undefined,
        runStartedAt: undefined,
      });
      return { kind: "done" };
    };

    if (report) {
      patch.nextRequestAt = report.end + SKILL_REQUEST_SPACING_MS;
      if (report.limited) {
        const wait = report.limited.retryAfterMs ?? SKILL_COOLDOWN_MS;
        patch.cooldownUntil =
          now +
          Math.min(
            SKILL_COOLDOWN_MAX_MS,
            Math.max(SKILL_COOLDOWN_MIN_MS, wait),
          );
        await scheduleWake(ctx, patch.cooldownUntil);
        return await endRun();
      }
      if (report.page && fetcher.list) {
        Object.assign(
          patch,
          await applyPage(ctx, fetcher.list, sync, report.page, now),
        );
      }
    }
    const state = { ...fetcher, ...patch };
    if (now - (fetcher.runStartedAt ?? now) >= RUN_BUDGET_MS) {
      return await endRun();
    }

    let choice: Choice | null;
    if (latestOf !== undefined) {
      const row = await nameRow(ctx, latestOf);
      if (row?.claimed?.generation !== generation) return await endRun();
      choice = { kind: "name", row, background: false };
    } else {
      choice = await choose(ctx, state, sync, now);
    }
    // Without a choice, the next work is due later than now.
    const at = Math.max(
      choice ? now : await startAt(ctx, state, sync),
      state.nextRequestAt,
      state.cooldownUntil ?? 0,
    );
    if (!choice || at > now) {
      if (at - now > SKILL_MAX_WAIT_MS) return await endRun();
      await ctx.db.patch("skillFetcher", fetcher._id, {
        ...patch,
        leaseExpiresAt: now + LEASE_MS,
      });
      return { kind: "wait", ms: at - now };
    }
    const next = choice;
    const handOut = {
      ...patch,
      leaseExpiresAt: now + LEASE_MS,
      nextRequestAt: now + PROMPT_TIMEOUT_MS + SKILL_REQUEST_SPACING_MS,
    };
    if (next.kind === "list") {
      await ctx.db.patch("skillFetcher", fetcher._id, {
        ...handOut,
        list: state.list ?? { page: 1, startedAt: now, seen: [] },
        lastBackgroundAt: now,
        lastBackgroundKind: "list",
      });
      return { kind: "list", page: state.list?.page ?? 1 };
    }
    await ctx.db.patch("skillFetcher", fetcher._id, {
      ...handOut,
      ...(next.background
        ? { lastBackgroundAt: now, lastBackgroundKind: "name" as const }
        : {}),
    });
    if (latestOf !== undefined) {
      return { kind: "label", name: latestOf, label: "latest" };
    }
    await ctx.db.patch("skillNames", next.row._id, {
      claimed: { generation, requested: next.row.requested },
    });
    return { kind: "label", name: next.row.name, label: "production" };
  },
});

const vOutcome = v.union(
  v.object({ outcome: v.literal("ok"), versionId: v.id("skillVersions") }),
  /** 404: the skill or the label is gone. */
  v.object({ outcome: v.literal("gone") }),
  v.object({ outcome: v.literal("failed"), error: v.string() }),
  /** 429: the name keeps its request without a backoff. */
  v.object({ outcome: v.literal("limited") }),
);
type Outcome = Infer<typeof vOutcome>;

const vStoredFile = v.object({
  path: v.string(),
  sha256: v.string(),
  content: v.string(),
});

const vFetchedVersion = v.object({
  remoteId: v.string(),
  version: v.number(),
  description: v.string(),
  frontmatter: v.string(),
  files: v.array(vStoredFile),
});
type FetchedVersion = Infer<typeof vFetchedVersion>;

/** What one label GET gave. */
type LabelFetch =
  | { outcome: "ok"; skill: FetchedVersion; labels: string[] }
  | { outcome: "gone" }
  | { outcome: "failed"; error: string }
  | { outcome: "limited"; retryAfterMs?: number };

/**
 * One skill run. Every state change happens in `advance`, `store` and
 * `publish`, each fenced by `generation`; a superseded run stops.
 */
export const run = internalAction({
  args: { generation: v.number() },
  returns: v.null(),
  handler: async (ctx, { generation }) => {
    const config = exportConfig();
    if (!config) return null;
    let report: Report | undefined;
    // The name between its two GETs, with its `production` outcome.
    let pending: { name: string; production: Outcome } | undefined;
    for (;;) {
      const step: Step = await ctx.runMutation(internal.skills.advance, {
        generation,
        report,
        latestOf: pending?.name,
      });
      report = undefined;
      if (step.kind === "done") return null;
      if (step.kind === "wait") {
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        continue;
      }
      if (step.kind === "list") {
        const page = await fetchPage(config, step.page);
        report = {
          end: Date.now(),
          ...("limited" in page ? { limited: page.limited } : { page }),
        };
        continue;
      }
      const fetched = await fetchLabel(config, step.name, step.label);
      report = {
        end: Date.now(),
        ...(fetched.outcome === "limited"
          ? { limited: { retryAfterMs: fetched.retryAfterMs } }
          : {}),
      };
      let outcome: Outcome;
      if (fetched.outcome === "ok") {
        const versionId = await ctx.runMutation(internal.skills.store, {
          generation,
          name: step.name,
          ...fetched.skill,
        });
        if (versionId === null) return null;
        outcome = { outcome: "ok", versionId };
      } else if (fetched.outcome === "failed") {
        outcome = { outcome: "failed", error: fetched.error };
      } else {
        outcome = { outcome: fetched.outcome };
      }
      if (step.label === "latest") {
        if (pending?.name !== step.name) return null;
        await ctx.runMutation(internal.skills.publish, {
          generation,
          name: step.name,
          production: pending.production,
          latest: outcome,
        });
        pending = undefined;
        continue;
      }
      // `latest` is fetched unless the `production` response holds it, so a
      // 404 or a refused `production` version still refreshes `latest`. A
      // 429 ends the refresh.
      const holdsLatest =
        fetched.outcome === "ok" && fetched.labels.includes("latest");
      if (
        fetched.outcome === "gone" ||
        fetched.outcome === "failed" ||
        (fetched.outcome === "ok" && !holdsLatest)
      ) {
        pending = { name: step.name, production: outcome };
        continue;
      }
      await ctx.runMutation(internal.skills.publish, {
        generation,
        name: step.name,
        production: outcome,
        ...(holdsLatest ? { latest: outcome } : {}),
      });
    }
  },
});

// ── Fetch ──────────────────────────────────────────────────────────────────

/** A JSON response, or what went wrong as a fixed code. */
type Fetched =
  | { ok: true; body: unknown }
  | { ok: false; status?: number; retryAfterMs?: number; error: string };

/**
 * The body as text, or `null` once it exceeds `MAX_SKILL_RESPONSE_BYTES`.
 * A larger `Content-Length` is refused before the body is read; otherwise
 * the body is read as a stream that is cancelled at the cap.
 */
async function boundedText(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("Content-Length") ?? 0);
  if (declared > MAX_SKILL_RESPONSE_BYTES) {
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
    if (bytes > MAX_SKILL_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** One GET to the public API with Basic auth, aborted after `PROMPT_TIMEOUT_MS`. */
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
      await response.body?.cancel();
      const retryAfterMs = parseRetryAfter(
        response.headers.get("Retry-After"),
        Date.now(),
      );
      return {
        ok: false,
        status: response.status,
        error: `http_${response.status}`,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    const text = await boundedText(response);
    if (text === null) return { ok: false, error: "skill_too_large" };
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

const encoder = new TextEncoder();

/** Base64 SHA-256 of the UTF-8 text, as Langfuse's `sha256Hash`. */
async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** A normalized relative POSIX path of at most `MAX_SKILL_PATH_LENGTH`. */
function isSkillPath(path: string): boolean {
  return (
    path.length >= 1 &&
    path.length <= MAX_SKILL_PATH_LENGTH &&
    !path.includes("\\") &&
    ![...path].some((char) => char <= "\u001f" || char === "\u007f") &&
    !hasLoneSurrogate(path) &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** Whether `value` nests at most `levels` objects and arrays deep. */
function nestsWithin(value: unknown, levels: number): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (levels === 0) return false;
  return Object.values(value).every((item) => nestsWithin(item, levels - 1));
}

/**
 * The version in a `GET /api/public/skills/{name}` body, checked against the
 * subset the cache accepts, or a fixed code: `skill_too_large` for more than
 * `MAX_SKILL_FILES` files, more than `MAX_SKILL_BYTES` of content or a
 * frontmatter over `MAX_SKILL_FRONTMATTER_BYTES`, `invalid_skill` for any
 * other mismatch. Nothing of a refused version is stored.
 */
async function parseSkill(
  name: string,
  body: unknown,
): Promise<
  | { ok: true; skill: FetchedVersion; labels: string[] }
  | { ok: false; error: "invalid_skill" | "skill_too_large" }
> {
  const invalid = { ok: false, error: "invalid_skill" } as const;
  const tooLarge = { ok: false, error: "skill_too_large" } as const;
  if (!isRecord(body) || body.name !== name) return invalid;
  const { id, version, description, frontmatter, labels, files } = body;
  if (
    typeof id !== "string" ||
    id === "" ||
    hasLoneSurrogate(id) ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof description !== "string" ||
    description.length > MAX_SKILL_DESCRIPTION_LENGTH ||
    hasLoneSurrogate(description) ||
    !Array.isArray(labels) ||
    !labels.every((label) => typeof label === "string") ||
    !isRecord(frontmatter) ||
    !Array.isArray(files) ||
    files.length === 0
  ) {
    return invalid;
  }
  if (!nestsWithin(frontmatter, MAX_SKILL_FRONTMATTER_DEPTH)) return invalid;
  const canonical = canonicalJson(frontmatter);
  if (byteLength(canonical) > MAX_SKILL_FRONTMATTER_BYTES) return tooLarge;
  if (files.length > MAX_SKILL_FILES) return tooLarge;
  const stored: FetchedVersion["files"] = [];
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (!isRecord(file)) return invalid;
    const { path, content, sha256Hash } = file;
    if (
      typeof path !== "string" ||
      !isSkillPath(path) ||
      paths.has(path) ||
      typeof content !== "string" ||
      typeof sha256Hash !== "string" ||
      content.includes("\0") ||
      hasLoneSurrogate(content)
    ) {
      return invalid;
    }
    paths.add(path);
    bytes += byteLength(content);
    if (bytes > MAX_SKILL_BYTES) return tooLarge;
    if ((await sha256Base64(content)) !== sha256Hash) return invalid;
    stored.push({ path, sha256: sha256Hash, content });
  }
  if (!paths.has("SKILL.md")) return invalid;
  return {
    ok: true,
    skill: {
      remoteId: id,
      version,
      description,
      frontmatter: canonical,
      files: stored.sort((a, b) => compareStrings(a.path, b.path)),
    },
    labels,
  };
}

/** Fetches one label of `name` with its file contents. */
async function fetchLabel(
  config: ExportConfig,
  name: string,
  label: SkillLabel,
): Promise<LabelFetch> {
  const fetched = await getJson(
    config,
    `/api/public/skills/${encodeURIComponent(name)}?label=${label}&includeContent=true`,
  );
  if (!fetched.ok) {
    if (fetched.status === 404) return { outcome: "gone" };
    if (fetched.status === 429) {
      return { outcome: "limited", retryAfterMs: fetched.retryAfterMs };
    }
    return { outcome: "failed", error: fetched.error };
  }
  const parsed = await parseSkill(name, fetched.body);
  if (!parsed.ok) return { outcome: "failed", error: parsed.error };
  return { outcome: "ok", skill: parsed.skill, labels: parsed.labels };
}

/**
 * Fetches one page of `GET /api/public/skills`. Entries whose name Langfuse
 * cannot hold are skipped.
 */
async function fetchPage(
  config: ExportConfig,
  page: number,
): Promise<Page | { limited: { retryAfterMs?: number } }> {
  const fetched = await getJson(
    config,
    `/api/public/skills?page=${page}&limit=${SKILL_LIST_PAGE_LIMIT}`,
  );
  if (!fetched.ok) {
    if (fetched.status === 429) {
      return { limited: { retryAfterMs: fetched.retryAfterMs } };
    }
    return { ok: false, error: fetched.error };
  }
  const { body } = fetched;
  const invalid = { ok: false, error: "invalid_response" } as const;
  if (!isRecord(body) || !Array.isArray(body.data) || !isRecord(body.meta)) {
    return invalid;
  }
  const { hasNextPage } = body.meta;
  if (typeof hasNextPage !== "boolean") return invalid;
  const entries: ListEntry[] = [];
  for (const item of body.data as unknown[]) {
    if (!isRecord(item)) return invalid;
    const { name, latestVersion, productionVersion } = item;
    if (
      typeof name !== "string" ||
      typeof latestVersion !== "number" ||
      (productionVersion !== null && typeof productionVersion !== "number")
    ) {
      return invalid;
    }
    if (isSkillName(name)) {
      entries.push({ name, latestVersion, productionVersion });
    }
  }
  return { ok: true, entries, hasNextPage };
}

// ── Store and publish ──────────────────────────────────────────────────────

/** Whether the run of `generation` still holds the fetcher and the name. */
async function holdsClaim(
  ctx: QueryCtx,
  generation: number,
  name: string,
): Promise<Doc<"skillNames"> | null> {
  const fetcher = await getFetcher(ctx);
  if (fetcher?.generation !== generation) return null;
  const row = await nameRow(ctx, name);
  return row?.claimed?.generation === generation ? row : null;
}

/**
 * Stores one fetched version and returns its id. A version with the same
 * `remoteId` that the sweep is not deleting is reused; otherwise the version
 * and all its files are written in this one transaction, at most
 * `MAX_SKILL_BYTES` of content in `MAX_SKILL_FILES` + 1 documents, so a
 * stored version is always complete. Publishes nothing. Returns `null` and
 * stores nothing when `generation` no longer holds the name's claim.
 */
export const store = internalMutation({
  args: { generation: v.number(), name: v.string(), ...vFetchedVersion.fields },
  returns: v.union(v.id("skillVersions"), v.null()),
  handler: async (ctx, { generation, name, files, ...version }) => {
    if (!(await holdsClaim(ctx, generation, name))) return null;
    const existing = await ctx.db
      .query("skillVersions")
      .withIndex("by_remoteId", (q) => q.eq("remoteId", version.remoteId))
      .take(MAX_SKILL_VERSION_ROWS);
    const reused = existing.find((row) => !row.deleting);
    if (reused) return reused._id;
    const sorted = [...files].sort((a, b) => compareStrings(a.path, b.path));
    const id = await ctx.db.insert("skillVersions", {
      name,
      ...version,
      files: sorted.map(({ path, sha256 }) => ({ path, sha256 })),
      snapshotId: await sha256Hex(
        JSON.stringify(sorted.map(({ path, sha256 }) => [path, sha256])),
      ),
      storedAt: Date.now(),
    });
    for (const { path, content } of sorted) {
      await ctx.db.insert("skillFiles", { versionId: id, path, content });
    }
    return id;
  },
});

/**
 * Applies a name refresh in one transaction, so a reader sees both pointers
 * change at once. For each label, `ok` points it to the stored version, `gone`
 * removes it, and a failure or a 429 leaves it. A version gets `publishedAt`
 * on its first publication; `releasedAt` is set on a version no label
 * holds and cleared on one a label holds again. A failure adds to
 * `failures`, records `error` and makes the name eligible again after its
 * backoff, with a wake at that time, unless a newer request keeps its own
 * due time; a 429 leaves the request as it is.
 * After a refresh without failure, the request is cleared only when no
 * newer one raised `requested` since the claim. In mode `all`, a name that
 * answered 404 for both labels and has no newer request stops being
 * tracked, unless `sync({ names })` named it. Releases the claim on every
 * path; changes nothing when `generation` no longer holds it.
 */
export const publish = internalMutation({
  args: {
    generation: v.number(),
    name: v.string(),
    production: vOutcome,
    /** Absent when the `production` GET failed and `latest` was not fetched. */
    latest: v.optional(vOutcome),
  },
  returns: v.null(),
  handler: async (ctx, { generation, name, production, latest }) => {
    const row = await holdsClaim(ctx, generation, name);
    if (!row) return null;
    const now = Date.now();
    let failure: string | undefined;
    let limited = false;
    const touched = new Set<Id<"skillVersions">>();
    for (const [label, outcome] of [
      ["production", production],
      ["latest", latest],
    ] as const) {
      if (outcome === undefined) continue;
      const pointer = await labelRow(ctx, name, label);
      if (outcome.outcome === "failed") failure ??= outcome.error;
      if (outcome.outcome === "limited") limited = true;
      if (outcome.outcome === "gone" && pointer) {
        touched.add(pointer.versionId);
        await ctx.db.delete("skillLabels", pointer._id);
      }
      if (outcome.outcome !== "ok") continue;
      const version = await ctx.db.get("skillVersions", outcome.versionId);
      if (!version || version.deleting) {
        // The sweep took the version after `store`; the retry stores it anew.
        failure ??= "version_deleted";
        continue;
      }
      touched.add(version._id);
      const fields = {
        versionId: version._id,
        version: version.version,
        remoteId: version.remoteId,
      };
      if (!pointer) {
        await ctx.db.insert("skillLabels", { name, label, ...fields });
      } else if (pointer.versionId !== version._id) {
        touched.add(pointer.versionId);
        await ctx.db.patch("skillLabels", pointer._id, fields);
      }
    }
    const held = new Set<Id<"skillVersions">>();
    for (const label of ["production", "latest"] as const) {
      const pointer = await labelRow(ctx, name, label);
      if (pointer) held.add(pointer.versionId);
    }
    for (const id of touched) {
      const version = await ctx.db.get("skillVersions", id);
      if (!version) continue;
      const isHeld = held.has(id);
      if (isHeld && version.publishedAt === undefined) {
        await ctx.db.patch("skillVersions", id, {
          publishedAt: now,
          releasedAt: undefined,
        });
      } else if (isHeld && version.releasedAt !== undefined) {
        await ctx.db.patch("skillVersions", id, { releasedAt: undefined });
      } else if (!isHeld && version.releasedAt === undefined) {
        await ctx.db.patch("skillVersions", id, { releasedAt: now });
      }
    }

    if (failure !== undefined) {
      const failures = row.failures + 1;
      // A request newer than the claim keeps its own, earlier due time.
      if (row.requested !== row.claimed!.requested) {
        await ctx.db.patch("skillNames", row._id, {
          claimed: undefined,
          failures,
          error: failure,
        });
        return null;
      }
      const eligibleAt =
        now +
        SKILL_BACKOFF_MS[Math.min(failures, SKILL_BACKOFF_MS.length) - 1]!;
      await ctx.db.patch("skillNames", row._id, {
        claimed: undefined,
        failures,
        error: failure,
        eligibleAt,
        queuedAt: row.queuedAt ?? now,
      });
      await scheduleWake(ctx, eligibleAt);
      return null;
    }
    if (limited) {
      await ctx.db.patch("skillNames", row._id, { claimed: undefined });
      return null;
    }
    const served = row.requested === row.claimed!.requested;
    const gone = production.outcome === "gone" && latest?.outcome === "gone";
    if (served && gone && !row.watch && (await getSync(ctx))?.mode === "all") {
      await ctx.db.delete("skillNames", row._id);
      const slot = await ctx.db
        .query("skillSlots")
        .withIndex("by_name", (q) => q.eq("name", name))
        .unique();
      if (slot) await ctx.db.delete("skillSlots", slot._id);
      return null;
    }
    await ctx.db.patch("skillNames", row._id, {
      claimed: undefined,
      failures: 0,
      error: undefined,
      lastFullAt: now,
      ...(served
        ? { eligibleAt: undefined, queuedAt: undefined, priority: 1 as const }
        : {}),
    });
    return null;
  },
});

// ── Sweep ──────────────────────────────────────────────────────────────────

/**
 * Hourly, apart from `retention.sweep` and its budget. Marks expired
 * versions `deleting`: released for `SKILL_VERSION_WINDOW_MS`, or stored
 * without publication for `SKILL_UNPUBLISHED_GRACE_MS`, unless the live run
 * holds a claim on their name. Then deletes their files, at most
 * `RETENTION_BATCH` rows and `SKILL_SWEEP_BYTES` of content per run, and
 * each version row once its files are gone. A run that stops at a limit
 * schedules the next one at once; a version marked `deleting` is found
 * again by the same ranges, so an interrupted deletion resumes.
 */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const released = await ctx.db
      .query("skillVersions")
      .withIndex("by_releasedAt", (q) =>
        q.gte("releasedAt", 0).lte("releasedAt", now - SKILL_VERSION_WINDOW_MS),
      )
      .take(SKILL_SELECT_WINDOW);
    const unpublished = await ctx.db
      .query("skillVersions")
      .withIndex("by_publishedAt_storedAt", (q) =>
        q
          .eq("publishedAt", undefined)
          .lte("storedAt", now - SKILL_UNPUBLISHED_GRACE_MS),
      )
      .take(SKILL_SELECT_WINDOW);
    const fetcher = await getFetcher(ctx);
    const live =
      fetcher && leaseActive(fetcher, now) ? fetcher.generation : undefined;
    let rows = 0;
    let bytes = 0;
    let deleted = false;
    let stopped = false;
    for (const version of [...released, ...unpublished]) {
      if (
        rows >= RETENTION_BATCH ||
        bytes + MAX_SKILL_BYTES > SKILL_SWEEP_BYTES
      ) {
        stopped = true;
        break;
      }
      if (!version.deleting) {
        const claim = (await nameRow(ctx, version.name))?.claimed;
        if (live !== undefined && claim?.generation === live) continue;
        await ctx.db.patch("skillVersions", version._id, { deleting: true });
      }
      const files = await ctx.db
        .query("skillFiles")
        .withIndex("by_version", (q) => q.eq("versionId", version._id))
        .take(RETENTION_BATCH - rows);
      for (const file of files) {
        rows += 1;
        bytes += byteLength(file.content);
        await ctx.db.delete("skillFiles", file._id);
      }
      deleted ||= files.length > 0;
      const left = await ctx.db
        .query("skillFiles")
        .withIndex("by_version", (q) => q.eq("versionId", version._id))
        .first();
      if (left) {
        stopped = true;
        break;
      }
      await ctx.db.delete("skillVersions", version._id);
      deleted = true;
    }
    const full =
      released.length === SKILL_SELECT_WINDOW ||
      unpublished.length === SKILL_SELECT_WINDOW;
    if (stopped || (full && deleted)) {
      await ctx.scheduler.runAfter(0, internal.skills.sweep, {});
    }
    return null;
  },
});

// ── Health ─────────────────────────────────────────────────────────────────

export const vSkillHealth = v.object({
  tracked: v.number(),
  /** Tracked names whose last refresh failed. */
  errors: v.number(),
  /** Tracked names with a pending request: the backlog. */
  due: v.number(),
  /** When the oldest pending request was queued. */
  oldestDueAt: v.optional(v.number()),
  /** Set while a 429 pauses every skill request. */
  cooldownUntil: v.optional(v.number()),
  lastListAt: v.optional(v.number()),
  /** Fixed code of the last listing walk that ended early. */
  listError: v.optional(v.string()),
});

/** The skill part of `outbox.health`. */
export async function skillHealth(
  ctx: QueryCtx,
): Promise<Infer<typeof vSkillHealth>> {
  const now = Date.now();
  const names = await ctx.db.query("skillNames").take(HEALTH_COUNT_CAP);
  const oldest: number[] = [];
  for (const priority of [0, 1] as const) {
    const row = await ctx.db
      .query("skillNames")
      .withIndex("by_priority_queuedAt", (q) =>
        q.eq("priority", priority).gte("queuedAt", 0),
      )
      .first();
    if (row?.queuedAt !== undefined) oldest.push(row.queuedAt);
  }
  const fetcher = await getFetcher(ctx);
  const cooldownUntil = fetcher?.cooldownUntil;
  return {
    tracked: names.length,
    errors: names.filter((row) => row.error !== undefined).length,
    due: names.filter((row) => row.eligibleAt !== undefined).length,
    oldestDueAt: oldest.length > 0 ? Math.min(...oldest) : undefined,
    cooldownUntil:
      cooldownUntil !== undefined && cooldownUntil > now
        ? cooldownUntil
        : undefined,
    lastListAt: fetcher?.lastListAt,
    listError: fetcher?.listError,
  };
}
