import { env } from "./_generated/server.js";

/** Where and as whom the exporter sends. */
export type ExportConfig = {
  publicKey: string;
  secretKey: string;
  /** Without trailing slashes. */
  baseUrl: string;
};

/**
 * The export configuration from the component env, or `null` when the
 * component is disabled. It is enabled only when the public key, the secret
 * key and the base URL are all set and non-empty; there is no default base
 * URL. Env values exist only at runtime, so call this inside handlers.
 */
export function exportConfig(): ExportConfig | null {
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  const baseUrl = env.LANGFUSE_BASE_URL?.replace(/\/+$/, "");
  if (!publicKey || !secretKey || !baseUrl) return null;
  return { publicKey, secretKey, baseUrl };
}

/** The `Authorization` header value for the key pair. */
export function basicAuth({ publicKey, secretKey }: ExportConfig): string {
  const bytes = new TextEncoder().encode(`${publicKey}:${secretKey}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}
