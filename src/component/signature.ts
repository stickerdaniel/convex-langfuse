// The signature check of Langfuse webhooks, shared by the prompt and the
// skill route.

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
export async function verifySignature(
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
