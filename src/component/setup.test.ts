/// <reference types="vite/client" />
import { test } from "vitest";
import schema from "./schema.js";
import { convexTest } from "convex-test";
import batchWorker from "@convex-dev/batch-worker/test";
export const modules = import.meta.glob("./**/*.*s");

/**
 * A convex-test instance with this component as the root and the batch-worker
 * child registered, so `components.batchWorker` resolves.
 */
export function initConvexTest(
  options: { transactionLimits?: boolean | { documentsRead?: number } } = {},
) {
  const t = convexTest({ schema, modules, ...options });
  batchWorker.register(t);
  return t;
}
test("setup", () => {});
