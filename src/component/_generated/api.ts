/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as constants from "../constants.js";
import type * as crons from "../crons.js";
import type * as exporter from "../exporter.js";
import type * as http from "../http.js";
import type * as outbox from "../outbox.js";
import type * as prompts from "../prompts.js";
import type * as retention from "../retention.js";
import type * as retry from "../retry.js";
import type * as scoreKeys from "../scoreKeys.js";
import type * as scores from "../scores.js";
import type * as settings from "../settings.js";
import type * as signature from "../signature.js";
import type * as skills from "../skills.js";
import type * as traces from "../traces.js";
import type * as tracing from "../tracing.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  constants: typeof constants;
  crons: typeof crons;
  exporter: typeof exporter;
  http: typeof http;
  outbox: typeof outbox;
  prompts: typeof prompts;
  retention: typeof retention;
  retry: typeof retry;
  scoreKeys: typeof scoreKeys;
  scores: typeof scores;
  settings: typeof settings;
  signature: typeof signature;
  skills: typeof skills;
  traces: typeof traces;
  tracing: typeof tracing;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  batchWorker: import("@convex-dev/batch-worker/_generated/component.js").ComponentApi<"batchWorker">;
};
