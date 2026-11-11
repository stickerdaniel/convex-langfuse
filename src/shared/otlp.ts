// OTLP/JSON encoding of observations for the Langfuse endpoint
// POST /api/public/otel/v1/traces. Spans are encoded once into strings and
// later joined into request bodies without re-serializing.

import {
  ATTR,
  SCOPE_NAME,
  SERVICE_NAME,
  type AttributeName,
} from "./attributes.js";
import type { Observation, TraceContext } from "./validators.js";

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { arrayValue: { values: { stringValue: string }[] } };

type KeyValue = { key: AttributeName; value: AnyValue };

// OTLP SpanKind INTERNAL and StatusCode ERROR.
const SPAN_KIND_INTERNAL = 1;
const STATUS_CODE_ERROR = 2;

const encoder = new TextEncoder();

function toUnixNano(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

function stringValue(value: string | undefined): AnyValue | undefined {
  return value === undefined ? undefined : { stringValue: value };
}

/** Keeps non-negative safe integers. The server sums usage into `total` itself. */
function usageDetails(usage: Record<string, number>): string | undefined {
  const kept = Object.entries(usage).filter(
    ([, value]) => Number.isSafeInteger(value) && value >= 0,
  );
  return kept.length === 0
    ? undefined
    : JSON.stringify(Object.fromEntries(kept));
}

/**
 * Keeps finite numbers and appends `total` when it is missing. Langfuse derives
 * a total cost only when every key is `input` or `output`; with any other key
 * and no `total`, the observation would show no cost. Writes no cost at all
 * when the sum is not finite, because JSON would turn that total into `null`.
 */
function costDetails(cost: Record<string, number>): string | undefined {
  const kept = Object.fromEntries(
    Object.entries(cost).filter(([, value]) => Number.isFinite(value)),
  );
  const values = Object.values(kept);
  if (values.length === 0) return undefined;
  if (!("total" in kept)) {
    const sum = values.reduce((total, value) => total + value, 0);
    if (!Number.isFinite(sum)) return undefined;
    kept.total = Number(sum.toFixed(12));
  }
  return JSON.stringify(kept);
}

/**
 * Encodes one observation as one OTLP/JSON span object and returns it as a
 * JSON string. Deterministic: equal input gives equal output. Every span
 * carries the full trace context. Absent fields produce no attribute.
 */
export function encodeSpan(
  trace: TraceContext,
  observation: Observation,
): string {
  const { experiment } = trace;
  const isGeneration = observation.type === "generation";
  const promptVersion = observation.prompt?.version;

  const candidates: [AttributeName, AnyValue | undefined][] = [
    [ATTR.observationType, { stringValue: observation.type }],
    [ATTR.traceName, stringValue(trace.name)],
    [ATTR.userId, stringValue(trace.userId)],
    [ATTR.sessionId, stringValue(trace.sessionId)],
    [
      ATTR.traceTags,
      trace.tags && trace.tags.length > 0
        ? {
            arrayValue: {
              values: trace.tags.map((tag) => ({ stringValue: tag })),
            },
          }
        : undefined,
    ],
    [ATTR.traceMetadata, stringValue(trace.metadata)],
    [ATTR.environment, stringValue(trace.environment)],
    [ATTR.release, stringValue(trace.release)],
    [ATTR.version, stringValue(observation.version)],
    [ATTR.input, stringValue(observation.input)],
    [ATTR.output, stringValue(observation.output)],
    [ATTR.metadata, stringValue(observation.metadata)],
    [ATTR.level, stringValue(observation.level)],
    [ATTR.statusMessage, stringValue(observation.statusMessage)],
    [ATTR.model, stringValue(observation.model)],
    [ATTR.modelParameters, stringValue(observation.modelParameters)],
    [
      ATTR.usage,
      stringValue(observation.usage && usageDetails(observation.usage)),
    ],
    [ATTR.cost, stringValue(observation.cost && costDetails(observation.cost))],
    [
      ATTR.promptName,
      isGeneration ? stringValue(observation.prompt?.name) : undefined,
    ],
    [
      ATTR.promptVersion,
      isGeneration &&
      promptVersion !== undefined &&
      Number.isSafeInteger(promptVersion) &&
      promptVersion > 0
        ? { intValue: String(promptVersion) }
        : undefined,
    ],
    [
      ATTR.completionStartTime,
      observation.completionStartTime === undefined
        ? undefined
        : {
            stringValue: new Date(
              observation.completionStartTime,
            ).toISOString(),
          },
    ],
    [ATTR.experimentId, stringValue(experiment?.id)],
    [ATTR.experimentName, stringValue(experiment?.name)],
    [ATTR.experimentDatasetId, stringValue(experiment?.datasetId)],
    [ATTR.experimentItemId, stringValue(experiment?.itemId)],
    [
      ATTR.experimentItemRootObservationId,
      stringValue(experiment?.rootObservationId),
    ],
    [ATTR.experimentMetadata, stringValue(experiment?.metadata)],
  ];
  const attributes: KeyValue[] = candidates.flatMap(([key, value]) =>
    value === undefined ? [] : [{ key, value }],
  );

  const endTime = Math.max(observation.startTime, observation.endTime);
  return JSON.stringify({
    traceId: trace.traceId,
    spanId: observation.id,
    ...(observation.parentId === undefined
      ? {}
      : { parentSpanId: observation.parentId }),
    name: observation.name,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: toUnixNano(observation.startTime),
    endTimeUnixNano: toUnixNano(endTime),
    attributes,
    ...(observation.level === "ERROR"
      ? {
          status: {
            code: STATUS_CODE_ERROR,
            ...(observation.statusMessage === undefined
              ? {}
              : { message: observation.statusMessage }),
          },
        }
      : {}),
  });
}

/**
 * Builds the body of POST /api/public/otel/v1/traces from spans returned by
 * `encodeSpan`, by string concatenation. The resource carries no
 * `service.version`, because the server would use it as the observation
 * version.
 */
export function buildExportBody(
  spans: readonly string[],
  scopeVersion: string,
): string {
  const resource = JSON.stringify({
    attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAME } }],
  });
  const scope = JSON.stringify({ name: SCOPE_NAME, version: scopeVersion });
  return `{"resourceSpans":[{"resource":${resource},"scopeSpans":[{"scope":${scope},"spans":[${spans.join(",")}]}]}]}`;
}

/** UTF-8 byte length. */
export function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}
