import { defineApp } from "convex/server";
import { v } from "convex/values";
import convexLangfuse from "@stickerdaniel/convex-langfuse/convex.config.js";

// The app declares the Langfuse settings and binds them to the component by
// reference, so `npx convex env set` changes what the component sees. The
// component's routes, such as the prompt webhook, are served under
// `/langfuse/`.
const app = defineApp({
  env: {
    LANGFUSE_PUBLIC_KEY: v.optional(v.string()),
    LANGFUSE_SECRET_KEY: v.optional(v.string()),
    LANGFUSE_BASE_URL: v.optional(v.string()),
    LANGFUSE_WEBHOOK_SECRET: v.optional(v.string()),
  },
});
app.use(convexLangfuse, {
  httpPrefix: "/langfuse/",
  env: {
    LANGFUSE_PUBLIC_KEY: app.env.LANGFUSE_PUBLIC_KEY,
    LANGFUSE_SECRET_KEY: app.env.LANGFUSE_SECRET_KEY,
    LANGFUSE_BASE_URL: app.env.LANGFUSE_BASE_URL,
    LANGFUSE_WEBHOOK_SECRET: app.env.LANGFUSE_WEBHOOK_SECRET,
  },
});

export default app;
