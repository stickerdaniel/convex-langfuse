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

  /** The last warnings and errors of the backend log, without colors. */
  logProblems(lines = 30) {
    const path = join(this.stateDir, "backend.log");
    if (!existsSync(path)) return "";
    return stripVTControlCharacters(readFileSync(path, "utf8"))
      .split("\n")
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
 * Streams the backend's function log as JSONL until `stop`, which returns
 * every completed execution with its `identifier`, `executionTime` in
 * seconds and `error`.
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
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.kind === "Completion") entries.push(entry);
      } catch {
        // Not a log event.
      }
    }
  });
  return {
    stop() {
      child.kill("SIGKILL");
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

/** Span ids of a case the fake endpoint has received. */
function received(stats, caseNo, total) {
  let count = 0;
  for (let n = firstId(caseNo); n < firstId(caseNo) + total; n++) {
    if (stats.spans[hexId(n)]) count += 1;
  }
  return count;
}

/** Span ids whose deliveries did not all carry the same bytes. */
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
    const restartLogs = () => {
      executions.push(...logs.stop());
      logs = streamLogs(backend);
    };
    let finished = false;
    const finish = () => {
      if (finished) return executions;
      finished = true;
      executions.push(...logs.stop());
      for (const log of executions.filter((entry) => entry.error)) {
        functionErrors.push(
          `${name}: ${log.identifier}: ${String(log.error).split("\n")[0].slice(0, 160)}`,
        );
      }
      return executions;
    };
    try {
      const detail = await body({ finish, restartLogs });
      finish();
      results.push({
        name,
        ok: true,
        ms: Date.now() - startedAt,
        requests: (await fake.stats()).requests - before,
        detail,
      });
    } catch (error) {
      finish();
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
      await waitFor(
        "a request in flight",
        async () => (await fake.stats()).inflight > 0,
        30_000,
        100,
      );
      await backend.kill();
      await fake.control({ mode: "healthy" });
      await backend.start();
      restartLogs();
      const stats = await waitFor(
        "every row after restart",
        async () => {
          const stats = await fake.stats();
          return received(stats, 3, total) === total && stats;
        },
        360_000,
        1_000,
      );
      const diverging = divergent(stats);
      if (diverging.length > 0) {
        throw new Error(`${diverging.length} span ids with different bytes`);
      }
      return `${total} span ids, ${deliveries(stats, 3, total)} deliveries, identical bytes`;
    });

    await runCase("4 redeploy under load", async () => {
      const total = 2_000;
      const marker = join(HERE, "convex", "redeploy.ts");
      const load = recordMany(client, 4, {
        count: 200,
        size: 10,
        concurrency: 20,
      });
      try {
        await sleep(500);
        writeFileSync(
          marker,
          `import { query } from "./_generated/server";\n` +
            `export const marker = query({ args: {}, handler: async () => ${Date.now()} });\n`,
        );
        await convex(backend, [
          "deploy",
          "--yes",
          "--codegen",
          "disable",
          "--typecheck",
          "disable",
        ]);
      } finally {
        rmSync(marker, { force: true });
      }
      const recorded = await load;
      const enqueued = recorded.reduce((sum, r) => sum + r.enqueued, 0);
      if (enqueued !== total) throw new Error(`enqueued ${enqueued}`);
      await waitFor(
        "2,000 span ids after redeploy",
        async () => received(await fake.stats(), 4, total) === total,
        180_000,
      );
      return `redeployed during load, ${total} distinct span ids`;
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
      const counts = finish().filter((log) =>
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

    const diverging = divergent(await fake.stats());
    results.push({
      name: "all byte-identical resends",
      ok: diverging.length === 0,
      ms: 0,
      requests: 0,
      detail: `${diverging.length} span ids with different bytes`,
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
