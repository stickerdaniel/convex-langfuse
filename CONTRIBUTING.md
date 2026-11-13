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

With `--cloud`, the same cases run against Langfuse Cloud and a Convex Cloud
deployment, in 6 to 12 minutes. The suite deploys its host app there, so use a
deployment that holds nothing else. Two things need a one-time setup:

- a public URL that forwards to the suite's recording proxy on your machine, for
  example a tunnel to port 8787. The component in Convex Cloud sends its
  requests there.
- a prompt webhook in the Langfuse project with the URL
  `https://<deployment>.convex.site/langfuse/prompt-webhook`.

```sh
export LANGFUSE_BASE_URL=https://cloud.langfuse.com
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
export LANGFUSE_WEBHOOK_SECRET=lf-whsec_...
export CONVEX_URL=https://<deployment>.convex.cloud
export CONVEX_DEPLOY_KEY=prod:...
export CONTRACT_PROXY_PORT=8787
export CONTRACT_PROXY_URL=https://<public host of the tunnel>
node contract/run.mjs --cloud
```

At the end, and on SIGINT or SIGTERM, the suite removes `LANGFUSE_BASE_URL` from
the deployment, which stops its export, and deletes its prompts. A run whose
cleanup fails exits with 1 and names what is left. A run killed with SIGKILL
skips the cleanup; then run `npx convex env remove LANGFUSE_BASE_URL` with the
deploy key. The other settings, the host app, the score configs, the prompt
webhook and the run's traces and scores stay. The traces carry the environment
`contract-<run id>`, except the canary trace the suite sends before its cases.

Langfuse Cloud differs from the local stack in three ways, and the cloud run
allows for each:

- Its Hobby plan allows 30 requests per minute on the read API, for the whole
  organization, so a read that must be repeated waits 3 s.
- Reading back takes 5 to 15 s instead of 2 s, so every deadline is four times
  as long.
- Deletions are applied in batches, traces 4 to 19 minutes and scores 34 to 49
  minutes after the request. The cloud run checks only that Langfuse accepted
  each deletion request with 2xx.

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
