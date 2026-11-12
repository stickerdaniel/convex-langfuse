import { defineApp } from "convex/server";
import { v } from "convex/values";
import convexLangfuse from "convex-langfuse/convex.config.js";

// The app declares the Langfuse settings and binds them to the component by
// reference, so `npx convex env set` changes what the component sees.
const app = defineApp({
  env: {
    LANGFUSE_PUBLIC_KEY: v.optional(v.string()),
    LANGFUSE_SECRET_KEY: v.optional(v.string()),
    LANGFUSE_BASE_URL: v.optional(v.string()),
    LANGFUSE_TRACING_ENVIRONMENT: v.optional(v.string()),
  },
});
app.use(convexLangfuse, {
  env: {
    LANGFUSE_PUBLIC_KEY: app.env.LANGFUSE_PUBLIC_KEY,
    LANGFUSE_SECRET_KEY: app.env.LANGFUSE_SECRET_KEY,
    LANGFUSE_BASE_URL: app.env.LANGFUSE_BASE_URL,
    LANGFUSE_TRACING_ENVIRONMENT: app.env.LANGFUSE_TRACING_ENVIRONMENT,
  },
});

export default app;
