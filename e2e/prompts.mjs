// End-to-end check of the prompt cache against a Langfuse instance.
//
//   npm run build
//   LANGFUSE_BASE_URL=... LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... \
//     node e2e/prompts.mjs [--await-webhook] [--out results.json]
//   node e2e/prompts.mjs --fake [--await-webhook]
//
// Deploys the host app in `e2e/convex` to the backend named by
// CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY, or to a local
// backend, and binds the Langfuse env through the app. `--fake` runs against
// `integration/fake-langfuse.mjs` instead of the env values.
//
// Creates a text prompt and a chat prompt through the public API, each with
// the label `production`, refreshes the cache for both, and checks that
// `prompts.get` returns the same type, content, config and version. Pins the
// text prompt for a scope. Creates a second version of both, refreshes again,
// checks the new versions, and checks that the pin still returns the first
// version.
//
// A refresh calls `prompts.sync` for the two names. With `--await-webhook`
// it calls nothing: after creating the versions it waits up to 120 s for
// `health.prompts.lastWebhookAt` to change and for the new versions to be
// cached, which proves that a webhook delivery reached the mounted route
// `<site url>/langfuse/prompt-webhook`. The webhook needs
// LANGFUSE_WEBHOOK_SECRET in the environment, which the script binds to the
// deployment; the instance must post prompt events to that route. With
// `--fake`, the fake endpoint posts them to the local backend itself.
//
// The run deletes both prompts through
// `DELETE /api/public/v2/prompts/{name}` at the end.

import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { convexCli, sleep, stopAll, waitFor } from "../integration/backend.mjs";
import {
  connectBackend,
  ENVIRONMENT,
  langfuseSettings,
  publicApi,
} from "./shared.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const api = anyApi.prompts;
const { convex, setEnv, linkPackage } = convexCli(HERE);

const { values: options } = parseArgs({
  options: {
    fake: { type: "boolean", default: false },
    "await-webhook": { type: "boolean", default: false },
    out: { type: "string" },
  },
});
const WEBHOOK_TIMEOUT_MS = 120_000;
const SYNC_TIMEOUT_MS = 60_000;

const suffix = randomUUID();
const TEXT = `${ENVIRONMENT}-text-${suffix}`;
const CHAT = `${ENVIRONMENT}-chat-${suffix}`;
const SCOPE = `${ENVIRONMENT}-scope-${suffix}`;

/** The content of version `n` of each prompt. */
const versions = (n) => ({
  [TEXT]: {
    type: "text",
    prompt: `Answer {{question}} in one sentence. Version ${n}.`,
    config: { temperature: n / 10 },
  },
  [CHAT]: {
    type: "chat",
    prompt: [
      { role: "system", content: `You answer in one sentence. Version ${n}.` },
      { role: "user", content: "{{question}}" },
    ],
    config: { model: `${ENVIRONMENT}-model`, version: n },
  },
});

/** JSON with object keys sorted, so equal values give equal strings. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** What differs between a cached prompt and the expected version. */
function differences(cached, expected, version) {
  if (!cached) return ["not cached"];
  const problems = [];
  if (cached.version !== version) problems.push(`version ${cached.version}`);
  if (cached.type !== expected.type) problems.push(`type ${cached.type}`);
  if (cached.source !== "langfuse") problems.push(`source ${cached.source}`);
  if (canonical(cached.prompt) !== canonical(expected.prompt)) {
    problems.push("content");
  }
  if (canonical(JSON.parse(cached.configJson)) !== canonical(expected.config)) {
    problems.push("config");
  }
  return problems;
}

async function main() {
  const settings = await langfuseSettings(options.fake);
  const langfuse = publicApi(settings);
  const webhook = options["await-webhook"];
  let webhookSecret = process.env.LANGFUSE_WEBHOOK_SECRET;
  if (webhook && options.fake) {
    webhookSecret = `lf-whsec_${randomBytes(32).toString("hex")}`;
  }
  if (webhook && !webhookSecret) {
    throw new Error("--await-webhook needs LANGFUSE_WEBHOOK_SECRET");
  }
  linkPackage();
  const { backend, cleanup } = await connectBackend();
  const checks = [];
  const created = new Set();
  let client;
  const record = (check, problems, passed) =>
    checks.push({
      check,
      ok: problems.length === 0,
      detail: problems.length === 0 ? passed : problems.join("; "),
    });
  try {
    await convex(backend, ["deploy", "--yes"]);
    const env = {
      LANGFUSE_PUBLIC_KEY: settings.publicKey,
      LANGFUSE_SECRET_KEY: settings.secretKey,
      LANGFUSE_BASE_URL: settings.baseUrl,
      ...(webhook ? { LANGFUSE_WEBHOOK_SECRET: webhookSecret } : {}),
    };
    for (const [name, value] of Object.entries(env)) {
      await setEnv(backend, name, value);
    }
    if (webhook && options.fake) {
      if (!backend.siteUrl) {
        throw new Error("--fake --await-webhook needs the local backend");
      }
      await settings.fake.webhook({
        url: `${backend.siteUrl}/langfuse/prompt-webhook`,
        secret: webhookSecret,
      });
    }
    client = new ConvexHttpClient(backend.url);

    /** Creates version `n` of both prompts with the label `production`. */
    const createVersion = async (n) => {
      for (const [name, body] of Object.entries(versions(n))) {
        created.add(name);
        const response = await langfuse.send("POST", "/api/public/v2/prompts", {
          name,
          ...body,
          labels: ["production"],
        });
        if (response.status !== 201 && response.status !== 200) {
          throw new Error(`creating ${name} v${n}: HTTP ${response.status}`);
        }
        const { version } = await response.json();
        if (version !== n) {
          throw new Error(`created ${name} as version ${version}, not ${n}`);
        }
      }
    };

    /**
     * Refreshes the cache after version `n` was created and waits until both
     * prompts are cached at version `n`. Returns the problems left.
     */
    const refresh = async (n, webhookBefore) => {
      const startedAt = Date.now();
      if (webhook) {
        const changed = await waitFor(
          "a webhook delivery",
          async () =>
            ((await client.query(api.lastWebhookAt, {})) ?? 0) >
            (webhookBefore ?? 0),
          WEBHOOK_TIMEOUT_MS,
          1_000,
        ).then(
          () => true,
          () => false,
        );
        if (!changed) {
          return [
            `lastWebhookAt unchanged after ${WEBHOOK_TIMEOUT_MS / 1_000} s`,
          ];
        }
      } else {
        const result = await client.action(api.sync, { names: [TEXT, CHAT] });
        if (result.status !== "ok" || result.tracked !== 2) {
          return [`sync returned ${JSON.stringify(result)}`];
        }
      }
      const deadline =
        startedAt + (webhook ? WEBHOOK_TIMEOUT_MS : SYNC_TIMEOUT_MS);
      let problems;
      for (;;) {
        problems = [];
        for (const [name, expected] of Object.entries(versions(n))) {
          const cached = await client.query(api.get, { name });
          for (const problem of differences(cached, expected, n)) {
            problems.push(`${name === TEXT ? "text" : "chat"}: ${problem}`);
          }
        }
        if (problems.length === 0 || Date.now() > deadline) return problems;
        await sleep(1_000);
      }
    };

    const how = webhook ? "a webhook delivery" : "prompts.sync";
    let webhookBefore = await client.query(api.lastWebhookAt, {});
    await createVersion(1);
    record(
      `version 1 of a text and a chat prompt cached through ${how}`,
      await refresh(1, webhookBefore),
      "type, content, config and version match",
    );
    const pinned = await client.mutation(api.pin, { scope: SCOPE, name: TEXT });
    record(
      "pin returns version 1",
      differences(pinned, versions(1)[TEXT], 1),
      `scope ${SCOPE}`,
    );

    webhookBefore = await client.query(api.lastWebhookAt, {});
    await createVersion(2);
    record(
      `version 2 of both prompts cached through ${how}`,
      await refresh(2, webhookBefore),
      "type, content, config and version match",
    );
    const repinned = await client.mutation(api.pin, {
      scope: SCOPE,
      name: TEXT,
    });
    record(
      "pin keeps version 1 after version 2",
      differences(repinned, versions(1)[TEXT], 1),
      "the pinned scope returns version 1",
    );
  } catch (error) {
    checks.push({
      check: "run",
      ok: false,
      detail: String(error?.message ?? error),
    });
  } finally {
    const failedDeletes = [];
    for (const name of created) {
      try {
        const response = await langfuse.send(
          "DELETE",
          `/api/public/v2/prompts/${encodeURIComponent(name)}`,
        );
        if (!response.ok)
          failedDeletes.push(`${name}: HTTP ${response.status}`);
      } catch (error) {
        failedDeletes.push(`${name}: ${error?.message ?? error}`);
      }
    }
    record(
      "cleanup",
      failedDeletes,
      `${created.size} prompts deleted with every version`,
    );
    console.table(
      checks.map(({ check, ok, detail }) => ({
        check,
        result: ok ? "pass" : "FAIL",
        detail,
      })),
    );
    if (options.out) {
      writeFileSync(options.out, `${JSON.stringify({ checks }, null, 2)}\n`);
    }
    process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
    stopAll();
    await sleep(200);
    cleanup();
  }
}

try {
  await main();
} catch (error) {
  console.error(`e2e failed: ${error?.message ?? error}`);
  process.exitCode = 1;
  stopAll();
}
