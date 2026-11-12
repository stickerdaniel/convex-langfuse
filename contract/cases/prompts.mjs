// Cases for the prompt cache. Prompts are created and moved through
// Langfuse's public API; the cache is read through the client's
// `prompts.get` and `prompts.pin`, whose results are the oracle. The
// webhook case relies on the stack's prompt webhook, which Langfuse posts
// through the relay to the component's mounted route.

/** How long a refresh may take to reach the cache. */
const REFRESH_MS = 60_000;

/** Creates a prompt version through the public API and returns its body. */
async function createPrompt(langfuse, body) {
  const response = await langfuse.send("POST", "/api/public/v2/prompts", body);
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`creating ${body.name}: HTTP ${response.status}`);
  }
  return await response.json();
}

/** A cached prompt's fields a case compares; `snapshotId` is kept apart. */
const content = (prompt) =>
  Object.fromEntries(
    Object.entries(prompt).filter(([key]) => key !== "snapshotId"),
  );

/** The names, scope and snapshot the cache cases share, set by the first. */
const shared = {};

export default [
  {
    name: "prompt cache: sync, decoding, label move, pin and fallback",
    oracle: "client result",
    async run({
      runId,
      langfuse,
      action,
      mutation,
      query,
      poll,
      differences,
      expectNone,
    }) {
      const text = `contract-${runId}-text`;
      const chat = `contract-${runId}-chat`;
      const scope = `chat:${runId}`;
      Object.assign(shared, { text, scope });
      await createPrompt(langfuse, {
        name: text,
        type: "text",
        prompt: "Answer {{question}} briefly.",
        config: { temperature: 0.1 },
        labels: ["production"],
      });
      await createPrompt(langfuse, {
        name: chat,
        type: "chat",
        prompt: [
          { role: "system", content: "You answer briefly." },
          { type: "placeholder", name: "history" },
          { role: "user", content: "{{question}}" },
        ],
        config: { model: "small" },
        labels: ["production"],
      });
      expectNone(
        "sync result",
        differences(await action("syncPrompts", { names: [text, chat] }), {
          status: "ok",
          tracked: 2,
          overflow: 0,
        }),
      );
      const textV1 = {
        name: text,
        version: 1,
        source: "langfuse",
        type: "text",
        prompt: "Answer {{question}} briefly.",
        config: { temperature: 0.1 },
      };
      await poll(
        "text prompt version 1 cached",
        () => query("getPrompt", { name: text }),
        (prompt) => differences(prompt && content(prompt), textV1),
        REFRESH_MS,
      );
      await poll(
        "chat prompt version 1 cached and decoded",
        () => query("getPrompt", { name: chat }),
        (prompt) =>
          differences(prompt && content(prompt), {
            name: chat,
            version: 1,
            source: "langfuse",
            type: "chat",
            prompt: [
              { role: "system", content: "You answer briefly." },
              { type: "placeholder", name: "history" },
              { role: "user", content: "{{question}}" },
            ],
            config: { model: "small" },
          }),
        REFRESH_MS,
      );
      const pinned = await mutation("pinPrompt", { scope, name: text });
      expectNone("pin", differences(content(pinned), textV1));
      shared.pinnedSnapshot = pinned.snapshotId;

      // Version 2 is created without a label, then `production` moves to it.
      await createPrompt(langfuse, {
        name: text,
        type: "text",
        prompt: "Answer {{question}} in one sentence.",
        config: { temperature: 0.3 },
        labels: [],
      });
      const moved = await langfuse.send(
        "PATCH",
        `/api/public/v2/prompts/${encodeURIComponent(text)}/versions/2`,
        { newLabels: ["production"] },
      );
      if (!moved.ok) throw new Error(`label move: HTTP ${moved.status}`);
      await action("syncPrompts", { names: [text] });
      await poll(
        "the label move cached",
        () => query("getPrompt", { name: text }),
        (prompt) =>
          differences(prompt && content(prompt), {
            ...textV1,
            version: 2,
            prompt: "Answer {{question}} in one sentence.",
            config: { temperature: 0.3 },
          }),
        REFRESH_MS,
      );
      expectNone(
        "pin after the label move",
        differences(await mutation("pinPrompt", { scope, name: text }), pinned),
      );

      const missing = `contract-${runId}-missing`;
      const fallback = await mutation("pinPrompt", {
        scope,
        name: missing,
        fallback: { type: "text", prompt: "You are a helpful assistant." },
      });
      expectNone(
        "fallback pin",
        differences(content(fallback), {
          name: missing,
          source: "fallback",
          type: "text",
          prompt: "You are a helpful assistant.",
          config: {},
        }),
      );
      if ("version" in fallback) throw new Error("fallback pin has a version");
      return "text and chat decoded, version 2 after the move, pin kept version 1";
    },
  },

  {
    name: "prompt webhook delivery",
    oracle: "client result, recording proxy",
    async run({ runId, langfuse, query, proxy, poll, differences }) {
      // No `sync` names this prompt: only a delivery makes the cache fetch it.
      const name = `contract-${runId}-webhook`;
      const before = (await query("health", {})).prompts.lastWebhookAt ?? 0;
      const createdAt = Date.now();
      await createPrompt(langfuse, {
        name,
        type: "text",
        prompt: "Delivered by webhook.",
        labels: ["production"],
      });
      await poll(
        "a signed delivery accepted by the mounted route",
        () => query("health", {}),
        (health) =>
          (health.prompts.lastWebhookAt ?? 0) > before
            ? []
            : ["lastWebhookAt unchanged"],
        REFRESH_MS,
      );
      await poll(
        "the delivered prompt cached",
        () => query("getPrompt", { name }),
        (prompt) =>
          differences(prompt && content(prompt), {
            name,
            version: 1,
            source: "langfuse",
            type: "text",
            prompt: "Delivered by webhook.",
            config: {},
          }),
        REFRESH_MS,
      );
      // The cache's own listing would also find the prompt; it did not run.
      const listings = proxy.records.filter(
        (r) =>
          r.at >= createdAt &&
          /^\/api\/public\/v2\/prompts\?page=/.test(r.path),
      );
      if (listings.length > 0) {
        throw new Error(
          `${listings.length} prompt listings since the creation`,
        );
      }
    },
  },

  {
    name: "prompt cache during an outage",
    oracle: "client result, recording proxy",
    async run({
      action,
      mutation,
      query,
      proxy,
      poll,
      differences,
      expectNone,
    }) {
      const { text, scope, pinnedSnapshot } = shared;
      if (!text) throw new Error("needs the prompt cache case before it");
      const cached = await query("getPrompt", { name: text });
      const { errors } = (await query("health", {})).prompts;
      const refusedFrom = proxy.records.length;
      proxy.refusePrompts(true);
      try {
        await action("syncPrompts", { names: [text] });
        await poll(
          "health shows the failed refresh",
          () => query("health", {}),
          (health) =>
            health.prompts.errors > errors
              ? []
              : [`${health.prompts.errors} names with an error`],
          REFRESH_MS,
        );
        const refused = proxy.records
          .slice(refusedFrom)
          .filter((r) => r.path.startsWith("/api/public/v2/prompts"));
        if (refused.length === 0 || refused.some((r) => r.status !== 503)) {
          throw new Error("the refresh did not meet the refusing proxy");
        }
        expectNone(
          "get during the outage",
          differences(await query("getPrompt", { name: text }), cached),
        );
        const pinned = await mutation("pinPrompt", { scope, name: text });
        expectNone(
          "pin during the outage",
          differences(pinned, { version: 1, snapshotId: pinnedSnapshot }),
        );
      } finally {
        proxy.refusePrompts(false);
      }
      return `version ${cached.version} served, pinned version 1 kept`;
    },
  },
];
