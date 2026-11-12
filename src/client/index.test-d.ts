import { defineTestApp } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { expectTypeOf, test } from "vitest";
import componentTest from "../test.js";
import {
  defineScores,
  Langfuse,
  type ChatMessage,
  type Recorded,
} from "./index.js";

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

test("a defined score takes only values of its type", () => {
  const langfuse = new Langfuse(component, {
    content: "full",
    scores: defineScores({
      helpful: { dataType: "BOOLEAN" },
      rating: { dataType: "NUMERIC", min: 1, max: 5 },
      tone: { dataType: "CATEGORICAL", categories: ["formal", "casual"] },
    }),
  });
  const trace = { seed: "s" };
  app.mutation({
    args: {},
    handler: async (ctx) => {
      await langfuse.score(ctx, { name: "helpful", value: true, trace });
      await langfuse.score(ctx, { name: "rating", value: 4, trace });
      await langfuse.score(ctx, { name: "tone", value: "casual", trace });
      // @ts-expect-error a boolean score takes a boolean
      await langfuse.score(ctx, { name: "helpful", value: 1, trace });
      // @ts-expect-error a numeric score takes a number
      await langfuse.score(ctx, { name: "rating", value: "4", trace });
      // @ts-expect-error a categorical score takes one of its categories
      await langfuse.score(ctx, { name: "tone", value: "rude", trace });
      // @ts-expect-error only defined names
      await langfuse.score(ctx, { name: "unknown", value: 1, trace });
      expectTypeOf(
        await langfuse.score(ctx, {
          name: "rating",
          value: 4,
          trace,
          id: "id",
          timestamp: 1,
        }),
      ).toEqualTypeOf<{ scoreId: string }>();
      // @ts-expect-error an id requires a timestamp
      await langfuse.score(ctx, { name: "rating", value: 4, trace, id: "id" });
    },
  });
});

test("without definitions a score takes any name and a boolean, number or string", () => {
  const langfuse = new Langfuse(component, { content: "full" });
  app.mutation({
    args: {},
    handler: async (ctx) => {
      await langfuse.score(ctx, {
        name: "a",
        value: true,
        trace: { seed: "s" },
      });
      await langfuse.score(ctx, {
        name: "b",
        value: "x",
        trace: { traceId: "t" },
      });
      // @ts-expect-error not an object
      await langfuse.score(ctx, { name: "c", value: {}, trace: { seed: "s" } });
    },
  });
  app.action({
    args: {},
    handler: async (ctx) => {
      await langfuse.syncScoreConfigs(ctx);
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

test("prompts: get takes a label or a version, pin needs a mutation or action ctx", () => {
  const { prompts } = new Langfuse(component, { content: "full" });
  app.query({
    args: {},
    handler: async (ctx) => {
      const prompt = await prompts.get(ctx, { name: "n", label: "staging" });
      await prompts.get(ctx, { name: "n", version: 3 });
      // @ts-expect-error a label and a version together
      await prompts.get(ctx, { name: "n", label: "staging", version: 3 });
      // @ts-expect-error a query cannot pin
      await prompts.pin(ctx, { scope: "s", name: "n" });
      if (prompt?.type === "chat") {
        expectTypeOf(prompt.prompt).toEqualTypeOf<ChatMessage[]>();
      } else if (prompt) {
        expectTypeOf(prompt.prompt).toEqualTypeOf<string>();
      }
    },
  });
  app.mutation({
    args: {},
    handler: async (ctx) => {
      await prompts.pin(ctx, {
        scope: "s",
        name: "n",
        fallback: { type: "chat", prompt: [{ role: "user", content: "c" }] },
      });
      await prompts.pin(ctx, {
        scope: "s",
        name: "n",
        // @ts-expect-error a chat fallback takes messages
        fallback: { type: "chat", prompt: "text" },
      });
    },
  });
  app.action({
    args: {},
    handler: async (ctx) => {
      await prompts.sync(ctx, { names: ["n"] });
      await prompts.pin(ctx, { scope: "s", name: "n" });
    },
  });
});
