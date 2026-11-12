import { defineApp } from "convex/server";
import { v } from "convex/values";
import convexLangfuse from "convex-langfuse/convex.config.js";

// The app declares the Langfuse settings and binds them to the component by
// reference; the contract runner sets them with `npx convex env set`. The
// prompt webhook is served at `<site url>/langfuse/prompt-webhook`.
const app = defineApp({
  env: {
    LANGFUSE_PUBLIC_KEY: v.optional(v.string()),
    LANGFUSE_SECRET_KEY: v.optional(v.string()),
    LANGFUSE_BASE_URL: v.optional(v.string()),
    LANGFUSE_TRACING_ENVIRONMENT: v.optional(v.string()),
    LANGFUSE_WEBHOOK_SECRET: v.optional(v.string()),
  },
});
app.use(convexLangfuse, {
  httpPrefix: "/langfuse/",
  env: {
    LANGFUSE_PUBLIC_KEY: app.env.LANGFUSE_PUBLIC_KEY,
    LANGFUSE_SECRET_KEY: app.env.LANGFUSE_SECRET_KEY,
    LANGFUSE_BASE_URL: app.env.LANGFUSE_BASE_URL,
    LANGFUSE_TRACING_ENVIRONMENT: app.env.LANGFUSE_TRACING_ENVIRONMENT,
    LANGFUSE_WEBHOOK_SECRET: app.env.LANGFUSE_WEBHOOK_SECRET,
  },
});

export default app;
