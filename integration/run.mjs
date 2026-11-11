// Integration run on a real Convex backend.
//
//   npm run build && npm run test:integration
//
// Downloads the `convex-local-backend` binary of RELEASE into
// `integration/.cache/`, starts it on free ports with its state in a temp
// directory, deploys the host app in `integration/convex`, binds the
// component's env through the app, and runs the cases against the fake
// endpoint in `fake-langfuse.mjs`. Prints a result table and exits non-zero
// when a case fails. Every process it starts is stopped before it exits.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const RELEASE = "precompiled-2026-10-28-d1fcbea";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..");
const CONVEX_BIN = join(ROOT, "node_modules", ".bin", "convex");
const api = anyApi.harness;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = promisify(execFile);

/** Polls `check` until it returns a truthy value or `timeoutMs` passes. */
async function waitFor(what, check, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await sleep(intervalMs);
  }
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ── Backend binary ─────────────────────────────────────────────────────────

function releaseTarget() {
  const targets = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) {
    throw new Error(`no ${RELEASE} binary for ${process.platform}`);
  }
  return target;
}

async function ensureBinary() {
  const dir = join(HERE, ".cache", RELEASE);
  const binary = join(dir, "convex-local-backend");
  if (existsSync(binary)) return binary;
  mkdirSync(dir, { recursive: true });
  const url =
    "https://github.com/get-convex/convex-backend/releases/download/" +
    `${RELEASE}/convex-local-backend-${releaseTarget()}.zip`;
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download of ${RELEASE} failed: HTTP ${response.status}`);
  }
  const zip = join(dir, "backend.zip");
  writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
  await run("unzip", ["-o", "-q", zip, "-d", dir]);
  rmSync(zip);
  chmodSync(binary, 0o755);
  return binary;
}

// ── Processes ──────────────────────────────────────────────────────────────

const children = new Set();

function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function stopAll() {
  for (const child of children) child.kill("SIGKILL");
}
process.on("exit", stopAll);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(130));
}

class Backend {
  constructor(binary, stateDir) {
    this.binary = binary;
    this.stateDir = stateDir;
    this.secret = randomBytes(32).toString("hex");
    this.name = "convex-langfuse-it";
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  async init() {
    this.port = await freePort();
    this.sitePort = await freePort();
    const { stdout } = await run(this.binary, [
      "keygen",
      "admin-key",
      "--instance-name",
      this.name,
      "--instance-secret",
      this.secret,
    ]);
    this.adminKey = stdout.trim();
  }

  async start() {
    const log = openSync(join(this.stateDir, "backend.log"), "a");
    this.process = track(
      spawn(
        this.binary,
        [
          "--port",
          String(this.port),
          "--site-proxy-port",
          String(this.sitePort),
          "--instance-name",
          this.name,
          "--instance-secret",
          this.secret,
          "--local-storage",
          join(this.stateDir, "storage"),
          "--disable-beacon",
          join(this.stateDir, "backend.sqlite3"),
        ],
        { cwd: this.stateDir, stdio: ["ignore", log, log] },
      ),
    );
    await waitFor(
      "the backend",
      async () => {
        try {
          return (await fetch(`${this.url}/version`)).ok;
        } catch {
          return false;
        }
      },
      60_000,
      250,
    );
  }

  /** Kills the process without letting it shut down cleanly. */
  async kill() {
    const exited = new Promise((resolve) => this.process.once("exit", resolve));
    this.process.kill("SIGKILL");
    await exited;
  }

  get logPath() {
    return join(this.stateDir, "backend.log");
  }

  /** Bytes in the backend log so far, an offset for `logLinesSince`. */
  logSize() {
    return existsSync(this.logPath) ? statSync(this.logPath).size : 0;
  }

  /** Lines of the backend log written after byte `offset`, without colors. */
  logLinesSince(offset) {
    if (!existsSync(this.logPath)) return [];
    return stripVTControlCharacters(
      readFileSync(this.logPath).subarray(offset).toString("utf8"),
    )
      .split("\n")
      .filter((line) => line.length > 0);
  }

  /** The last warnings and errors of the backend log, without colors. */
  logProblems(lines = 30) {
    return this.logLinesSince(0)
      .filter((line) => / (WARN|ERROR) /.test(line))
      .slice(-lines)
      .map((line) => line.slice(0, 400))
      .join("\n");
  }
}

async function startFake() {
  const child = track(
    spawn(process.execPath, [join(HERE, "fake-langfuse.mjs"), "--port", "0"], {
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      const match = /listening (\d+)/.exec(String(chunk));
      if (match) resolve(Number(match[1]));
    });
    child.once("exit", () => reject(new Error("fake endpoint exited")));
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    async control(mode) {
      const response = await fetch(`${url}/control`, {
        method: "POST",
        body: JSON.stringify(mode),
      });
      if (!response.ok) throw new Error("fake endpoint control failed");
    },
    async stats() {
      return await (await fetch(`${url}/stats`)).json();
    },
  };
}

// ── Convex CLI ─────────────────────────────────────────────────────────────

function cliEnv(backend) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CONVEX_")) delete env[key];
  }
  return {
    ...env,
    CONVEX_SELF_HOSTED_URL: backend.url,
    CONVEX_SELF_HOSTED_ADMIN_KEY: backend.adminKey,
  };
}

async function convex(backend, args) {
  try {
    await run(CONVEX_BIN, args, {
      cwd: HERE,
      env: cliEnv(backend),
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `convex ${args.join(" ")} failed:\n${error.stdout}\n${error.stderr}`,
    );
  }
}

/**
 * Streams the backend's function log as JSONL until `stop`, which ends the
 * stream, waits until its output is read to the end, and returns every
 * completed execution with its `identifier`, `executionTime` in seconds and
 * `error`.
 */
function streamLogs(backend) {
  const child = track(
    spawn(CONVEX_BIN, ["logs", "--jsonl", "--success"], {
      cwd: HERE,
      env: cliEnv(backend),
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  const entries = [];
  let buffer = "";
  const take = (line) => {
    try {
      const entry = JSON.parse(line);
      if (entry.kind === "Completion") entries.push(entry);
    } catch {
      // Not a log event.
    }
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    lines.forEach(take);
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  return {
    async stop() {
      // The CLI polls the log; give it one more poll before it is stopped.
      await sleep(1_500);
      child.kill("SIGTERM");
      await Promise.race([closed, sleep(5_000)]);
      child.kill("SIGKILL");
      await closed;
      take(buffer);
      buffer = "";
      return entries;
    },
  };
}

/** Links `convex-langfuse` to the repository, as `npm install` would. */
function linkPackage() {
  const link = join(HERE, "node_modules", "convex-langfuse");
  if (existsSync(link)) return;
  mkdirSync(join(HERE, "node_modules"), { recursive: true });
  symlinkSync("../..", link, "dir");
}

// ── Cases ──────────────────────────────────────────────────────────────────

const TRACE_IDS = {
  2: "a0000000000000000000000000000002",
  3: "a0000000000000000000000000000003",
  4: "a0000000000000000000000000000004",
  5: "a0000000000000000000000000000005",
  6: "a0000000000000000000000000000006",
};

/** First span id number of a case, so cases never share ids. */
const firstId = (caseNo) => caseNo * 1_000_000 + 1;
const hexId = (n) => n.toString(16).padStart(16, "0");

/**
 * Runs `count` record mutations of `size` spans each, `concurrency` at a
 * time, and returns their results. Throws when a mutation fails. With
 * `throttled`, a mutation refused by the backend's write throughput limit
 * is sent again after a pause; that limit belongs to the local backend, not
 * to the component.
 */
async function recordMany(
  client,
  caseNo,
  { count, size, concurrency, throttled = false },
) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const i = next++;
      const args = {
        traceId: TRACE_IDS[caseNo],
        from: firstId(caseNo) + i * size,
        count: size,
      };
      for (;;) {
        try {
          results[i] = await client.mutation(api.record, args, {
            skipQueue: true,
          });
          break;
        } catch (error) {
          if (!throttled || !/TooManyWrites/.test(String(error))) throw error;
          await sleep(1_000);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/**
 * Runs record mutations of `size` spans each, `concurrency` at a time, until
 * `stop`, which returns the commit time of every mutation. `commits` is the
 * number committed so far. A mutation refused by the local backend's write
 * throughput limit is sent again after a pause.
 */
function startLoad(client, caseNo, { size, concurrency }) {
  const commits = [];
  let next = 0;
  let running = true;
  let failure;
  const worker = async () => {
    while (running) {
      const args = {
        traceId: TRACE_IDS[caseNo],
        from: firstId(caseNo) + next++ * size,
        count: size,
      };
      for (;;) {
        try {
          const result = await client.mutation(api.record, args, {
            skipQueue: true,
          });
          if (result.enqueued !== size) {
            throw new Error(`record returned ${JSON.stringify(result)}`);
          }
          commits.push(Date.now());
          break;
        } catch (error) {
          if (!/TooManyWrites/.test(String(error))) {
            failure ??= error;
            running = false;
            return;
          }
          await sleep(1_000);
        }
      }
    }
  };
  const workers = Promise.all(Array.from({ length: concurrency }, worker));
  return {
    commits: () => commits.length,
    async stop() {
      running = false;
      await workers;
      if (failure) throw failure;
      return commits;
    },
  };
}

/** Span ids of a case the fake endpoint has received. */
function received(stats, caseNo, total) {
  let count = 0;
  for (let n = firstId(caseNo); n < firstId(caseNo) + total; n++) {
    if (stats.spans[hexId(n)]) count += 1;
  }
  return count;
}

/** Span ids whose deliveries did not all carry the same content. */
function divergent(stats) {
  return Object.entries(stats.spans).filter(
    ([, hashes]) => new Set(hashes).size > 1,
  );
}

function deliveries(stats, caseNo, total) {
  let count = 0;
  for (let n = firstId(caseNo); n < firstId(caseNo) + total; n++) {
    count += stats.spans[hexId(n)]?.length ?? 0;
  }
  return count;
}

async function main() {
  const binary = await ensureBinary();
  linkPackage();
  const stateDir = mkdtempSync(join(tmpdir(), "convex-langfuse-it-"));
  const backend = new Backend(binary, stateDir);
  const results = [];
  let fake;

  // `node integration/run.mjs 3 5` runs only cases 3 and 5.
  const only = process.argv.slice(2);
  // Failed function executions per case, from the backend's function log.
  const functionErrors = [];
  const runCase = async (name, body) => {
    if (only.length > 0 && !only.includes(name.split(" ")[0])) return;
    const startedAt = Date.now();
    const before = (await fake.stats()).requests;
    let logs = streamLogs(backend);
    const executions = [];
    // Case 3 restarts the backend, which ends the stream.
    const restartLogs = async () => {
      executions.push(...(await logs.stop()));
      logs = streamLogs(backend);
    };
    let finished = false;
    const finish = async () => {
      if (finished) return executions;
      finished = true;
      executions.push(...(await logs.stop()));
      for (const log of executions.filter((entry) => entry.error)) {
        functionErrors.push(
          `${name}: ${log.identifier}: ${String(log.error).split("\n")[0].slice(0, 160)}`,
        );
      }
      return executions;
    };
    try {
      const detail = await body({ finish, restartLogs });
      await finish();
      results.push({
        name,
        ok: true,
        ms: Date.now() - startedAt,
        requests: (await fake.stats()).requests - before,
        detail,
      });
    } catch (error) {
      await finish();
      results.push({
        name,
        ok: false,
        ms: Date.now() - startedAt,
        requests: (await fake.stats()).requests - before,
        detail: String(error?.message ?? error),
      });
    }
  };

  try {
    fake = await startFake();
    await backend.init();
    await backend.start();
    await convex(backend, ["deploy", "--yes"]);
    const keys = {
      LANGFUSE_PUBLIC_KEY: "pk-lf-integration",
      LANGFUSE_SECRET_KEY: "sk-lf-integration",
      LANGFUSE_BASE_URL: fake.url,
    };
    for (const [name, value] of Object.entries(keys)) {
      await convex(backend, ["env", "set", name, value]);
    }
    const client = new ConvexHttpClient(backend.url);

    await runCase("1 env binding", async () => {
      if (!(await client.query(api.enabled, {}))) {
        throw new Error("component disabled with all env values bound");
      }
      await convex(backend, ["env", "remove", "LANGFUSE_BASE_URL"]);
      await waitFor(
        "disabled",
        async () => !(await client.query(api.enabled, {})),
        10_000,
      );
      await convex(backend, [
        "env",
        "set",
        "LANGFUSE_BASE_URL",
        keys.LANGFUSE_BASE_URL,
      ]);
      await waitFor(
        "enabled again",
        async () => await client.query(api.enabled, {}),
        10_000,
      );
      return "enabled with env, disabled without LANGFUSE_BASE_URL";
    });

    await runCase("2 concurrency", async () => {
      const total = 2_000;
      const recorded = await recordMany(client, 2, {
        count: 200,
        size: 10,
        concurrency: 200,
      });
      const enqueued = recorded.reduce((sum, r) => sum + r.enqueued, 0);
      if (enqueued !== total) throw new Error(`enqueued ${enqueued}`);
      await waitFor(
        "2,000 span ids",
        async () => received(await fake.stats(), 2, total) === total,
        180_000,
      );
      return `200 mutations committed, ${total} distinct span ids`;
    });

    await runCase("3 restart in flight", async ({ restartLogs }) => {
      const total = 300;
      await fake.control({ mode: "delay", delayMs: 15_000 });
      await recordMany(client, 3, { count: 6, size: 50, concurrency: 1 });
      // The request the backend dies in: the fake has received it and holds
      // its answer back, so the exporter never learns that it was accepted.
      const atKill = await waitFor(
        "a request in flight",
        async () => {
          const stats = await fake.stats();
          return stats.inflightLog.length > 0 && stats;
        },
        30_000,
        100,
      );
      const inflight = atKill.inflightLog.map((index) => atKill.log[index]);
      const seenAtKill = atKill.log.length;
      await backend.kill();
      await fake.control({ mode: "healthy" });
      await backend.start();
      await restartLogs();
      const stats = await waitFor(
        "every row after restart",
        async () => {
          const stats = await fake.stats();
          return received(stats, 3, total) === total && stats;
        },
        360_000,
        1_000,
      );
      // Recovery must send the in-flight batch again, with the same bytes.
      const afterKill = stats.log.slice(seenAtKill);
      for (const { bodyHash, spanIds } of inflight) {
        if (!afterKill.some((request) => request.bodyHash === bodyHash)) {
          throw new Error("the in-flight request was not sent again unchanged");
        }
        const once = spanIds.filter((id) => stats.spans[id].length < 2);
        if (once.length > 0) {
          throw new Error(`${once.length} in-flight spans were not resent`);
        }
      }
      await waitFor(
        "an empty outbox",
        async () => (await client.query(api.backlog, {})).pendingAtLeast === 0,
        60_000,
      );
      const diverging = divergent(stats);
      if (diverging.length > 0) {
        throw new Error(`${diverging.length} span ids with different content`);
      }
      const resent = inflight.reduce((sum, r) => sum + r.spanIds.length, 0);
      return (
        `${total} span ids, ${deliveries(stats, 3, total)} deliveries, ` +
        `${resent} in-flight spans resent with identical request bytes`
      );
    });

    await runCase("4 redeploy under load", async () => {
      const marker = join(HERE, "convex", "redeploy.ts");
      // Load runs until it is stopped, so the deploy overlaps it by
      // construction: mutations must commit before, during and after it.
      const load = startLoad(client, 4, { size: 10, concurrency: 8 });
      let deployStart;
      let deployEnd;
      try {
        await waitFor(
          "load before the deploy",
          () => load.commits() >= 20,
          30_000,
          50,
        );
        writeFileSync(
          marker,
          `import { query } from "./_generated/server";\n` +
            `export const marker = query({ args: {}, handler: async () => ${Date.now()} });\n`,
        );
        deployStart = Date.now();
        await convex(backend, [
          "deploy",
          "--yes",
          "--codegen",
          "disable",
          "--typecheck",
          "disable",
        ]);
        deployEnd = Date.now();
        const atEnd = load.commits();
        await waitFor(
          "load after the deploy",
          () => load.commits() >= atEnd + 20,
          30_000,
          50,
        );
      } finally {
        rmSync(marker, { force: true });
      }
      const commits = await load.stop();
      const before = commits.filter((at) => at < deployStart).length;
      const during = commits.filter(
        (at) => at >= deployStart && at <= deployEnd,
      ).length;
      const after = commits.filter((at) => at > deployEnd).length;
      if (before === 0 || during === 0 || after === 0) {
        throw new Error(
          `commits before/during/after the deploy: ${before}/${during}/${after}`,
        );
      }
      const total = commits.length * 10;
      await waitFor(
        "every span id after the redeploy",
        async () => received(await fake.stats(), 4, total) === total,
        180_000,
      );
      return (
        `${before}/${during}/${after} mutations committed before/during/after ` +
        `the deploy, ${total} distinct span ids`
      );
    });

    await runCase("5 gate closes", async ({ finish }) => {
      await fake.control({ mode: "down" });
      await recordMany(client, 5, {
        count: 500,
        size: 50,
        concurrency: 4,
        throttled: true,
      });
      await client.mutation(api.record, {
        traceId: TRACE_IDS[5],
        from: firstId(5) + 25_000,
        count: 1,
      });
      const backlog = await waitFor(
        "the gate to close",
        async () => {
          const backlog = await client.query(api.backlog, {});
          return !backlog.accepting && backlog;
        },
        240_000,
        1_000,
      );
      const refused = await client.mutation(api.record, {
        traceId: TRACE_IDS[5],
        from: firstId(5) + 25_001,
        count: 1,
      });
      if (refused.reason !== "backlog") {
        throw new Error(`record returned ${JSON.stringify(refused)}`);
      }
      const counts = (await finish()).filter((log) =>
        /outbox(\.js)?:count/.test(log.identifier),
      );
      const failed = counts.filter((log) => log.error);
      if (counts.length === 0) throw new Error("no outbox:count in the log");
      if (failed.length > 0) {
        throw new Error(`outbox:count failed: ${failed[0].error}`);
      }
      const longestMs = Math.max(
        ...counts.map((log) => log.executionTime * 1_000),
      );
      if (longestMs > 5_000) {
        throw new Error(`outbox:count took ${longestMs.toFixed(0)} ms`);
      }
      return (
        `closed at ${backlog.pendingCounted} counted rows, record returns ` +
        `backlog; ${counts.length} count steps, longest ${longestMs.toFixed(0)} ms`
      );
    });

    await runCase("6 progress under sustained enqueue", async ({ finish }) => {
      const logOffset = backend.logSize();
      await fake.control({ mode: "healthy" });
      // Start from an empty outbox: with few rows waiting, a claim reads up
      // to the newest row, which is where enqueues write.
      await waitFor(
        "an open gate and an empty outbox",
        async () => {
          const backlog = await client.query(api.backlog, {});
          return backlog.accepting && backlog.pendingAtLeast === 0;
        },
        900_000,
        2_000,
      );
      const acceptedAt = async () =>
        (await client.query(api.backlog, {})).accepted;
      const requestsAt = async () => (await fake.stats()).requests;
      const load6 = { commits: () => 0, windows: [] };
      let drainedAt;

      // Diagnostics for the detail and for the error message.
      const diagnostics = async () => {
        const executions = await finish();
        const during = (pattern, from, to) =>
          executions.filter(
            (log) =>
              pattern.test(log.identifier) &&
              log.timestamp * 1_000 >= from &&
              log.timestamp * 1_000 <= to,
          );
        const medianMs = (logs) => {
          const ms = logs.map((log) => log.executionTime * 1_000);
          ms.sort((a, b) => a - b);
          return ms.length === 0 ? "n/a" : ms[ms.length >> 1].toFixed(0);
        };
        const advance = /exporter(\.js)?:advance/;
        const { loadStart, loadEnd, requestsStart, requestsEnd } = load6;
        const counts = executions.filter((log) =>
          /outbox(\.js)?:count/.test(log.identifier),
        );
        const longestCount = Math.max(
          0,
          ...counts.map((log) => log.executionTime * 1_000),
        );
        const occ = backend
          .logLinesSince(logOffset)
          .filter((line) => /occ error|Optimistic concurrency/i.test(line));
        const rate =
          loadEnd === undefined
            ? "n/a"
            : (
                (requestsEnd - requestsStart) /
                ((loadEnd - loadStart) / 1_000)
              ).toFixed(1);
        const drain =
          drainedAt === undefined
            ? "not all arrived"
            : `${((drainedAt - loadEnd) / 1_000).toFixed(1)} s`;
        return {
          executions,
          text:
            `${load6.commits()} mutations in 30 s, ${rate} requests/s during ` +
            `the load, every span id ${drain} after the load; ` +
            `advance median ${medianMs(during(advance, loadStart, loadStart + 5_000))} ms ` +
            `in the first 5 s, ${medianMs(during(advance, loadEnd - 5_000, loadEnd))} ms ` +
            `in the last 5 s; ${counts.length} count steps, longest ` +
            `${longestCount.toFixed(0)} ms; ${occ.length} OCC log lines`,
        };
      };

      try {
        // Enqueues never pause, so the exporter always claims next to a live
        // insert range. It must keep accepting rows in every window.
        load6.requestsStart = await requestsAt();
        load6.loadStart = Date.now();
        const load = startLoad(client, 6, { size: 10, concurrency: 8 });
        load6.commits = load.commits;
        let last = await acceptedAt();
        for (let i = 0; i < 6; i++) {
          await sleep(5_000);
          const now = await acceptedAt();
          load6.windows.push(now - last);
          last = now;
        }
        const commits = await load.stop();
        load6.loadEnd = Date.now();
        load6.requestsEnd = await requestsAt();
        if (load6.windows.some((accepted) => accepted === 0)) {
          throw new Error(
            `rows accepted per 5 s window: ${load6.windows.join(", ")}`,
          );
        }
        const total = commits.length * 10;
        await waitFor(
          "every span id",
          async () => received(await fake.stats(), 6, total) === total,
          180_000,
        );
        drainedAt = Date.now();
        const { executions, text } = await diagnostics();
        const failed = executions.filter(
          (log) =>
            log.error &&
            /exporter(\.js)?:(advance|dispatch|run)$/.test(log.identifier),
        );
        if (failed.length > 0) {
          throw new Error(
            `${failed.length} failed exporter executions, first ` +
              `${failed[0].identifier}: ${String(failed[0].error).split("\n")[0].slice(0, 120)}`,
          );
        }
        return (
          `${text}; accepted per 5 s window: ${load6.windows.join(", ")}; ` +
          `${total} distinct span ids`
        );
      } catch (error) {
        const { text } = await diagnostics();
        throw new Error(`${error?.message ?? error}; ${text}`);
      }
    });

    const diverging = divergent(await fake.stats());
    results.push({
      name: "all deliveries of a span identical",
      ok: diverging.length === 0,
      ms: 0,
      requests: 0,
      detail: `${diverging.length} span ids with different content`,
    });
  } catch (error) {
    results.push({
      name: "setup",
      ok: false,
      ms: 0,
      requests: 0,
      detail: String(error?.message ?? error),
    });
  } finally {
    const failed = results.some((result) => !result.ok);
    console.log(
      `\nbackend ${RELEASE} (${releaseTarget()}), state ${stateDir}\n`,
    );
    console.table(
      results.map(({ name, ok, ms, requests, detail }) => ({
        case: name,
        result: ok ? "pass" : "FAIL",
        seconds: (ms / 1000).toFixed(1),
        requests,
        detail,
      })),
    );
    if (functionErrors.length > 0) {
      console.log(`failed function executions:\n${functionErrors.join("\n")}`);
    }
    if (failed) {
      console.log(`backend warnings and errors:\n${backend.logProblems()}`);
    }
    stopAll();
    await sleep(200);
    rmSync(stateDir, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
  }
}

await main();
