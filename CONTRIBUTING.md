# Developing guide

## Running locally

```sh
npm i
npm run dev
```

## Testing

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

`npm test` runs the unit tests with `convex-test` and a fake Langfuse endpoint.
Three more suites run on a local Convex backend, which the first run downloads
at the pinned release:

```sh
# 12 cases with a fake Langfuse endpoint, about 10 minutes. CI runs it.
npm run test:integration

# Load, outage, backlog threshold and prompt refresh drivers, about 70 minutes.
# They measure latency and rates, so they need an otherwise idle machine. The
# "Load drivers" workflow runs each on a hosted runner when started by hand.
npm run test:load

# One driver: load, outage, threshold, threshold --kill or prompts.
node integration/load.mjs outage
```

The contract suite needs Docker. It starts the Langfuse stack of
`contract/supported.json`, runs every case against it and removes it again, in
about 3 minutes. CI runs it on every pull request.

```sh
npm run test:contract

# Plants three faults in the encoder and expects a case to catch each.
npm run test:contract:faults
```

The scripts under `e2e/` check traces, scores and prompts against a Langfuse
instance of your own. They create traces, scores and prompts with unique names.
At the end they request the deletion of their traces through the component and
delete their prompts. The score config `convex-langfuse-e2e-rating` stays in the
project.

```sh
export LANGFUSE_BASE_URL=https://langfuse.example.com
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
node e2e/traces.mjs
node e2e/scores.mjs
node e2e/prompts.mjs
```

With `--fake`, a script runs against the fake endpoint instead.
