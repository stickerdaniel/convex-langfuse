import { v, type Infer } from "convex/values";
import { Langfuse } from "@stickerdaniel/convex-langfuse";
import { components } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";

const langfuse = new Langfuse(components.convexLangfuse, {
  content: "full",
  onError: "throw",
});

const vCached = v.union(
  v.null(),
  v.object({
    version: v.optional(v.number()),
    type: v.union(v.literal("text"), v.literal("chat")),
    /** The text, or the chat message array. */
    prompt: v.union(
      v.string(),
      v.array(
        v.union(
          v.object({ role: v.string(), content: v.string() }),
          v.object({ type: v.literal("placeholder"), name: v.string() }),
        ),
      ),
    ),
    configJson: v.string(),
    source: v.union(v.literal("langfuse"), v.literal("fallback")),
  }),
);

/** The fields of a cached prompt the end-to-end run compares. */
function cached(
  prompt: Awaited<ReturnType<typeof langfuse.prompts.get>>,
): Infer<typeof vCached> {
  if (!prompt) return null;
  const { version, type, prompt: content, config, source } = prompt;
  return {
    version,
    type,
    prompt: content,
    configJson: JSON.stringify(config),
    source,
  };
}

/** Schedules a refresh of `names` and returns the counts. */
export const sync = action({
  args: { names: v.array(v.string()) },
  returns: v.object({
    status: v.string(),
    tracked: v.number(),
    overflow: v.number(),
  }),
  handler: async (ctx, { names }) =>
    await langfuse.prompts.sync(ctx, { names }),
});

/** The cached `production` prompt of `name`, or the cached `version`. */
export const get = query({
  args: { name: v.string(), version: v.optional(v.number()) },
  returns: vCached,
  handler: async (ctx, { name, version }) =>
    cached(
      await langfuse.prompts.get(
        ctx,
        version === undefined ? { name } : { name, version },
      ),
    ),
});

/** The `production` prompt of `name` pinned for `scope`. */
export const pin = mutation({
  args: { scope: v.string(), name: v.string() },
  returns: vCached,
  handler: async (ctx, { scope, name }) =>
    cached(await langfuse.prompts.pin(ctx, { scope, name })),
});

/** When the last verified webhook delivery arrived. */
export const lastWebhookAt = query({
  args: {},
  returns: v.union(v.null(), v.number()),
  handler: async (ctx) =>
    (await langfuse.health(ctx)).prompts.lastWebhookAt ?? null,
});
