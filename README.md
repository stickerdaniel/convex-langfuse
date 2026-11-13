# convex-langfuse

**Export LLM traces from a Convex app to Langfuse through a transactional
outbox.** An observation is enqueued in the transaction of your mutation. The
exporter sends every enqueued observation until Langfuse accepts or rejects it,
for up to 72 hours.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

```ts
const langfuse = new Langfuse(components.convexLangfuse, { content: "full" });

export const saveAnswer = mutation({
  args: { chatId: v.id("chats"), prompt: v.string(), answer: v.string() },
  handler: async (ctx, args) => {
    const messageId = await ctx.db.insert("messages", {
      chatId: args.chatId,
      body: args.answer,
    });
    // Enqueued in this transaction: exported only if the message commits.
    await langfuse.trace({ seed: `chat:${args.chatId}` }).generation(ctx, {
      key: `answer:${messageId}`,
      name: "answer",
      model: "gpt-5",
      input: args.prompt,
      output: args.answer,
      usage: { input: 120, output: 340 },
    });
  },
});
```

This repository is a fork of
[sholajegede/convex-langfuse](https://github.com/sholajegede/convex-langfuse)
with a new architecture and a new API. Version 0.1.0 covers tracing, scores,
trace deletion and a prompt cache.

## How it works

1. A recording call encodes the observation once as an OTLP span and writes it
   to an outbox table. The write happens in the caller's transaction. In a
   mutation, the observation commits or rolls back with your own writes. Without
   the Langfuse keys, or while the outbox is full, the call stores nothing.
2. One exporter per deployment drains the outbox to
   `POST /api/public/otel/v1/traces` of your Langfuse project, at most 50 spans
   or 512 KiB per request.
3. The spans of a request that fails stay in the outbox. The exporter backs off,
   honours `Retry-After`, and sends each stored span again byte for byte, in a
   request that can hold other spans than the failed one.
4. A span that Langfuse rejects moves to a dead-letter table after the exporter
   isolated it from its batch. The rest of the batch is delivered.

Your functions never wait for Langfuse and never fail because Langfuse is down.

## Table of Contents

- [Requirements](#requirements)
- [Setup](#setup)
- [Recording](#recording)
- [Ids](#ids)
- [Scores](#scores)
- [Deleting traces](#deleting-traces)
- [Prompts](#prompts)
- [Skills](#skills)
- [Content and privacy](#content-and-privacy)
- [Errors](#errors)
- [Delivery](#delivery)
- [Limits](#limits)
- [Operations](#operations)
- [Compatibility](#compatibility)
- [Testing](#testing)
- [Example app](#example-app)
- [License](#license)

## Requirements

- Convex 1.47 or later.
- A Langfuse project on Langfuse Cloud or on a self-hosted Langfuse v4. The
  component sends OTLP/HTTP JSON with `x-langfuse-ingestion-version: 4`.

## Setup

```sh
npm install @stickerdaniel/convex-langfuse
```

The npm package `convex-langfuse` without the scope is the upstream project and
has a different API.

Add the component in `convex/convex.config.ts` and bind its settings to your
app's environment variables:

```ts
import { defineApp } from "convex/server";
import { v } from "convex/values";
import convexLangfuse from "@stickerdaniel/convex-langfuse/convex.config";

const app = defineApp({
  env: {
    LANGFUSE_PUBLIC_KEY: v.optional(v.string()),
    LANGFUSE_SECRET_KEY: v.optional(v.string()),
    LANGFUSE_BASE_URL: v.optional(v.string()),
    LANGFUSE_TRACING_ENVIRONMENT: v.optional(v.string()),
    LANGFUSE_RELEASE: v.optional(v.string()),
  },
});
app.use(convexLangfuse, {
  env: {
    LANGFUSE_PUBLIC_KEY: app.env.LANGFUSE_PUBLIC_KEY,
    LANGFUSE_SECRET_KEY: app.env.LANGFUSE_SECRET_KEY,
    LANGFUSE_BASE_URL: app.env.LANGFUSE_BASE_URL,
    LANGFUSE_TRACING_ENVIRONMENT: app.env.LANGFUSE_TRACING_ENVIRONMENT,
    LANGFUSE_RELEASE: app.env.LANGFUSE_RELEASE,
  },
});

export default app;
```

```bash
npx convex env set LANGFUSE_PUBLIC_KEY pk-lf-...
npx convex env set LANGFUSE_SECRET_KEY sk-lf-...
npx convex env set LANGFUSE_BASE_URL https://cloud.langfuse.com
```

| Variable                                     | Meaning                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | Project API keys. They stay inside the component.                                                                  |
| `LANGFUSE_BASE_URL`                          | Your region or your own host, for example `https://us.cloud.langfuse.com`. There is no default.                    |
| `LANGFUSE_TRACING_ENVIRONMENT`               | Environment for traces that set none: 1 to 40 lowercase letters, digits, `-` or `_`, not starting with `langfuse`. |
| `LANGFUSE_RELEASE`                           | Release for traces that set none.                                                                                  |
| `LANGFUSE_WEBHOOK_SECRET`                    | Signing secret of the Langfuse prompt webhook. See [Prompts](#prompts).                                            |
| `LANGFUSE_SKILL_WEBHOOK_SECRET`              | Signing secret of the Langfuse skill automation. See [Skills](#skills).                                            |

The component exports only when both keys and the base URL are set. Without them
a recording call writes nothing and returns, so a preview or test deployment
needs no Langfuse project.

Create the client once, for example in `convex/langfuse.ts`:

```ts
import { Langfuse } from "@stickerdaniel/convex-langfuse";
import { components } from "./_generated/api";

export const langfuse = new Langfuse(components.convexLangfuse, {
  content: "full",
});
```

`content` is required. See [Content and privacy](#content-and-privacy).

## Recording

`langfuse.trace(init)` returns a handle for one trace. Creating it does no work.
Every observation recorded through it carries the trace fields, because Langfuse
reads them from each span.

```ts
const trace = langfuse.trace({
  seed: `chat:${chatId}:turn:${turnId}`, // or traceId
  name: "chat-turn",
  userId,
  sessionId: chatId,
  tags: ["voice"],
  metadata: { plan: "pro" },
});
```

Record a finished LLM call, a unit of work, or a point in time. All three run in
mutations and in actions. A mutation enqueues in its own transaction. An action
has no transaction: each component call commits on its own, so a `record` that
needs several calls can enqueue the first and fail on a later one.

```ts
await trace.generation(ctx, {
  key: "llm",
  name: "answer",
  startTime,
  endTime,
  completionStartTime, // time to first token
  model: "gpt-5",
  modelParameters: { temperature: 0.2 },
  input: messages,
  output: completion,
  usage: { input: 120, output: 340, cache_read_input_tokens: 80 },
  cost: { input: 0.0003, output: 0.0034 },
  prompt: { name: "support-agent", version: 7 },
});

await trace.span(ctx, {
  key: "retrieval",
  parent: { key: "llm" },
  name: "vector-search",
  input: { query },
  output: { matches },
});

await trace.event(ctx, { key: "barge-in", name: "user interrupted" });
```

`trace.record` takes several observations of any Langfuse type (`span`,
`generation`, `event`, `embedding`, `agent`, `tool`, `chain`, `retriever`,
`guardrail`, `evaluator`) and sends them in as few component calls as the limits
allow:

```ts
await trace.record(ctx, [
  { type: "agent", key: "agent", name: "planner" },
  { type: "tool", key: "tool:1", parent: { key: "agent" }, name: "search" },
]);
```

Every method returns the ids: `{ traceId, observationId }`, or
`{ traceId, observationIds }` for `record`.

Notes on the fields:

- Times are epoch milliseconds. `startTime` defaults to now, `endTime` to
  `startTime`.
- `usage` keys are passed through. Values must be non-negative integers.
- `usage` and `cost` hold at most 1,024 entries each. A key has 1 to 1,024
  printable ASCII characters and starts with neither `$` nor `_`.
- `tags` are at most 8,192 strings.
- A string cut inside an emoji holds a lone surrogate, which Convex refuses. The
  client sends U+FFFD in its place.
- A `cost` with at least one usable entry replaces Langfuse's own pricing.
  Without one, Langfuse may infer a cost when its model table has a price for
  the model. Cost values are non-negative numbers.
- `prompt` links a generation to a prompt version in Langfuse; a link without a
  name or without a positive integer version is left out. Other observation
  types ignore it.
- `environment` and `release` on the trace override the component's defaults.
- `experiment` on the trace attaches its observations to a Langfuse experiment
  run.

## Ids

Seeds and keys make ids deterministic, so a retry or a second writer names the
same trace and the same observation without a lookup:

- `seed` gives the trace id: the first 32 hex characters of SHA-256 over the
  seed. This equals `createTraceId(seed)` of the Langfuse SDK, so another
  service that uses the SDK with the same seed writes into the same trace.
- `key` gives the observation id: the first 16 hex characters of SHA-256 over
  `<traceId>:<key>`.

Pass `traceId` or `id` instead when you already hold ids, for example W3C trace
context from another service. `@stickerdaniel/convex-langfuse/ids` exports
`traceIdFromSeed` and `observationIdFromKey` without the client, for a service
outside Convex.

A key recorded twice gives two rows in Langfuse. Record from an idempotent
mutation, or put the attempt into the key.

## Scores

Declare the score names once. `score` then accepts only these names, with values
of their type:

```ts
import { defineScores, Langfuse } from "@stickerdaniel/convex-langfuse";
import { components } from "./_generated/api";

const scores = defineScores({
  helpful: { dataType: "BOOLEAN" },
  rating: { dataType: "NUMERIC", min: 1, max: 5 },
  tone: { dataType: "CATEGORICAL", categories: ["formal", "casual"] },
});

export const langfuse = new Langfuse(components.convexLangfuse, {
  content: "full",
  scores,
});
```

Record a score in a mutation, for example behind a feedback button:

```ts
export const rate = mutation({
  args: { messageId: v.id("messages"), helpful: v.boolean() },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error("unknown message");
    await ctx.db.patch(args.messageId, { helpful: args.helpful });
    await langfuse.score(ctx, {
      name: "helpful",
      value: args.helpful,
      trace: { seed: `chat:${message.chatId}` },
      observation: { key: `answer:${args.messageId}` },
      id: `helpful:${args.messageId}`,
      timestamp: message._creationTime,
    });
  },
});
```

- With an `id` and its `timestamp`, a later write with the same pair overwrites
  the score in Langfuse. Without an `id`, the id is a new UUID and the timestamp
  is now.
- `langfuse.deleteScore(ctx, { id })` asks Langfuse to delete a score. A
  self-hosted Langfuse applies one score deletion per 120 seconds by default
  (`LANGFUSE_SCORE_DELETE_CONCURRENCY` per
  `LANGFUSE_CLICKHOUSE_TRACE_DELETION_CONCURRENCY_DURATION_MS`). Deleting a
  trace deletes its scores in one step.
- A write or a deletion replaces an operation of the same id that still waits.
  Operations of one id are sent one at a time, the next one at least 30 seconds
  after Langfuse accepted the one before. Langfuse applies a write
  asynchronously, around midnight UTC after a queue delay of 15 seconds.
- Langfuse does not order two operations on one id, so the value it finally
  stores is not guaranteed. Keep your own record of a rating as the source of
  truth, as the example does.
- `langfuse.syncScoreConfigs(ctx)`, called from an action, creates a Langfuse
  score config for every defined name that has none and lets the component
  attach the config ids. Run it after you deploy changed definitions; until
  then, a score of a changed definition is sent without a config id. The
  component repeats the sync every hour.
- A defined name follows Langfuse's rule for a score config: 1 to 80 letters,
  digits, spaces or `_`, `.`, `(`, `)`, `-`. A category label is not empty.
- Without the `scores` option, `score` takes any name with a boolean, a number
  or a string.

## Deleting traces

```ts
await langfuse.deleteTraces(ctx, {
  traces: [{ seed: `chat:${chatId}` }],
});
```

- The request is recorded in the caller's transaction and sent at least once,
  after the observations and score writes that were enqueued before it. The
  component does not verify that Langfuse completed the erasure.
- `deleteTraces` ignores `onError`. On an enabled component every failure
  throws, so a purge mutation rolls back with it. On a disabled component it
  returns `{ enqueued: false, reason: "disabled" }`.
- A deletion request passes a closed backlog gate and never expires. At most
  1,000 requests can be pending, counting the ones Langfuse rejected, which stay
  in the dead letters. The next one throws.

## Prompts

The component keeps a cache of your Langfuse prompts in Convex. A read never
calls Langfuse.

```ts
export const supportPrompt = query({
  args: {},
  handler: async (ctx) =>
    await langfuse.prompts.get(ctx, { name: "support-agent" }),
});
// { name, version, type: "text" | "chat", prompt, config, source, snapshotId }
```

`get` takes a `label`, `production` by default, or a `version`. A version is
served as the last refresh resolved it, while a label or a pin still holds that
snapshot. `get` returns `null` on a miss. Called from a query it is reactive:
the query reruns when the label moves.

Pin a prompt for a conversation, so every turn uses the same bytes:

```ts
const prompt = await langfuse.prompts.pin(ctx, {
  scope: `chat:${chatId}`,
  name: "support-agent",
  fallback: { type: "text", prompt: "You are a helpful assistant." },
});

await trace.generation(ctx, {
  key: "llm",
  name: "answer",
  input,
  output,
  prompt:
    prompt?.source === "langfuse"
      ? { name: prompt.name, version: prompt.version }
      : undefined,
});
```

- The first `pin` for a scope and a name resolves like `get` and stores the
  result for 7 days, or for `ttlMs`. Later calls return the same snapshot,
  whatever label, version or fallback they pass.
- On a miss, `pin` stores the `fallback` as a snapshot with
  `source: "fallback"`. Link a generation to a prompt only when the source is
  `"langfuse"`.
- Equal `snapshotId` values mean equal bytes.
- The component does not compile templates. Fill the variables of `prompt` at
  the call site.
- A prompt name and a scope have at most 256 bytes each. `get` returns `null`
  for a longer name, `pin` and `sync` throw `invalid_prompt_name`, and `pin`
  throws `invalid_prompt_scope` for a longer scope. A name, label or scope that
  holds a lone surrogate throws `invalid_prompt_name`, `invalid_prompt_selector`
  or `invalid_prompt_scope` as a `ConvexError`.

Turn the cache on once, from an action:

```ts
export const syncPrompts = internalAction({
  args: {},
  handler: async (ctx) => await langfuse.prompts.sync(ctx),
});
```

`sync` returns how many prompt names it tracks. Its status is `incomplete` when
the listing did not reach every prompt. One listing reads at most 5,000 names in
at most 150 requests; `sync` with `names` tracks prompts beyond that. A prompt
whose latest config alone exceeds 6 MiB cannot be listed: it is not discovered,
and a version of it that is cached already stays as it is, with an error in
`health`.

After that the cache follows Langfuse in two ways. Every 5 minutes a rolling
refresh schedules each prompt whose last attempt is 13 minutes old, 200 ms
apart. A webhook refreshes a prompt, and the prompts that reference it, when it
changes. A prompt tracks at most 32 referenced prompts for the webhook; the
rolling refresh covers the rest. To set up the webhook:

1. Mount the component with an HTTP prefix and bind the webhook secret:

   ```ts
   app.use(convexLangfuse, {
     httpPrefix: "/langfuse/",
     env: {
       // ...the settings from Setup
       LANGFUSE_WEBHOOK_SECRET: app.env.LANGFUSE_WEBHOOK_SECRET,
     },
   });
   ```

2. In Langfuse, add a webhook for prompt events with the URL
   `https://<deployment>.convex.site/langfuse/prompt-webhook`.
3. Store the signing secret Langfuse shows:
   `npx convex env set LANGFUSE_WEBHOOK_SECRET lf-whsec_...`.

The route verifies the signature and refuses a delivery older than 5 minutes.
Without the secret it answers 404.

## Skills

The component keeps a cache of your Langfuse skills in Convex: the `production`
and the `latest` version of each tracked skill, with the content of every file.
A read never calls Langfuse.

```ts
export const weatherSkill = query({
  args: {},
  handler: async (ctx) =>
    await langfuse.skills.get(ctx, { name: "weather-report" }),
});
// { name, version, description, frontmatter, files: [{ path, content }], snapshotId }
```

- `get` takes a `label`, `production` by default or `latest`, or a `version`. It
  returns `null` on a miss. Called from a query it is reactive: the query reruns
  when a refresh moves the label.
- `files` is sorted by path. `frontmatter` is the parsed frontmatter object.
- Equal `snapshotId` values mean equal file sets: the same paths with the same
  content hashes.
- `get({ version })` serves a version that a label holds or held within the last
  7 days, as last fetched. The window is no pin: it can serve a version that
  Langfuse deleted within it.
- The component does not run or compile skill files.
- A name outside `^[a-z0-9]+(?:-[a-z0-9]+)*$` or longer than 64 characters
  throws `invalid_skill_name`. A label and a version together throw
  `invalid_skill_selector`.

Turn the cache on from a mutation or an action:

```ts
export const syncSkills = internalMutation({
  args: {},
  handler: async (ctx) => await langfuse.skills.sync(ctx),
});
```

- `sync()` tracks every skill of the project from then on. New skills join
  through the webhook and the listing.
- `sync({ names })` adds these names. It never removes a name, and a name given
  here stays tracked while Langfuse has no such skill.
- Both return `{ status, tracked }` and refresh in the background, so content
  appears shortly after. `status` is `incomplete` when a name was not tracked
  because the cache tracks 500 names.

To set up the webhook:

1. Mount the component with an HTTP prefix and bind the skill secret:

   ```ts
   app.use(convexLangfuse, {
     httpPrefix: "/langfuse/",
     env: {
       // ...the settings from Setup
       LANGFUSE_SKILL_WEBHOOK_SECRET: app.env.LANGFUSE_SKILL_WEBHOOK_SECRET,
     },
   });
   ```

2. In Langfuse, add an automation for skill version events with a webhook action
   and the URL `https://<deployment>.convex.site/langfuse/skill-webhook`.
3. Store the signing secret of that automation:
   `npx convex env set LANGFUSE_SKILL_WEBHOOK_SECRET lf-whsec_...`. Every
   automation has a secret of its own, so the skill webhook and the prompt
   webhook use different secrets.

The route verifies the signature and refuses a delivery older than 5 minutes.
Without the secret it answers 404. A delivery only names the skill that changed;
the component fetches the skill itself.

### Freshness

- The component sends one skill request at a time, at least 2.5 s after the end
  of the previous one. Every skill endpoint counts toward the organization's
  `public-api` rate limit. Langfuse Cloud Hobby allows 30 requests per minute
  for the whole organization, Core and Pro 1,000.
- A refresh takes one or two GETs: `production`, then `latest` unless the same
  version holds both.
- With no backlog and no rate limit, a signed delivery is cached 2 s after it
  arrives plus one 2.5 s pause plus the two GETs, under 10 s for GETs under 1 s.
  Every request ahead of it adds 2.5 s.
- A 429 pauses every skill request for `Retry-After`, at least 5 s and at most
  15 minutes, 60 s without the header. A failed refresh runs again after 5 s, 30
  s, 2 minutes, then every 10 minutes.
- `health.skills` reports the backlog in `due` and `oldestDueAt`, a pause in
  `cooldownUntil`, failed refreshes in `errors`, and the listing in `lastListAt`
  and `listError`.

### Missed deliveries

- Every 15 minutes the component lists the project's skills, 100 per page, up to
  10 pages. A skill whose `production` or `latest` number differs from the cache
  is refreshed. In mode `all` a new skill is tracked. Only a listing that
  reached its last page refreshes the tracked skills it did not show; their 404s
  remove them from the cache, and in mode `all` they stop being tracked.
- Every tracked skill gets a refresh once a day. It catches a label move the
  listing cannot see, a version recreated under the same number, and changed
  content.
- Nothing catches the deletion of an old version without a label after a missed
  delivery: `get({ version })` serves it until its 7 days end.

### The cached subset

The cache stores a version that holds:

- 1 to 200 files with unique normalized relative paths of at most 512
  characters, one of them a root `SKILL.md`,
- at most 1,000,000 UTF-8 bytes of content in all, text without NUL, each file
  matching its `sha256Hash`,
- a frontmatter object of at most 64 KiB as JSON and at most 15 levels deep, and
  a description of at most 1,024 characters.

Langfuse lets a deployment raise its own file and byte limits. A version outside
this subset is refused: the cache keeps the version it had, and
`health.skills.errors` counts the skill.

## Content and privacy

```ts
new Langfuse(components.convexLangfuse, {
  content: "none",
  redact: (record) =>
    record.kind === "observation"
      ? { ...record, trace: { ...record.trace, userId: undefined } }
      : record,
  maxFieldBytes: 32_768,
});
```

- `content: "full"` exports `input`, `output`, `statusMessage` and score
  comments. `content: "none"` removes them before anything is stored. There is
  no default: every deployment states its choice.
- `redact` sees each record before it is serialized: an observation with its
  trace fields, or a score. It returns the record to export, or `null` to drop
  it. Names, tags, metadata and model parameters are yours to project here. The
  record and its `trace`, `observation` or `score` are shallow copies. Nested
  values such as `tags`, `input` or `metadata` are your own objects: return new
  ones instead of changing them in place.
- `input`, `output` and score comments are serialized with sorted keys. A longer
  value keeps its first `maxFieldBytes` UTF-8 bytes (default 131,072), cut on a
  character boundary, followed by `…[truncated <n> bytes]`. The marker comes on
  top of `maxFieldBytes`.
- Log lines of the client carry a code and ids, never field content or error
  text. An id you passed that is not a valid id is logged as an empty string. A
  score's log line carries the trace id only, because a score id can hold any
  text.

The order is fixed: `redact`, content mode, serialization, truncation. Content
that `redact` or `content: "none"` removes never reaches the outbox, the dead
letters or Langfuse.

## Errors

With `onError: "log"`, the default, a recording method never throws. It logs
`[convex-langfuse] <code>` and returns the ids. With `onError: "throw"` it
throws an `Error` whose message is the code, which rolls back a mutation.

| Code                  | Meaning                                                      | Record sent        |
| --------------------- | ------------------------------------------------------------ | ------------------ |
| `invalid_id`          | A trace id, observation id, seed or key is invalid           | no                 |
| `invalid_environment` | An environment name, your own or the default, is invalid     | no                 |
| `row_too_large`       | The encoded observation exceeds 900 KiB                      | no                 |
| `invalid_score`       | A score id, name or value is invalid                         | no                 |
| `score_too_large`     | The score exceeds 900 KiB                                    | no                 |
| `redact_failed`       | `redact` threw                                               | no                 |
| `backlog`             | The outbox is full, see [Delivery](#delivery)                | no                 |
| `enqueue_failed`      | The component call failed                                    | no                 |
| `unserializable`      | `input`, `output` or a JSON field cannot be serialized       | without that field |
| `invalid_metadata`    | Metadata or model parameters do not convert to a JSON object | without that field |
| `invalid_tags`        | The tags are not an array of at most 8,192 strings           | without the tags   |
| `invalid_usage`       | A usage entry has a bad key or value                         | without that entry |
| `invalid_usage`       | `usage` has more than 1,024 entries                          | without `usage`    |
| `invalid_cost`        | A cost entry has a bad key or value                          | without that entry |
| `invalid_cost`        | `cost` has more than 1,024 entries, or its sum is not finite | without `cost`     |
| `invalid_prompt`      | A prompt link lacks a name or a positive integer version     | without `prompt`   |

## Delivery

- **At least once.** The exporter sends an enqueued row until Langfuse answers
  2xx, the row becomes a dead letter, or it expires. Langfuse answers 2xx when
  it queued a batch. An accepted row leaves the outbox. The spans of a batch
  whose answer got lost are sent again, each byte for byte with its ids, in a
  request that can hold other spans. Langfuse can show a span it received twice
  as two observations until its background merge.
- **Order.** The exporter sends the oldest rows first. Langfuse places an
  observation by its ids and timestamps, not by its arrival.
- **Backoff.** Network errors, timeouts, 408, 425 and 5xx back off exponentially
  up to 5 minutes, or for the `Retry-After` time, and so does a 429 for
  observations or a score. A request with observations times out after 20 s, a
  score or deletion request after 10 s. 401 and 403 count as a configuration
  problem and back off up to 30 minutes, and so do 404, 405 and redirects for
  observations.
- **Rejections.** A 4xx for a batch makes the exporter send its rows one by one.
  A row rejected alone becomes a dead letter. After 20 consecutive dead letters
  the exporter treats the rejection as a configuration problem and stops
  discarding.
- **Scores and deletion requests.** Each one is a request of its own. A 404, a
  405 or a redirect from its endpoint delays only that request by 30 minutes. A
  429 for a deletion request delays only that request for the `Retry-After`
  time, at least 1 second and at most 1 day, or 1 minute without one.
  Observations behind it are still sent. Langfuse Cloud counts score and trace
  deletions per day and plan, each in a limit of its own
  ([API limits](https://langfuse.com/faq/all/api-limits)). Observations and
  scores share the ingestion limit, so a 429 for a score backs off like one for
  observations.
- **Backlog.** Above 25,000 pending observations and score operations or 256 MiB
  of pending payload the component stops accepting. Recording and score calls
  then log `backlog` and drop the record. It accepts again below half of both.
  Deletion requests pass a closed gate, up to their own limit.
- **Retention.** A pending observation or score older than 72 hours expires. A
  dead letter is deleted after 7 days. Deletion requests never expire.

## Limits

| Limit                                             | Value                                  |
| ------------------------------------------------- | -------------------------------------- |
| Encoded observation                               | 900 KiB                                |
| Observations per component call                   | 50, split by the client                |
| Encoded bytes per component call                  | 3 MiB, split by the client             |
| Kept part of a cut `input`, `output` or `comment` | `maxFieldBytes`, default 131,072 bytes |
| Tags per trace                                    | 8,192                                  |
| Entries of `usage` or `cost`                      | 1,024 each                             |
| Spans per export request                          | 50                                     |
| Bytes per export request                          | 512 KiB, a larger span goes alone      |
| Score id                                          | 1 to 128 bytes                         |
| Trace ids per deletion request                    | 100, split by the client               |
| Pending deletion requests, rejected ones included | 1,000                                  |
| Cached prompt names                               | 500                                    |
| Prompt name, pin scope                            | 256 bytes each                         |
| Labels per prompt name                            | 50                                     |
| Prompt snapshot                                   | 900 KiB                                |
| Cached skill names                                | 500                                    |
| Files per cached skill version                    | 200                                    |
| Content per cached skill version                  | 1,000,000 UTF-8 bytes                  |
| Skill API response                                | 8 MiB                                  |

## Operations

`langfuse.health(ctx)` returns the export state for a dashboard or an alert:

```ts
export const langfuseHealth = query({
  args: {},
  handler: async (ctx) => await langfuse.health(ctx),
});
```

| Field                                                                                                         | Meaning                                                            |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `enabled`                                                                                                     | Keys and base URL are set                                          |
| `accepting`                                                                                                   | The backlog gate is open                                           |
| `pendingAtLeast`, `oldestPendingAt`                                                                           | Rows in the outbox, counted up to 1,000, and the age of the oldest |
| `pendingCounted`                                                                                              | Pending rows and bytes as the gate counts them                     |
| `deadLettersAtLeast`                                                                                          | Dead letters, counted up to 1,000                                  |
| `exporter.backoffUntil`, `exporter.consecutiveFailures`, `exporter.lastError`                                 | Present while Langfuse fails                                       |
| `exporter.lastAcceptedAt`, `exporter.accepted`, `exporter.deadLettered`, `exporter.expired`                   | Progress counters                                                  |
| `prompts.tracked`, `prompts.errors`, `prompts.lastListAt`, `prompts.lastWebhookAt`, `prompts.oldestAttemptAt` | State of the prompt cache                                          |
| `skills.tracked`, `skills.errors`, `skills.due`, `skills.oldestDueAt`, `skills.cooldownUntil`                 | State of the skill cache                                           |
| `skills.lastListAt`, `skills.listError`                                                                       | The last skill listing, and why it ended early                     |

Two internal functions help after an incident. Run them from the dashboard or
the CLI:

```bash
# Clear a backoff and start the exporter now, for example after fixing the keys.
npx convex run --component convexLangfuse exporter:kick

# Move up to 500 dead letters back to the outbox: observations and trace
# deletion requests. Score dead letters are not retried.
npx convex run --component convexLangfuse outbox:retryDeadLetters '{"limit": 100}'
```

## Compatibility

| Dependency | Tested with                                                             |
| ---------- | ----------------------------------------------------------------------- |
| Convex     | `convex` 1.49.0 on the backend release `precompiled-2026-10-28-d1fcbea` |
| Langfuse   | 4.78.0, self-hosted, the images of `contract/supported.json`            |

A contract suite runs on every pull request. A host app on a real Convex backend
records through the client, the exporter delivers to a real Langfuse stack, and
the suite reads the result back through Langfuse's public API and compares it
with the values it recorded. It covers:

- ids from seeds and keys, parent links and the ten observation types,
- timestamps, model, usage keys with the derived total, and explicit costs,
- environment, release, session, user, tags and metadata,
- experiment items, and a trace that another producer joins,
- prompt links, also after the label moved to a newer version,
- scores of each type on a trace and on an observation, an update and a
  deletion,
- the prompt cache with a webhook delivered by Langfuse, and during an outage,
- `content: "none"`, a `redact` hook, and a record the hook drops,
- trace deletion, and a resend after a lost response.

A weekly run repeats the suite on the latest stable Langfuse release. With
`--cloud` the suite runs against Langfuse Cloud and a Convex Cloud deployment
(see `CONTRIBUTING.md`). It passed all 18 cases on Langfuse Cloud 4.79.0 on
2026-11-13. Langfuse Cloud applies deletions minutes later than the local stack,
so there the suite checks that Langfuse accepted each deletion request.

Observed on Langfuse 4.78.0:

- A span that was sent twice came back as two observations with the same id and
  the same recorded fields.
- A score metadata value that is a numeric string reads back as a number.
- Observation metadata also holds `scope.name`, `scope.version` and
  `resourceAttributes.service.name`.

## Testing

With [`convex-test`](https://www.npmjs.com/package/convex-test), register the
component and its child component in one call:

```ts
import { convexTest } from "convex-test";
import { register } from "@stickerdaniel/convex-langfuse/test";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

test("saves the answer and enqueues a generation", async () => {
  const t = convexTest(schema, modules);
  register(t);
  // ...
});
```

Without Langfuse settings in the test environment, recording calls write
nothing.

## Example app

`example/` is a Vite and React app that records into your own Langfuse project.
It saves a chat completion and its generation in one mutation, nests a step
under it, and shows the outbox state live.

```bash
npm install
npx convex env set LANGFUSE_PUBLIC_KEY pk-lf-...
npx convex env set LANGFUSE_SECRET_KEY sk-lf-...
npx convex env set LANGFUSE_BASE_URL https://cloud.langfuse.com
npm run dev
```

## License

Apache-2.0. Based on
[convex-langfuse](https://github.com/sholajegede/convex-langfuse) by Shola
Jegede. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CHANGELOG.md](./CHANGELOG.md).
