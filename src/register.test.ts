import { afterEach, expect, test, vi } from "vitest";
import { components, initConvexTest } from "./client/setup.test.js";
import {
  drive,
  enableExport,
  installFakeLangfuse,
  observation,
  TRACE,
} from "./component/fakeLangfuse.test-util.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("an app that registers the component through the test helper can export", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  enableExport();
  const fake = installFakeLangfuse();
  // `register` also mounts the batch-worker child that drives the exporter.
  const t = initConvexTest();
  expect(
    await t.mutation(components.convexLangfuse.tracing.record, {
      trace: TRACE,
      observations: [observation(0)],
    }),
  ).toEqual({ enqueued: 1 });
  await drive(t as never, fake);
  expect(fake.requests).toHaveLength(1);
});
