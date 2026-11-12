// A local Convex backend, the fake Langfuse and the Convex CLI, for the
// integration run (`run.mjs`) and the end-to-end scripts (`e2e/`).
//
// Every process started here is tracked and killed when the Node process
// exits.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";

export const RELEASE = "precompiled-2026-10-28-d1fcbea";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..");
const CONVEX_BIN = join(ROOT, "node_modules", ".bin", "convex");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = promisify(execFile);

/** Polls `check` until it returns a truthy value or `timeoutMs` passes. */
export async function waitFor(what, check, timeoutMs, intervalMs = 500) {
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

export function releaseTarget() {
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

/** The backend binary of RELEASE, downloaded into `integration/.cache/`. */
export async function ensureBinary() {
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
const processGroups = new WeakSet();

/** Stops an owned process, including its children when it owns a group. */
function stop(child) {
  if (!processGroups.has(child)) return child.kill("SIGKILL");
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function track(child, group = false) {
  children.add(child);
  if (group) processGroups.add(child);
  child.once("exit", () => {
    // A backend's Node executor survives its parent unless killed too.
    if (group) stop(child);
    children.delete(child);
  });
  return child;
}

export function stopAll() {
  for (const child of children) stop(child);
}
process.on("exit", stopAll);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(130));
}

export class Backend {
  constructor(binary, stateDir) {
    this.binary = binary;
    this.stateDir = stateDir;
    this.secret = randomBytes(32).toString("hex");
    this.name = "convex-langfuse-it";
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Where HTTP actions are served. */
  get siteUrl() {
    return `http://127.0.0.1:${this.sitePort}`;
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
        { cwd: this.stateDir, stdio: ["ignore", log, log], detached: true },
      ),
      true,
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

  /**
   * Kills the backend and its executor without a clean shutdown. Returns at
   * once when the backend already exited, whose `exit` event does not come
   * again.
   */
  async kill() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) {
      return;
    }
    const exited = new Promise((resolve) => this.process.once("exit", resolve));
    stop(this.process);
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

/** Starts `fake-langfuse.mjs` on a free port. */
export async function startFake() {
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
    /**
     * Adds the next text version of a prompt with `labels`. Returns `{
     * version, createdAt }`, the version's number and the fake's time once
     * the version exists.
     */
    async addPrompt(prompt) {
      const response = await fetch(`${url}/control/prompts`, {
        method: "POST",
        body: JSON.stringify(prompt),
      });
      if (!response.ok) throw new Error("fake endpoint control failed");
      return await response.json();
    },
    async stats() {
      return await (await fetch(`${url}/stats`)).json();
    },
    /** Counts only, without the per-span and per-request detail. */
    async summary() {
      return await (await fetch(`${url}/stats?summary=1`)).json();
    },
    /** Makes the fake sign and post a webhook event per created prompt. */
    async webhook(target) {
      const response = await fetch(`${url}/control/webhook`, {
        method: "POST",
        body: JSON.stringify(target),
      });
      if (!response.ok) throw new Error("fake endpoint control failed");
    },
    /**
     * Makes the fake answer each prompt by name after a random time up to
     * `ms`, and each listing of one name, the first request of a refresh,
     * after a random time up to `listingMs`. 0 answers at once again.
     */
    async holdPrompts(ms, listingMs = 0) {
      const response = await fetch(`${url}/control/prompt-hold`, {
        method: "POST",
        body: JSON.stringify({ ms, listingMs }),
      });
      if (!response.ok) throw new Error("fake endpoint control failed");
    },
    /** Stops the fake process. */
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
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

/**
 * The Convex CLI for the host app in `dir`, whose `convex/` folder it
 * deploys. `backend` is anything with `url` and `adminKey`.
 */
export function convexCli(dir) {
  async function convex(backend, args) {
    try {
      await run(CONVEX_BIN, args, {
        cwd: dir,
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
   * Sets one env value of the deployment, replacing an existing one. The
   * value travels through stdin, so it appears neither in the process list
   * nor in an error message.
   */
  async function setEnv(backend, name, value) {
    const child = spawn(CONVEX_BIN, ["env", "set", "--force", name], {
      cwd: dir,
      env: cliEnv(backend),
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.end(value);
    const code = await new Promise((resolve) => child.once("close", resolve));
    if (code !== 0) {
      throw new Error(
        `convex env set ${name} failed:\n${stderr.replaceAll(value, "***")}`,
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
        cwd: dir,
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
    const link = join(dir, "node_modules", "convex-langfuse");
    if (existsSync(link)) return;
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync("../..", link, "dir");
  }

  return { convex, setEnv, streamLogs, linkPackage };
}
