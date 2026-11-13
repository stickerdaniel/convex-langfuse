import { defineComponent } from "convex/server";
import { v } from "convex/values";
import batchWorker from "@convex-dev/batch-worker/convex.config.js";

// Every value is optional, so an app can install the component without
// binding any of them. The component exports only when the public key, the
// secret key and the base URL are all set.
const component = defineComponent("convexLangfuse", {
  env: {
    LANGFUSE_PUBLIC_KEY: v.optional(v.string()),
    LANGFUSE_SECRET_KEY: v.optional(v.string()),
    LANGFUSE_BASE_URL: v.optional(v.string()),
    LANGFUSE_TRACING_ENVIRONMENT: v.optional(v.string()),
    LANGFUSE_RELEASE: v.optional(v.string()),
    LANGFUSE_WEBHOOK_SECRET: v.optional(v.string()),
    LANGFUSE_SKILL_WEBHOOK_SECRET: v.optional(v.string()),
  },
});
component.use(batchWorker);

export default component;
