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
