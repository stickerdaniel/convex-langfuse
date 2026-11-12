// Fault check of the contract suite: proves that the cases notice plausible
// encoder mistakes.
//
//   npm run build && npm run test:contract:faults [-- --langfuse 4.78.0]
//
// Starts one suite like `run.mjs`, then applies each fault below to the
// source in turn, rebuilds `dist/`, deploys the host app again and runs the
// cases that cover the fault. A fault passes the check when at least one of
// its cases fails on the read-back field the fault changes; a case that
// fails for another reason, such as a missing row, does not count. The
// source is restored after each fault and rebuilt at the end, also when the
// run is interrupted. Exits non-zero when a fault went unnoticed or the run
// failed.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { reportLogs, startSuite } from "./run.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Each fault replaces `from` by `to` in `file`; `from` occurs once. A case
 * of `cases` catches the fault when its failure names a difference in the
 * read-back field `field`.
 */
const FAULTS = [
  {
    name: "usage under a wrong attribute name",
    file: "src/shared/attributes.ts",
    from: 'usage: "langfuse.observation.usage_details",',
    to: 'usage: "langfuse.observation.usage",',
    cases: ["usage keys and the derived total"],
    field: "usageDetails",
  },
  {
    name: "a dropped cost entry",
    file: "src/shared/otlp.ts",
    from: "Object.entries(cost).filter(",
    to: "Object.entries(cost).slice(1).filter(",
    cases: ["explicit cost for a model of the run"],
    field: "costDetails",
  },
  {
    name: "a prompt version off by one",
    file: "src/shared/otlp.ts",
    from: "{ intValue: String(link.version) }",
    to: "{ intValue: String(link.version + 1) }",
    cases: ["prompt link and history"],
    field: "promptVersion",
  },
];

const build = () =>
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });

/** Original contents of the files a fault changed, until restored. */
const originals = new Map();

function restore() {
  for (const [path, text] of originals) writeFileSync(path, text);
  const changed = originals.size > 0;
  originals.clear();
  return changed;
}

// An interrupted run restores the source and rebuilds before it exits.
process.on("exit", () => {
  if (restore()) build();
});

function apply({ file, from, to }) {
  const path = join(ROOT, file);
  const text = readFileSync(path, "utf8");
  if (text.split(from).length !== 2) {
    throw new Error(`${file} does not hold the faulted text exactly once`);
  }
  originals.set(path, text);
  writeFileSync(path, text.replace(from, to));
}

async function main() {
  const { values } = parseArgs({
    options: {
      stack: {
        type: "string",
        default: join(ROOT, "contract", "supported.json"),
      },
      langfuse: { type: "string" },
    },
  });
  let failed = true;
  let logs;
  try {
    const suite = await startSuite({
      stackFile: values.stack,
      version: values.langfuse,
    });
    try {
      const outcomes = [];
      for (const fault of FAULTS) {
        suite.print(`fault: ${fault.name}`);
        apply(fault);
        build();
        await suite.redeploy();
        const results = await suite.runCases(fault.cases);
        restore();
        // `differences` of run.mjs words a difference as `<field>: expected`.
        const names = (onField) =>
          results
            .filter(
              (result) =>
                !result.ok &&
                result.detail.includes(`${fault.field}: expected`) === onField,
            )
            .map((result) => result.name);
        outcomes.push({ fault, caught: names(true), other: names(false) });
      }
      build();
      for (const { fault, caught, other } of outcomes) {
        suite.print(
          caught.length > 0
            ? `caught: ${fault.name}, by ${caught.join(", ")}`
            : `NOT CAUGHT: ${fault.name}` +
                (other.length > 0
                  ? `; failed without a difference in ${fault.field}: ${other.join(", ")}`
                  : ""),
        );
      }
      failed = outcomes.some(({ caught }) => caught.length === 0);
    } finally {
      logs = await suite.stop();
    }
  } catch (error) {
    console.error(`fault check failed: ${error?.message ?? error}`);
    logs ??= error?.logs;
  } finally {
    if (restore()) build();
  }
  process.exitCode = reportLogs(logs) && !failed ? 0 : 1;
}

await main();
