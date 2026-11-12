// Score measures the client and the component share, so both sides decide
// alike.

import { sha256Hex } from "./hash.js";
import { byteLength } from "./otlp.js";

/** A score definition as `scores.syncConfigs` takes it. */
export type ConfigDefinition = {
  name: string;
  dataType: "BOOLEAN" | "NUMERIC" | "CATEGORICAL";
  min?: number;
  max?: number;
  categories?: readonly string[];
};

/**
 * SHA-256 hex over the canonical JSON of a definition: the keys `name`,
 * `dataType`, `min`, `max` and `categories` in this order, absent ones left
 * out. A synced score config stores it for the definition it was synced for,
 * and the client passes it with a score for the current definition of the
 * score's name, so the component attaches a config id only while both match.
 */
export async function definitionFingerprint({
  name,
  dataType,
  min,
  max,
  categories,
}: ConfigDefinition): Promise<string> {
  return await sha256Hex(
    JSON.stringify({ name, dataType, min, max, categories }),
  );
}

/** The fields of a score as the caller of `scores.upsert` passes them. */
export type ScoreFields = {
  id: string;
  /** Epoch milliseconds. */
  timestamp: number;
  name: string;
  value: number | string;
  dataType: string;
  traceId: string;
  observationId?: string;
  comment?: string;
  /** A JSON object string. */
  metadata?: string;
  environment?: string;
};

/**
 * The UTF-8 bytes of a score from the caller's fields, the size both the
 * client and the component hold against `MAX_ROW_BYTES`.
 *
 * It leaves out what the component adds to the request body. The ISO
 * timestamp adds at most 28 bytes over the number, the default environment
 * at most 57 bytes (40 characters), and the config id 14 bytes plus its
 * length, 50 bytes for the UUID Langfuse 4.78.0 gives a config. The
 * component measures `metadata` as it re-serializes it, and the stored
 * object is shorter than that string. A stored score body therefore has at
 * most `MAX_ROW_BYTES` + 135 = 921,735 bytes, below the 1 MiB of a Convex
 * document.
 */
export function scoreBytes(fields: ScoreFields): number {
  const { id, timestamp, name, value, dataType, traceId } = fields;
  const { observationId, comment, metadata, environment } = fields;
  return byteLength(
    JSON.stringify({
      id,
      timestamp,
      name,
      value,
      dataType,
      traceId,
      observationId,
      comment,
      metadata,
      environment,
    }),
  );
}
