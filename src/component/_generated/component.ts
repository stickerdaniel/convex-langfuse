/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    outbox: {
      health: FunctionReference<
        "query",
        "internal",
        {},
        {
          accepting: boolean;
          deadLettersAtLeast: number;
          enabled: boolean;
          exporter: {
            accepted: number;
            backoffUntil?: number;
            consecutiveFailures: number;
            deadLettered: number;
            expired: number;
            lastAcceptedAt?: number;
            lastError?: { at: number; class: string; status?: number };
            running: boolean;
          };
          oldestPendingAt?: number;
          pendingAtLeast: number;
          pendingCounted: { bytes: number; rows: number };
        },
        Name
      >;
    };
    scores: {
      remove: FunctionReference<
        "mutation",
        "internal",
        { id: string },
        { enqueued: boolean; reason?: "disabled" | "backlog" },
        Name
      >;
      syncConfigs: FunctionReference<
        "action",
        "internal",
        {
          definitions: Array<{
            categories?: Array<string>;
            dataType: "BOOLEAN" | "NUMERIC" | "CATEGORICAL";
            max?: number;
            min?: number;
            name: string;
          }>;
        },
        {
          configs: Array<{ configId: string; created: boolean; name: string }>;
          conflicts: Array<{
            configId: string;
            name: string;
            reason: "archived" | "incompatible";
          }>;
          status: "ok" | "running" | "incomplete" | "disabled";
        },
        Name
      >;
      upsert: FunctionReference<
        "mutation",
        "internal",
        {
          comment?: string;
          dataType: "BOOLEAN" | "NUMERIC" | "CATEGORICAL";
          environment?: string;
          fingerprint?: string;
          id: string;
          metadata?: string;
          name: string;
          observationId?: string;
          timestamp: number;
          traceId: string;
          value: number | string;
        },
        { enqueued: boolean; reason?: "disabled" | "backlog" },
        Name
      >;
    };
    traces: {
      remove: FunctionReference<
        "mutation",
        "internal",
        { traceIds: Array<string> },
        { enqueued: boolean; reason?: "disabled" },
        Name
      >;
    };
    tracing: {
      record: FunctionReference<
        "mutation",
        "internal",
        {
          observations: Array<{
            completionStartTime?: number;
            cost?: Record<string, number>;
            endTime: number;
            id: string;
            input?: string;
            level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
            metadata?: string;
            model?: string;
            modelParameters?: string;
            name: string;
            output?: string;
            parentId?: string;
            prompt?: { name: string; version: number };
            startTime: number;
            statusMessage?: string;
            type:
              | "span"
              | "generation"
              | "event"
              | "agent"
              | "tool"
              | "chain"
              | "retriever"
              | "evaluator"
              | "embedding"
              | "guardrail";
            usage?: Record<string, number>;
            version?: string;
          }>;
          trace: {
            environment?: string;
            experiment?: {
              datasetId?: string;
              id: string;
              itemId?: string;
              metadata?: string;
              name: string;
              rootObservationId?: string;
            };
            metadata?: string;
            name?: string;
            release?: string;
            sessionId?: string;
            tags?: Array<string>;
            traceId: string;
            userId?: string;
          };
        },
        { dropped?: number; enqueued: number; reason?: "disabled" | "backlog" },
        Name
      >;
    };
  };
