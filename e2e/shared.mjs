// Helpers of the end-to-end scripts: the Langfuse settings, the Convex
// backend and the public API.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Backend, ensureBinary, startFake } from "../integration/backend.mjs";

/** The environment every object of the scripts is created in. */
export const ENVIRONMENT = "convex-langfuse-e2e";

/**
 * The Langfuse base URL and key pair from `LANGFUSE_BASE_URL`,
 * `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`, or, with `fake`, those of
 * a started `integration/fake-langfuse.mjs`, which is returned as `fake`.
 */
export async function langfuseSettings(fake) {
  if (fake) {
    const server = await startFake();
    return {
      baseUrl: server.url,
      publicKey: "pk-lf-fake",
      secretKey: "sk-lf-fake",
      fake: server,
    };
  }
  const settings = {
    baseUrl: process.env.LANGFUSE_BASE_URL?.replace(/\/+$/, ""),
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
  };
  if (!settings.baseUrl || !settings.publicKey || !settings.secretKey) {
    throw new Error(
      "set LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY, or pass --fake",
    );
  }
  return settings;
}

/**
 * Requests to the Langfuse public API with the key pair. `get` throws on a
 * status other than 2xx and returns the JSON body; `send` returns the
 * response.
 */
export function publicApi({ baseUrl, publicKey, secretKey }) {
  const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
  return {
    async get(path) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: auth },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
      return await response.json();
    },
    async send(method, path, body) {
      return await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: auth, "Content-Type": "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
  };
}

/**
 * The backend named by CONVEX_SELF_HOSTED_URL and
 * CONVEX_SELF_HOSTED_ADMIN_KEY, or a local backend started like the
 * integration run. `siteUrl` is set for a local backend only.
 */
export async function connectBackend() {
  const url = process.env.CONVEX_SELF_HOSTED_URL;
  const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  if (url && adminKey) return { backend: { url, adminKey }, cleanup() {} };
  if (url || adminKey) {
    throw new Error(
      "set both CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY",
    );
  }
  const scratch = fileURLToPath(new URL("../scratch/", import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const stateDir = mkdtempSync(join(scratch, "e2e-"));
  const backend = new Backend(await ensureBinary(), stateDir);
  await backend.init();
  await backend.start();
  return {
    backend,
    cleanup: () => rmSync(stateDir, { recursive: true, force: true }),
  };
}
