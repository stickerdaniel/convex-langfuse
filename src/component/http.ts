// HTTP routes of the component. An app exposes them by installing the
// component with an `httpPrefix`, for example `/langfuse/`, which serves the
// webhook at `<site url>/langfuse/prompt-webhook`.

import { httpRouter } from "convex/server";
import { internal } from "./_generated/api.js";
import { env, httpAction } from "./_generated/server.js";
import { WEBHOOK_TOLERANCE_MS } from "./constants.js";

const encoder = new TextEncoder();

/** HMAC-SHA256 of `message` keyed with `secret`, as lowercase hex. */
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Compares in time that depends on the length only. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether `header` (`t=<unix seconds>,v1=<hex>`) signs `body` with `secret`
 * the way Langfuse does, HMAC-SHA256 over `${t}.${body}`, with `t` at most
 * `WEBHOOK_TOLERANCE_MS` away from `now`.
 */
async function verifySignature(
  secret: string,
  header: string | null,
  body: string,
  now: number,
): Promise<boolean> {
  if (header === null) return false;
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }
  if (timestamp === undefined || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp) * 1_000) > WEBHOOK_TOLERANCE_MS) {
    return false;
  }
  const expected = await hmacHex(secret, `${timestamp}.${body}`);
  return signatures.some((signature) => constantTimeEqual(signature, expected));
}

/**
 * The prompt name of a `prompt-version` event, `null` for another event
 * type, `undefined` for a body that is not a webhook event.
 */
function promptName(body: string): string | null | undefined {
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof event !== "object" || event === null) return undefined;
  const { type, prompt } = event as { type?: unknown; prompt?: unknown };
  if (type !== "prompt-version")
    return typeof type === "string" ? null : undefined;
  const name = (prompt as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" && name !== "" ? name : undefined;
}

const http = httpRouter();

/**
 * Langfuse prompt webhook. Answers 404 while `LANGFUSE_WEBHOOK_SECRET` is
 * unset, 401 for a missing, wrong or stale signature, 400 for a signed body
 * that is not an event, and 200 with an empty body otherwise. A
 * `prompt-version` event requests a refresh of the prompt and of the
 * prompts that reference it; other event types are acknowledged and
 * ignored. Logs nothing, so neither body nor signature reaches the logs.
 */
http.route({
  path: "/prompt-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = env.LANGFUSE_WEBHOOK_SECRET;
    if (!secret) return new Response(null, { status: 404 });
    const body = await request.text();
    const signature = request.headers.get("x-langfuse-signature");
    if (!(await verifySignature(secret, signature, body, Date.now()))) {
      return new Response(null, { status: 401 });
    }
    const name = promptName(body);
    if (name === undefined) return new Response(null, { status: 400 });
    if (name !== null) {
      await ctx.runMutation(internal.prompts.webhook, { name });
    }
    return new Response(null, { status: 200 });
  }),
});

export default http;
