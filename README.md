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
with a new architecture and a new API. Version 0.1.0 covers tracing. Scores,
trace deletion and prompt management are in progress.

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
- [Content and privacy](#content-and-privacy)
- [Errors](#errors)
- [Delivery](#delivery)
- [Limits](#limits)
- [Operations](#operations)
- [Testing](#testing)
- [Example app](#example-app)
- [License](#license)

## Requirements

- Convex 1.47 or later.
- A Langfuse project on Langfuse Cloud or on a self-hosted Langfuse v4. The
  component sends OTLP/HTTP JSON with `x-langfuse-ingestion-version: 4`.

## Setup

This fork has no npm release yet. The npm package `convex-langfuse` is the
upstream project and has a different API.

Add the component in `convex/convex.config.ts` and bind its settings to your
app's environment variables:

```ts
import { defineApp } from "convex/server";
import { v } from "convex/values";
import convexLangfuse from "convex-langfuse/convex.config";

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

The component exports only when both keys and the base URL are set. Without them
a recording call writes nothing and returns, so a preview or test deployment
needs no Langfuse project.

Create the client once, for example in `convex/langfuse.ts`:

```ts
import { Langfuse } from "convex-langfuse";
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
- With `cost` set, Langfuse uses your numbers and infers nothing from the model
  name. Without it, Langfuse prices the usage from its model table.
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
context from another service. `convex-langfuse/ids` exports `traceIdFromSeed`
and `observationIdFromKey` without the client, for a service outside Convex.

A key recorded twice gives two rows in Langfuse. Record from an idempotent
mutation, or put the attempt into the key.

## Content and privacy

```ts
new Langfuse(components.convexLangfuse, {
  content: "none",
  redact: (record) => ({
    ...record,
    trace: { ...record.trace, userId: undefined },
  }),
  maxFieldBytes: 32_768,
});
```

- `content: "full"` exports `input`, `output` and `statusMessage`.
  `content: "none"` removes them before anything is stored. There is no default:
  every deployment states its choice.
- `redact` sees each record before it is serialized. It returns the record to
  export, or `null` to drop it. Names, tags, metadata and model parameters are
  yours to project here. The record, its `trace` and its `observation` are
  shallow copies. Nested values such as `tags`, `input` or `metadata` are your
  own objects: return new ones instead of changing them in place.
- `input` and `output` are serialized with sorted keys. A longer value keeps its
  first `maxFieldBytes` UTF-8 bytes (default 131,072), cut on a character
  boundary, followed by `…[truncated <n> bytes]`. The marker comes on top of
  `maxFieldBytes`.
- Log lines of the client carry a code and ids, never field content or error
  text. An id you passed that is not a valid id is logged as an empty string.

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
| `invalid_environment` | The environment name breaks Langfuse's rule                  | no                 |
| `row_too_large`       | The encoded observation exceeds 900 KiB                      | no                 |
| `redact_failed`       | `redact` threw                                               | no                 |
| `backlog`             | The outbox is full, see [Delivery](#delivery)                | no                 |
| `enqueue_failed`      | The component call failed                                    | no                 |
| `unserializable`      | `input`, `output` or a JSON field cannot be serialized       | without that field |
| `invalid_metadata`    | A metadata or model-parameter value is not a plain object    | without that field |
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
  request that can hold other spans.
- **Order.** The exporter sends the oldest rows first. Langfuse places an
  observation by its ids and timestamps, not by its arrival.
- **Backoff.** Network errors, timeouts after 20 s, 408, 425, 429 and 5xx back
  off exponentially up to 5 minutes, or for the `Retry-After` time. 401, 403,
  404, 405 and redirects count as a configuration problem and back off up to 30
  minutes.
- **Rejections.** A 4xx for a batch makes the exporter send its rows one by one.
  A row rejected alone becomes a dead letter. After 20 consecutive dead letters
  the exporter treats the rejection as a configuration problem and stops
  discarding.
- **Backlog.** Above 25,000 pending observations or 256 MiB of pending payload
  the component stops accepting. Recording calls then log `backlog` and drop the
  record. It accepts again below half of both.
- **Retention.** A pending row older than 72 hours expires. A dead letter is
  deleted after 7 days.

## Limits

| Limit                                  | Value                                  |
| -------------------------------------- | -------------------------------------- |
| Encoded observation                    | 900 KiB                                |
| Observations per component call        | 50, split by the client                |
| Encoded bytes per component call       | 3 MiB, split by the client             |
| Kept part of a cut `input` or `output` | `maxFieldBytes`, default 131,072 bytes |
| Tags per trace                         | 8,192                                  |
| Entries of `usage` or `cost`           | 1,024 each                             |
| Spans per export request               | 50                                     |
| Bytes per export request               | 512 KiB, a larger span goes alone      |

## Operations

`langfuse.health(ctx)` returns the export state for a dashboard or an alert:

```ts
export const langfuseHealth = query({
  args: {},
  handler: async (ctx) => await langfuse.health(ctx),
});
```

| Field                                                                                       | Meaning                                                            |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `enabled`                                                                                   | Keys and base URL are set                                          |
| `accepting`                                                                                 | The backlog gate is open                                           |
| `pendingAtLeast`, `oldestPendingAt`                                                         | Rows in the outbox, counted up to 1,000, and the age of the oldest |
| `pendingCounted`                                                                            | Pending rows and bytes as the gate counts them                     |
| `deadLettersAtLeast`                                                                        | Dead letters, counted up to 1,000                                  |
| `exporter.backoffUntil`, `exporter.consecutiveFailures`, `exporter.lastError`               | Present while Langfuse fails                                       |
| `exporter.lastAcceptedAt`, `exporter.accepted`, `exporter.deadLettered`, `exporter.expired` | Progress counters                                                  |

Two internal functions help after an incident. Run them from the dashboard or
the CLI:

```bash
# Clear a backoff and start the exporter now, for example after fixing the keys.
npx convex run --component convexLangfuse exporter:kick

# Move up to 500 dead letters back to the outbox.
npx convex run --component convexLangfuse outbox:retryDeadLetters '{"limit": 100}'
```

## Testing

With [`convex-test`](https://www.npmjs.com/package/convex-test), register the
component and its child component in one call:

```ts
import { convexTest } from "convex-test";
import { register } from "convex-langfuse/test";
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
