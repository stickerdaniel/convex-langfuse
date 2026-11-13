# Changelog

## 0.1.0

### Breaking Changes

The component is rebuilt on a transactional outbox, with a new client API.

- The package is published as `@stickerdaniel/convex-langfuse`. The package
  `convex-langfuse` without the scope is the upstream project.
- `new Langfuse(component, { content })` replaces the constructor options
  `publicKey`, `secretKey` and `baseUrl`. The Langfuse keys and the base URL are
  component env values, bound in `convex.config.ts`. `content` is required.
- `langfuse.trace(...)` with `generation`, `span`, `event` and `record` replaces
  `logGeneration` and `logSpan`. An observation is enqueued in the caller's
  transaction and exported by the component.
- `langfuse.score` replaces `recordScore`.
- The queries `getTrace`, `listTracesByUser`, `listTracesBySession`,
  `listObservations`, `listScores`, `getStats` and `listRecentTraces`, the
  component module `lib` and the tables `traces`, `observations` and `scores`
  are removed. Read traces in Langfuse.
- The `prompt` link of a generation needs a `name` and a `version`.

### Added

- Export to Langfuse v4 through OTLP/HTTP: trace and observation ids from seeds
  and keys, the ten observation types, usage and cost details, experiments.
- An outbox with at-least-once delivery, backoff, dead letters, a backlog gate
  and retention.
- `content` modes, a `redact` hook and field truncation.
- Scores with `score`, `deleteScore`, `defineScores` and `syncScoreConfigs`.
- Trace deletion requests with `deleteTraces`.
- A prompt cache with `prompts.get`, `prompts.pin` and `prompts.sync`, a signed
  webhook route and a rolling refresh.
- `health` for dashboards and alerts.

## 0.0.5

### Patch Changes

- Fix the Convex directory badge image URL, which still pointed at
  `badge/sholajegede/convex-langfuse` after the link URL was corrected in a
  previous release; both now use the plain `badge/convex-langfuse` path.

## 0.0.4

### Patch Changes

- Drop the username scope from the Convex directory badge link in README,
  matching the directory's updated URL format

## 0.0.3

### Patch Changes

Fix `logGeneration`, `logSpan`, and `recordScore` (and the private
`logObservation` they share) being typed as
`ctx: GenericActionCtx<GenericDataModel>`, which only type-checks when the
calling app's schema is empty. Any real app with its own tables got a compile
error on every one of these calls. They now accept a minimal structural ctx type
instead, matching the pattern the query methods already used. The example app's
schema was also given a real table, so this class of bug shows up in this repo's
own typecheck from now on instead of only in a downstream app.

## 0.0.2

### Patch Changes

- Add demo screenshot to README

## 0.0.1

- Fix Langfuse usage_details token keys so generations show correct token usage
  and cost
- Add getStats and listRecentTraces queries
- Rebuild example app with a History tab, replay, and redesigned UI

## 0.0.0

- Initial release.
