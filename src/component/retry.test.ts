import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { withPauses } from "./retry.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A run that throws `failures` times and then returns `"done"`. */
function failing(failures: number) {
  let calls = 0;
  const run = async () => {
    calls += 1;
    if (calls <= failures) throw new Error(`failure ${calls}`);
    return "done";
  };
  return { run, calls: () => calls };
}

test("a run that succeeds is called once and not delayed", async () => {
  const { run, calls } = failing(0);
  const started = Date.now();
  expect(await withPauses(run, [250, 1_000])).toBe("done");
  expect(calls()).toBe(1);
  expect(Date.now()).toBe(started);
});

test("a run that throws is called again after each pause", async () => {
  const { run, calls } = failing(2);
  const started = Date.now();
  const result = withPauses(run, [250, 1_000]);
  await vi.advanceTimersByTimeAsync(249);
  expect(calls()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls()).toBe(2);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await result).toBe("done");
  expect(calls()).toBe(3);
  expect(Date.now()).toBe(started + 1_250);
});

test("a run that keeps throwing ends with its last error", async () => {
  const { run, calls } = failing(3);
  const result = withPauses(run, [250, 1_000]);
  const settled = expect(result).rejects.toThrow("failure 3");
  await vi.advanceTimersByTimeAsync(1_250);
  await settled;
  expect(calls()).toBe(3);
});
