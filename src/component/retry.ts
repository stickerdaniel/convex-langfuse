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
