/**
 * The OTLP span attributes the encoder writes, in the order it writes them.
 * Each name is a value of `LangfuseOtelSpanAttributes` in `@langfuse/core`.
 */
export const ATTR = {
  observationType: "langfuse.observation.type",
  traceName: "langfuse.trace.name",
  userId: "user.id",
  sessionId: "session.id",
  traceTags: "langfuse.trace.tags",
  traceMetadata: "langfuse.trace.metadata",
  environment: "langfuse.environment",
  release: "langfuse.release",
  version: "langfuse.version",
  input: "langfuse.observation.input",
  output: "langfuse.observation.output",
  metadata: "langfuse.observation.metadata",
  level: "langfuse.observation.level",
  statusMessage: "langfuse.observation.status_message",
  model: "langfuse.observation.model.name",
  modelParameters: "langfuse.observation.model.parameters",
  usage: "langfuse.observation.usage_details",
  cost: "langfuse.observation.cost_details",
  promptName: "langfuse.observation.prompt.name",
  promptVersion: "langfuse.observation.prompt.version",
  completionStartTime: "langfuse.observation.completion_start_time",
  experimentId: "langfuse.experiment.id",
  experimentName: "langfuse.experiment.name",
  experimentDatasetId: "langfuse.experiment.dataset.id",
  experimentItemId: "langfuse.experiment.item.id",
  experimentItemRootObservationId:
    "langfuse.experiment.item.root_observation_id",
  experimentMetadata: "langfuse.experiment.metadata",
} as const;

export type AttributeName = (typeof ATTR)[keyof typeof ATTR];

/**
 * Instrumentation scope name of every exported span. The Langfuse server
 * treats a scope name that starts with `langfuse-sdk` as a Langfuse SDK and
 * then does not copy every span attribute into the observation metadata.
 */
export const SCOPE_NAME = "langfuse-sdk-convex";

/** Value of the `service.name` resource attribute. */
export const SERVICE_NAME = "convex-langfuse";
