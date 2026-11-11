// Writes the package version into src/shared/version.ts. Runs in the npm
// `version` lifecycle, after npm has bumped package.json, so the OTLP scope
// version a release sends matches the release.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
writeFileSync(
  new URL("../src/shared/version.ts", import.meta.url),
  `/** Package version, sent as the OTLP instrumentation scope version. */\nexport const VERSION = "${version}";\n`,
);
