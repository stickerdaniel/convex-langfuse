/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import {
  componentsGeneric,
  type GenericSchema,
  type SchemaDefinition,
} from "convex/server";
import batchWorker from "@convex-dev/batch-worker/test";
import schema from "./component/schema.js";
import type { ComponentApi } from "./component/_generated/component.js";
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component with the test convex instance.
 *
 * The exporter runs on @convex-dev/batch-worker, so this also registers that
 * child component under `${name}/batchWorker`.
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 * @returns The component's API, for calling its functions from the test.
 */
export function register<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(t: TestConvex<Schema>, name: string = "convexLangfuse") {
  t.registerComponent(name, schema, modules);
  batchWorker.register(
    t as unknown as TestConvex<SchemaDefinition<GenericSchema, boolean>>,
    `${name}/batchWorker`,
  );
  return componentsGeneric()[name] as unknown as ComponentApi;
}
export default { register, schema, modules };
