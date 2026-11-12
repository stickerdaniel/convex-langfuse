import { defineTestApp } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { expectTypeOf, test } from "vitest";
import componentTest from "../test.js";
import { Langfuse, type Recorded } from "./index.js";

// An app with a table of its own: its ctx types carry a concrete data model.
const app = defineTestApp({
  schema: defineSchema({ notes: defineTable({ body: v.string() }) }),
  components: { convexLangfuse: componentTest },
});
const component = app.components.convexLangfuse;

test("content is required", () => {
  // @ts-expect-error content has no default
  new Langfuse(component, {});
  // @ts-expect-error content is "full" or "none"
  new Langfuse(component, { content: "partial" });
  new Langfuse(component, { content: "none" });
});

test("a trace is named by a seed or an id, an observation by a key or an id", () => {
  const langfuse = new Langfuse(component, { content: "full" });
  // @ts-expect-error a trace needs a seed or an id
  langfuse.trace({ name: "chat" });
  // @ts-expect-error not both
  langfuse.trace({ seed: "s", traceId: "t" });
  app.mutation({
    args: {},
    handler: async (ctx) => {
      const trace = langfuse.trace({ seed: "s" });
      // @ts-expect-error not both
      await trace.span(ctx, { key: "k", id: "i", name: "n" });
    },
  });
});

test("generation accepts the mutation and action ctx of an app", () => {
  const trace = new Langfuse(component, { content: "full" }).trace({
    seed: "s",
  });
  app.mutation({
    args: {},
    handler: async (ctx) => {
      await ctx.db.insert("notes", { body: "b" });
      expectTypeOf(
        await trace.generation(ctx, { key: "k", name: "n" }),
      ).toEqualTypeOf<Recorded>();
    },
  });
  app.action({
    args: {},
    handler: async (ctx) => {
      expectTypeOf(
        await trace.generation(ctx, { key: "k", name: "n" }),
      ).toEqualTypeOf<Recorded>();
    },
  });
  app.query({
    args: {},
    handler: async (ctx) => {
      // @ts-expect-error a query cannot record
      await trace.generation(ctx, { key: "k", name: "n" });
    },
  });
});
