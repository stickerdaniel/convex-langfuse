import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { VERSION } from "./version.js";

test("VERSION equals the package version", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  expect(VERSION).toBe(packageJson.version);
});
