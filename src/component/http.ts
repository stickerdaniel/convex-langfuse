// HTTP routes of the component. An app exposes them by installing the
// component with an `httpPrefix`, for example `/langfuse/`, which serves the
// webhooks at `<site url>/langfuse/prompt-webhook` and
// `<site url>/langfuse/skill-webhook`.

import { httpRouter, type FunctionReference } from "convex/server";
import { internal } from "./_generated/api.js";
import { env, httpAction } from "./_generated/server.js";
import { verifySignature } from "./signature.js";

/**
 * The name in the `field` object of an event of `type`, `null` for another
 * event type, `undefined` for a body that is not a webhook event.
 */
function eventName(
  body: string,
  type: "prompt-version" | "skill-version",
  field: "prompt" | "skill",
): string | null | undefined {
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof event !== "object" || event === null) return undefined;
  const fields = event as Record<string, unknown>;
  if (fields.type !== type) {
    return typeof fields.type === "string" ? null : undefined;
  }
  const name = (fields[field] as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" && name !== "" ? name : undefined;
}

/**
 * A webhook route for events of `type`. Answers 404 while `secret` is unset,
 * 401 for a missing, wrong or stale signature, 400 for a signed body that is
 * not an event, and 200 with an empty body otherwise. An event of `type`
 * runs `mutation` with the name in its `field`; other event types are
 * acknowledged and ignored. Logs nothing, so neither body nor signature
 * reaches the logs.
 */
function webhook(
  secret: () => string | undefined,
  type: "prompt-version" | "skill-version",
  field: "prompt" | "skill",
  mutation: FunctionReference<"mutation", "internal", { name: string }>,
) {
  return httpAction(async (ctx, request) => {
    const key = secret();
    if (!key) return new Response(null, { status: 404 });
    const body = await request.text();
    const signature = request.headers.get("x-langfuse-signature");
    if (!(await verifySignature(key, signature, body, Date.now()))) {
      return new Response(null, { status: 401 });
    }
    const name = eventName(body, type, field);
    if (name === undefined) return new Response(null, { status: 400 });
    if (name !== null) await ctx.runMutation(mutation, { name });
    return new Response(null, { status: 200 });
  });
}

const http = httpRouter();

/**
 * Langfuse prompt webhook, signed with `LANGFUSE_WEBHOOK_SECRET`. A
 * `prompt-version` event requests a refresh of the prompt and of the
 * prompts that reference it.
 */
http.route({
  path: "/prompt-webhook",
  method: "POST",
  handler: webhook(
    () => env.LANGFUSE_WEBHOOK_SECRET,
    "prompt-version",
    "prompt",
    internal.prompts.webhook,
  ),
});

/**
 * Langfuse skill webhook, signed with `LANGFUSE_SKILL_WEBHOOK_SECRET`, the
 * secret of the skill automation. A `skill-version` event requests a
 * refresh of the skill; the payload is not used as state.
 */
http.route({
  path: "/skill-webhook",
  method: "POST",
  handler: webhook(
    () => env.LANGFUSE_SKILL_WEBHOOK_SECRET,
    "skill-version",
    "skill",
    internal.skills.webhook,
  ),
});

export default http;
