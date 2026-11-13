/**
 * Runs `run`, and again after each pause of `pausesMs` when it throws.
 * Returns the first result and throws what the last attempt threw. For work
 * that leaves nothing behind when it throws, such as one mutation.
 */
export async function withPauses<T>(
  run: () => Promise<T>,
  pausesMs: readonly number[],
): Promise<T> {
  for (const pause of pausesMs) {
    try {
      return await run();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
  return await run();
}

/** Parses `Retry-After`, given in seconds or as an HTTP date. */
export function parseRetryAfter(
  value: string | null,
  now: number,
): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
