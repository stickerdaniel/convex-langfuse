// Per-id state of score ops. At most one op per score id waits (`queued`)
// and at most one is in flight; an enqueue replaces the waiting op and never
// touches the one in flight. Every function here takes the outbox row of a
// score op and leaves rows of other kinds alone.

import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { SCORE_SETTLE_MS } from "./constants.js";
import type { Kind } from "./schema.js";

type Row = Doc<"outbox">;

export type ScoreKind = Extract<Kind, "scoreCreate" | "scoreDelete">;

export function isScoreKind(kind: Kind): kind is ScoreKind {
  return kind === "scoreCreate" || kind === "scoreDelete";
}

export async function getScoreKey(
  ctx: QueryCtx,
  scoreId: string,
): Promise<Doc<"scoreKeys"> | null> {
  return await ctx.db
    .query("scoreKeys")
    .withIndex("by_scoreId", (q) => q.eq("scoreId", scoreId))
    .first();
}

async function deleteRow(ctx: MutationCtx, row: Row): Promise<void> {
  await ctx.db.delete("payloads", row.payloadId);
  await ctx.db.delete("outbox", row._id);
}

/**
 * Enqueues one score op for `scoreId`. Deletes the op that waits for the
 * same id, if any, and makes the new one wait in its place. The new op
 * becomes available `SCORE_SETTLE_MS` after the last accepted op of the id,
 * or `SCORE_SETTLE_MS` from now while an op of the id is in flight.
 */
export async function enqueueScoreOp(
  ctx: MutationCtx,
  kind: ScoreKind,
  scoreId: string,
  data: string,
  bytes: number,
): Promise<void> {
  const now = Date.now();
  const key = await getScoreKey(ctx, scoreId);
  if (key?.queued !== undefined) {
    const queued = await ctx.db.get("outbox", key.queued);
    if (queued) await deleteRow(ctx, queued);
  }
  const availableAt =
    key?.inFlight !== undefined
      ? now + SCORE_SETTLE_MS
      : Math.max(now, (key?.lastAcceptedAt ?? 0) + SCORE_SETTLE_MS);
  const payloadId = await ctx.db.insert("payloads", { data });
  const queued = await ctx.db.insert("outbox", {
    kind,
    ref: scoreId,
    bytes,
    availableAt,
    payloadId,
  });
  if (key) {
    await ctx.db.patch("scoreKeys", key._id, { queued, updatedAt: now });
  } else {
    await ctx.db.insert("scoreKeys", { scoreId, queued, updatedAt: now });
  }
}

/** Claim: the op is in flight and no longer waits. */
export async function markInFlight(
  ctx: MutationCtx,
  row: Row,
  now: number,
): Promise<void> {
  if (!isScoreKind(row.kind)) return;
  const key = await getScoreKey(ctx, row.ref);
  if (!key) {
    await ctx.db.insert("scoreKeys", {
      scoreId: row.ref,
      inFlight: row._id,
      updatedAt: now,
    });
    return;
  }
  await ctx.db.patch("scoreKeys", key._id, {
    inFlight: row._id,
    ...(key.queued === row._id ? { queued: undefined } : {}),
    updatedAt: now,
  });
}

/**
 * Accepted: records the time and ends the flight. A waiting successor
 * becomes available `SCORE_SETTLE_MS` from now.
 */
export async function markAccepted(
  ctx: MutationCtx,
  row: Row,
  now: number,
): Promise<void> {
  if (!isScoreKind(row.kind)) return;
  const key = await getScoreKey(ctx, row.ref);
  if (!key) return;
  await ctx.db.patch("scoreKeys", key._id, {
    lastAcceptedAt: now,
    ...(key.inFlight === row._id ? { inFlight: undefined } : {}),
    updatedAt: now,
  });
  if (key.queued !== undefined && key.queued !== row._id) {
    const successor = await ctx.db.get("outbox", key.queued);
    if (successor) {
      await ctx.db.patch("outbox", successor._id, {
        availableAt: now + SCORE_SETTLE_MS,
      });
    }
  }
}

/**
 * Failed without a verdict (transient, config, deferred, or a run that
 * died): ends the flight. A waiting successor supersedes the op, which is
 * deleted with its payload; otherwise the op waits again. Returns whether
 * the op was deleted.
 */
export async function markFailed(
  ctx: MutationCtx,
  row: Row,
  now: number,
): Promise<boolean> {
  if (!isScoreKind(row.kind)) return false;
  const key = await getScoreKey(ctx, row.ref);
  const flight = key?.inFlight === row._id ? { inFlight: undefined } : {};
  if (key?.queued !== undefined && key.queued !== row._id) {
    await deleteRow(ctx, row);
    await ctx.db.patch("scoreKeys", key._id, { ...flight, updatedAt: now });
    return true;
  }
  if (key) {
    await ctx.db.patch("scoreKeys", key._id, {
      ...flight,
      queued: row._id,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("scoreKeys", {
      scoreId: row.ref,
      queued: row._id,
      updatedAt: now,
    });
  }
  return false;
}

/**
 * The op left the outbox without being sent again: rejected into a dead
 * letter, expired, or found without its payload. Clears whichever pointer
 * names it.
 */
export async function forgetOp(
  ctx: MutationCtx,
  row: Row,
  now: number,
): Promise<void> {
  if (!isScoreKind(row.kind)) return;
  const key = await getScoreKey(ctx, row.ref);
  if (!key || (key.queued !== row._id && key.inFlight !== row._id)) return;
  await ctx.db.patch("scoreKeys", key._id, {
    ...(key.queued === row._id ? { queued: undefined } : {}),
    ...(key.inFlight === row._id ? { inFlight: undefined } : {}),
    updatedAt: now,
  });
}
