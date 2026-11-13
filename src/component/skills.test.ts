import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import {
  MAX_SKILL_NAMES,
  PROMPT_TIMEOUT_MS,
  SKILL_LIST_INTERVAL_MS,
  SKILL_REQUEST_SPACING_MS,
  SKILL_WORKER_NAME,
} from "./constants.js";
import {
  enableExport,
  installFakeLangfuse,
  refusalCode,
  type FakeLangfuse,
  type RecordedRequest,
  type TestConvex,
} from "./fakeLangfuse.test-util.js";
import { signature } from "./fakePrompts.test-util.js";
import {
  driveSkills,
  FakeSkills,
  sha256Base64,
  SKILL_WEBHOOK_SECRET,
  skillEvent,
  skillFiles,
  type SkillFile,
} from "./fakeSkills.test-util.js";
import { initConvexTest } from "./setup.test.js";

// The tests over hundreds of names run thousands of loop steps.
vi.setConfig({ testTimeout: 120_000 });

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NAME = "weather-report";

let t: TestConvex;
let fake: FakeLangfuse;
let skills: FakeSkills;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-13T12:00:00.000Z"));
  enableExport();
  vi.stubEnv("LANGFUSE_SKILL_WEBHOOK_SECRET", SKILL_WEBHOOK_SECRET);
  fake = installFakeLangfuse();
  skills = new FakeSkills();
  fake.fallback = (request) => skills.answer(request);
  t = initConvexTest();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Selector = { label?: "production" | "latest"; version?: number };

const get = (name: string, selector: Selector = {}) =>
  t.query(api.skills.get, { name, ...selector });

const health = async () => (await t.query(api.outbox.health, {})).skills;

const sync = (names?: string[]) =>
  t.mutation(api.skills.sync, names ? { names } : {});

/**
 * Runs the loop until `until` holds and throws when it does not within
 * `maxMs` of fake time.
 */
async function run(
  until: () => boolean | Promise<boolean>,
  maxMs = 10 * MINUTE,
  onStep?: () => void | Promise<void>,
): Promise<void> {
  await driveSkills(t, fake, { until, maxMs, onStep });
  if (!(await until())) throw new Error("run: the condition never held");
}

/** Moves the fake clock by `ms` in steps of at most 100 ms. */
async function runFor(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await driveSkills(t, fake, { maxMs: 0 });
    await vi.advanceTimersByTimeAsync(Math.min(100, end - Date.now()));
  }
  await driveSkills(t, fake, { maxMs: 0 });
}

async function deliver(body: string, header: string | null = null) {
  return await t.fetch("/skill-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-langfuse-signature":
        header ?? signature(body, Date.now(), SKILL_WEBHOOK_SECRET),
    },
    body,
  });
}

/** Delivers a signed `skill-version` event for `name`. */
async function notify(name: string): Promise<void> {
  expect((await deliver(skillEvent(skills, name))).status).toBe(200);
}

const pathOf = (request: RecordedRequest) => new URL(request.url).pathname;
const labelOf = (request: RecordedRequest) =>
  new URL(request.url).searchParams.get("label");
const pageOf = (request: RecordedRequest) =>
  Number(new URL(request.url).searchParams.get("page"));
/** Every request to the skill API, in order. */
const skillRequests = () =>
  fake.requests.filter((request) =>
    pathOf(request).startsWith("/api/public/skills"),
  );
/** The label GETs of `name`, in order. */
const gets = (name: string) =>
  fake.requests.filter(
    (request) => pathOf(request) === `/api/public/skills/${name}`,
  );
/** The `production` GETs of `name`, in order: one per refresh. */
const productionGets = (name: string) =>
  gets(name).filter((request) => labelOf(request) === "production");
const listings = () =>
  fake.requests.filter((request) => pathOf(request) === "/api/public/skills");
/** Gaps between consecutive request starts, in fake milliseconds. */
const gaps = (requests: RecordedRequest[]) =>
  requests.slice(1).map((request, i) => request.at - requests[i]!.at);

/** Whether `get` returns `version` (or `null`) for the selector. */
const serves =
  (name: string, version: number | null, selector: Selector = {}) =>
  async () =>
    ((await get(name, selector))?.version ?? null) === version;

const skillNames = (prefix: string, count: number) =>
  Array.from(
    { length: count },
    (_, i) => `${prefix}-${String(i).padStart(3, "0")}`,
  );

/** The skill tables, for the tests whose property is stored state. */
async function stored() {
  return await t.run(async (ctx) => ({
    names: await ctx.db.query("skillNames").collect(),
    versions: await ctx.db.query("skillVersions").collect(),
    files: await ctx.db.query("skillFiles").collect(),
  }));
}

const workerStatus = () =>
  t.run(async (ctx) =>
    ctx.runQuery(components.batchWorker.lib.status, {
      name: SKILL_WORKER_NAME,
    }),
  );

/**
 * Leaves the loop idle with no run scheduled, as a loop transaction that
 * read no work leaves it: batch-worker confirms only a `batch`, so such a
 * transaction misses work that is due later, and a `ping` while it runs
 * does nothing. The loop restarts while the component sees no
 * configuration, so its query finds no work; `whileRunning` runs while it
 * polls, and the configuration returns once it is idle, 2.5 s later.
 */
async function strandLoop(whileRunning?: () => Promise<void>): Promise<void> {
  const name = SKILL_WORKER_NAME;
  await t.run(async (ctx) => {
    await ctx.runMutation(components.batchWorker.lib.stop, { name });
  });
  vi.stubEnv("LANGFUSE_BASE_URL", "");
  await t.run(async (ctx) => {
    await ctx.runMutation(components.batchWorker.lib.start, { name });
  });
  await runFor(1_900);
  await whileRunning?.();
  await runFor(600);
  enableExport();
  expect(await workerStatus()).toEqual({ kind: "idle" });
}

/** Tracks `name` in mode `names` and waits until its `latest` is cached. */
async function cached(name: string, version = 1): Promise<void> {
  await sync([name]);
  await run(serves(name, version, { label: "latest" }));
}

/** Lets the first listing walk of mode `all` end. */
async function firstWalk(): Promise<void> {
  await run(async () => (await health()).lastListAt !== undefined);
}

describe("refresh", () => {
  test("a synced skill serves both labels with sorted files, and skips latest when production holds it", async () => {
    skills.add(NAME);
    expect(await sync([NAME])).toEqual({ status: "ok", tracked: 1 });
    await run(serves(NAME, 1));

    const production = await get(NAME);
    expect(production).toMatchObject({
      name: NAME,
      version: 1,
      description: "Writes a short weather report from a forecast.",
      frontmatter: JSON.stringify({
        description: "Writes a short weather report from a forecast.",
        name: NAME,
      }),
    });
    expect(production!.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "reference/units.md",
      "scripts/round.py",
    ]);
    expect(production!.files).toEqual(expect.arrayContaining(skillFiles(NAME)));
    expect(await get(NAME, { label: "latest" })).toEqual(production);
    expect(gets(NAME).map(labelOf)).toEqual(["production"]);

    skills.add(NAME, { files: skillFiles(NAME, "two sentences"), labels: [] });
    await notify(NAME);
    await run(serves(NAME, 2, { label: "latest" }));

    expect(gets(NAME).map(labelOf)).toEqual([
      "production",
      "production",
      "latest",
    ]);
    const latest = await get(NAME, { label: "latest" });
    expect(latest!.snapshotId).not.toBe(production!.snapshotId);
    expect(await get(NAME)).toEqual(production);

    // Another version with the files of version 1 has its snapshot id.
    skills.add(NAME, { labels: [] });
    await notify(NAME);
    await run(serves(NAME, 3, { label: "latest" }));
    const copy = await get(NAME, { label: "latest" });
    expect(copy!.snapshotId).toBe(production!.snapshotId);
  });

  test("a skill with only latest serves latest; a 404 for production removes that pointer and keeps latest", async () => {
    skills.add(NAME, { labels: [] });
    await cached(NAME);
    expect(await get(NAME)).toBeNull();

    skills.move(NAME, 1, "production");
    await notify(NAME);
    await run(serves(NAME, 1));

    skills.unlabel(NAME, "production");
    await notify(NAME);
    await run(serves(NAME, null));
    expect((await get(NAME, { label: "latest" }))?.version).toBe(1);
  });

  test("get({ version }) serves a version a label held within 7 days, not later", async () => {
    skills.add(NAME);
    await cached(NAME);
    skills.add(NAME);
    await notify(NAME);
    await run(serves(NAME, 2));

    expect((await get(NAME, { version: 1 }))?.version).toBe(1);
    vi.setSystemTime(Date.now() + 7 * DAY - MINUTE);
    expect((await get(NAME, { version: 1 }))?.version).toBe(1);
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    expect(await get(NAME, { version: 1 })).toBeNull();
    expect((await get(NAME, { version: 2 }))?.version).toBe(2);
  });

  test("a refused production version leaves latest refreshed", async () => {
    skills.add(NAME);
    skills.add(NAME, { labels: [] });
    skills.mangle = (body) => {
      if (body.version === 1) {
        (body.files as Array<Record<string, unknown>>)[0]!.sha256Hash =
          sha256Base64("other");
      }
    };
    await sync([NAME]);
    await run(serves(NAME, 2, { label: "latest" }));

    expect(await get(NAME)).toBeNull();
    expect((await health()).errors).toBe(1);
  });

  test("get({ version }) serves the held version among more than 100 recreations", async () => {
    skills.add(NAME);
    await cached(NAME);
    await t.run(async (ctx) => {
      const held = (await ctx.db.query("skillVersions").first())!;
      for (let i = 0; i < 101; i++) {
        await ctx.db.insert("skillVersions", {
          ...held,
          _id: undefined,
          _creationTime: undefined,
          remoteId: `old-${i}`,
          description: `old ${i}`,
          publishedAt: held.publishedAt! + 1 + i,
        } as never);
      }
    });

    expect(await get(NAME, { version: 1 })).toEqual(await get(NAME));
  });

  test("get({ version }) serves the later publication when both labels hold that number", async () => {
    skills.add(NAME);
    await cached(NAME);
    // A recreation between the two GETs: latest holds a newer version 1.
    await t.run(async (ctx) => {
      const old = (await ctx.db.query("skillVersions").first())!;
      const { _id, _creationTime, ...fields } = old;
      const id = await ctx.db.insert("skillVersions", {
        ...fields,
        remoteId: "recreated-id",
        description: "Recreated",
        // One `publish` stamps both versions with the same time.
        publishedAt: old.publishedAt!,
      });
      const files = await ctx.db
        .query("skillFiles")
        .withIndex("by_version", (q) => q.eq("versionId", _id))
        .collect();
      for (const { path, content } of files) {
        await ctx.db.insert("skillFiles", { versionId: id, path, content });
      }
      const latest = (await ctx.db
        .query("skillLabels")
        .withIndex("by_name_label", (q) =>
          q.eq("name", NAME).eq("label", "latest"),
        )
        .unique())!;
      await ctx.db.patch("skillLabels", latest._id, {
        versionId: id,
        remoteId: "recreated-id",
      });
    });

    expect((await get(NAME, { version: 1 }))?.description).toBe("Recreated");
  });

  test("get refuses a label and a version together, a bad version and a bad name", async () => {
    expect(
      await refusalCode(
        t.query(api.skills.get, {
          name: NAME,
          label: "latest",
          version: 1,
        }),
      ),
    ).toBe("invalid_skill_selector");
    expect(await refusalCode(get(NAME, { version: 1.5 }))).toBe(
      "invalid_skill_selector",
    );
    expect(await refusalCode(get("Weather_Report"))).toBe("invalid_skill_name");
    expect(await refusalCode(sync(["a".repeat(65)]))).toBe(
      "invalid_skill_name",
    );
  });
});

describe("validation", () => {
  const big = (bytes: number): SkillFile[] => [
    ...skillFiles(NAME),
    { path: "reference/a.md", content: "a".repeat(bytes / 2) },
    { path: "reference/b.md", content: "b".repeat(bytes / 2) },
  ];
  const nested = (levels: number): Record<string, unknown> => {
    let value: Record<string, unknown> = { leaf: "x" };
    for (let i = 1; i < levels; i++) value = { inner: value };
    return value;
  };
  type Files = Array<Record<string, unknown>>;
  const cases: Array<[string, (version: number) => void]> = [
    [
      "a hash that does not match the content",
      () => {
        skills.mangle = (body) => {
          (body.files as Files)[0]!.sha256Hash = sha256Base64("other");
        };
      },
    ],
    [
      "a file without content",
      () => {
        skills.mangle = (body) => {
          delete (body.files as Files)[0]!.content;
        };
      },
    ],
    [
      "a duplicate path",
      () => {
        skills.mangle = (body) => {
          const files = body.files as Files;
          files[2]!.path = files[0]!.path;
        };
      },
    ],
    [
      "no SKILL.md",
      () => {
        skills.mangle = (body) => {
          for (const file of body.files as Files) {
            if (file.path === "SKILL.md") file.path = "README.md";
          }
        };
      },
    ],
    ...["../units.md", "/units.md", "reference//units.md", "a\\b.md"].map(
      (path): [string, () => void] => [
        `the path ${JSON.stringify(path)}`,
        () => {
          skills.mangle = (body) => {
            (body.files as Files)[0]!.path = path;
          };
        },
      ],
    ),
  ];
  test.each(cases)(
    "%s is refused, the old pointer stays and health reports it",
    async (_, mangle) => {
      skills.add(NAME);
      await cached(NAME);
      const version = skills.add(NAME);
      const original = skills.mangle;
      mangle(version);
      const mangleVersion = skills.mangle;
      skills.mangle = (body) => {
        if (body.version === version) mangleVersion?.(body);
        original?.(body);
      };
      await notify(NAME);
      await run(async () => (await health()).errors === 1);

      expect((await health()).errors).toBe(1);
      expect((await get(NAME))?.version).toBe(1);
      expect(await get(NAME, { version })).toBeNull();
    },
  );

  test.each([
    ["more than 1,000,000 content bytes", () => ({ files: big(1_000_000) })],
    [
      "201 files",
      () => ({
        files: [
          ...skillFiles(NAME),
          ...Array.from({ length: 198 }, (_, i) => ({
            path: `reference/${i}.md`,
            content: "x",
          })),
        ],
      }),
    ],
    ["a frontmatter 16 levels deep", () => ({ frontmatter: nested(16) })],
    [
      "a frontmatter over 64 KiB",
      () => ({ frontmatter: { note: "x".repeat(64 * 1024) } }),
    ],
  ])(
    "a version with %s is refused and the old pointer stays",
    async (_, version) => {
      skills.add(NAME);
      await cached(NAME);
      skills.add(NAME, version());
      await notify(NAME);
      await run(async () => (await health()).errors === 1);

      expect((await health()).errors).toBe(1);
      expect((await get(NAME))?.version).toBe(1);
      expect(await get(NAME, { version: 2 })).toBeNull();
    },
  );

  test("a version at the bounds is cached: 1,000,000 bytes, 200 files, 15 levels", async () => {
    const files = [
      ...skillFiles(NAME),
      ...Array.from({ length: 197 }, (_, i) => ({
        path: `reference/${String(i).padStart(3, "0")}.md`,
        content: "x",
      })),
    ];
    const used = files.reduce((sum, file) => sum + file.content.length, 0);
    files[3]!.content += "y".repeat(1_000_000 - used);
    skills.add(NAME, { files, frontmatter: nested(15) });
    await cached(NAME);

    const skill = await get(NAME);
    expect(skill!.files).toHaveLength(200);
    expect(
      skill!.files.reduce((sum, file) => sum + file.content.length, 0),
    ).toBe(1_000_000);
  });
});

describe("webhook route", () => {
  test("answers 404 without the secret, 401 for a missing, wrong or stale signature, 400 for a signed non-event", async () => {
    await sync([NAME]);
    const body = skillEvent(skills, NAME);
    const post = (header?: string) =>
      t.fetch("/skill-webhook", {
        method: "POST",
        headers: header ? { "x-langfuse-signature": header } : {},
        body,
      });
    expect((await post()).status).toBe(401);
    expect(
      (await post(signature(body, Date.now(), "lf-whsec_other"))).status,
    ).toBe(401);
    expect(
      (
        await post(
          signature(body, Date.now() - 6 * MINUTE, SKILL_WEBHOOK_SECRET),
        )
      ).status,
    ).toBe(401);
    // The prompt route's secret does not sign skill events.
    expect((await post(signature(body))).status).toBe(401);
    expect((await deliver("[1]")).status).toBe(400);
    expect((await deliver("1")).status).toBe(400);
    expect((await deliver("not json")).status).toBe(400);
    const accepted = await deliver(body);
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("");
    // Another event type is acknowledged and ignored.
    const prompt = JSON.stringify({
      type: "prompt-version",
      prompt: { name: NAME },
    });
    expect((await deliver(prompt)).status).toBe(200);

    vi.stubEnv("LANGFUSE_SKILL_WEBHOOK_SECRET", "");
    expect((await deliver(body)).status).toBe(404);
  });

  test("a delivery requests a tracked name; in mode names an unknown name is ignored, in mode all it is tracked", async () => {
    skills.add(NAME);
    skills.add("other-skill");
    await sync(["other-skill"]);
    await notify(NAME);
    expect((await health()).tracked).toBe(1);

    await sync();
    await notify(NAME);
    expect((await health()).tracked).toBe(2);
    await run(serves(NAME, 1));
  });
});

describe("wake", () => {
  test("the first webhook into an empty cache is fetched at its 2 s due time without further traffic", async () => {
    await sync();
    await firstWalk();
    await runFor(30 * SECOND);
    skills.add(NAME);
    const at = Date.now();
    await notify(NAME);
    await run(serves(NAME, 1));

    const first = gets(NAME)[0]!.at - at;
    expect(first).toBeGreaterThanOrEqual(2 * SECOND);
    expect(first).toBeLessThan(2 * SECOND + 100);
  });

  test("a webhook that the loop's last query missed is fetched at its due time", async () => {
    await sync();
    await firstWalk();
    skills.add(NAME);
    let at = 0;
    await strandLoop(async () => {
      at = Date.now();
      await notify(NAME);
    });
    await run(serves(NAME, 1));

    const first = gets(NAME)[0]!.at - at;
    expect(first).toBeGreaterThanOrEqual(2 * SECOND);
    expect(first).toBeLessThan(2 * SECOND + 100);
  });

  test("a cooldown ends and the loop resumes without traffic", async () => {
    skills.add(NAME);
    await sync();
    await firstWalk();
    fake.respond({ status: 429, headers: { "Retry-After": "7" } });
    await notify(NAME);
    await run(() => gets(NAME).length === 1);
    const limited = gets(NAME)[0]!.at;
    await strandLoop();
    await run(serves(NAME, 1));

    expect(gets(NAME)).toHaveLength(2);
    expect(gets(NAME)[1]!.at - limited).toBeGreaterThanOrEqual(7 * SECOND);
    expect(gets(NAME)[1]!.at - limited).toBeLessThan(7 * SECOND + 100);
  });

  test("a retry time that the loop's last query missed is fetched at that time", async () => {
    skills.add(NAME);
    await sync();
    await firstWalk();
    fake.respond({ status: 503 });
    await notify(NAME);
    await run(async () => (await health()).errors === 1);
    // The refresh failed at its `latest` GET's end; its backoff starts there.
    const failed = gets(NAME).at(-1)!.at;
    await strandLoop();
    await run(serves(NAME, 1));

    const retry = productionGets(NAME)[1]!.at;
    expect(retry - failed).toBeGreaterThanOrEqual(5 * SECOND);
    expect(retry - failed).toBeLessThan(5 * SECOND + 100);
  });
});

describe("requests", () => {
  // Version 1 holds `production`, version 2 `latest`: two GETs per refresh.
  const twoVersions = async () => {
    skills.add(NAME);
    skills.add(NAME, { labels: [] });
    await cached(NAME, 2);
    return gets(NAME).length;
  };

  test.each([
    ["while the production GET is in flight", "production"],
    ["between the GETs", "between"],
    ["while the latest GET is in flight, before publish", "latest"],
  ])(
    "a webhook %s leaves the name due, and a second refresh follows",
    async (_, when) => {
      const before = await twoVersions();
      let delivered = false;
      fake.fallback = async (request) => {
        if (!delivered && labelOf(request) === when) {
          delivered = true;
          await notify(NAME);
        }
        return skills.answer(request);
      };
      await notify(NAME);
      await run(
        async () => delivered && (await health()).due === 0,
        10 * MINUTE,
        async () => {
          if (!delivered && when === "between") {
            delivered = gets(NAME).length === before + 1;
            if (delivered) await notify(NAME);
          }
        },
      );

      expect(gets(NAME).slice(before).map(labelOf)).toEqual([
        "production",
        "latest",
        "production",
        "latest",
      ]);
    },
  );

  test("a failed GET waits for its 5 s backoff while another due name is served", async () => {
    skills.add(NAME);
    skills.add("other-skill");
    await sync([NAME, "other-skill"]);
    await run(async () => (await health()).due === 0);
    fake.respond({ status: 500 });
    await notify(NAME);
    await run(async () => (await health()).errors === 1);
    const failed = gets(NAME).at(-1)!.at;
    expect(await health()).toMatchObject({ errors: 1, due: 1 });
    await notify("other-skill");
    await run(async () => (await health()).due === 0);

    const other = gets("other-skill").at(-1)!.at;
    expect(other).toBeLessThan(failed + 5 * SECOND);
    expect(productionGets(NAME).at(-1)!.at - failed).toBeGreaterThanOrEqual(
      5 * SECOND,
    );
    expect(await health()).toMatchObject({ errors: 0, due: 0 });
  });

  test("a webhook during a backoff is fetched at its own due time", async () => {
    skills.add(NAME);
    await cached(NAME);
    const before = productionGets(NAME).length;
    fake.respond({ status: 500 });
    await notify(NAME);
    await run(async () => (await health()).errors === 1);
    const failed = gets(NAME).at(-1)!.at;
    await runFor(500);
    const again = Date.now();
    await notify(NAME);
    await run(() => productionGets(NAME).length === before + 2);

    const retry = productionGets(NAME).at(-1)!.at;
    expect(retry).toBeGreaterThanOrEqual(again + 2 * SECOND);
    expect(retry).toBeLessThan(failed + 5 * SECOND);
  });

  test("a webhook during a GET that fails keeps its own due time", async () => {
    skills.add(NAME);
    await cached(NAME);
    const before = productionGets(NAME).length;
    let delivered = false;
    fake.fallback = async (request) => {
      if (!delivered && labelOf(request) === "production") {
        delivered = true;
        await notify(NAME);
        return { status: 500 };
      }
      return skills.answer(request);
    };
    await notify(NAME);
    await run(() => productionGets(NAME).length === before + 2);

    // The latest GET and two spacings lie between; the 5 s backoff from the
    // failed refresh's end would add 2.5 s more.
    const [failed, retry] = productionGets(NAME).slice(before);
    expect(retry!.at - failed!.at).toBeLessThan(
      2 * SKILL_REQUEST_SPACING_MS + SECOND,
    );
  });

  test.each([
    ["a ready listing", "listing"],
    ["a ready daily refresh", "daily"],
  ])("%s goes before an urgent name that is due in 2 s", async (_, ready) => {
    skills.add(NAME);
    skills.add("other-skill");
    await sync([NAME, "other-skill"]);
    await run(async () => (await health()).due === 0);
    const { lastListAt } = await health();
    const other = (await stored()).names.find((n) => n.name !== NAME)!;
    vi.setSystemTime(
      ready === "listing"
        ? lastListAt! + SKILL_LIST_INTERVAL_MS
        : Math.max(Date.now(), other.fullDueAt),
    );
    if (ready === "daily") await t.mutation(internal.skills.tick, {});
    const before = skillRequests().length;
    const at = Date.now();
    await notify(NAME);
    await run(() => gets(NAME).length === 2);

    const first = skillRequests()[before]!;
    expect(pathOf(first)).not.toBe(`/api/public/skills/${NAME}`);
    expect(first.at).toBeLessThan(at + 2 * SECOND);
  });

  test("urgent names arriving without pause leave the listing and a background name their share", async () => {
    const urgent = skillNames("urgent", 15);
    for (const name of [...urgent, NAME]) skills.add(name);
    await sync([...urgent, NAME]);
    await run(async () => (await health()).due === 0);
    const start = Date.now();
    const lastListAt = (await health()).lastListAt!;
    // A change without a webhook: only the listing sees it.
    skills.add(NAME);
    let next = start;
    let i = 0;
    await run(
      () => gets(NAME).some((request) => request.at > start),
      30 * MINUTE,
      async () => {
        while (Date.now() >= next) {
          await notify(urgent[i++ % urgent.length]!);
          next += SECOND;
        }
      },
    );

    const listing = listings().find((request) => request.at > start)!;
    expect(listing.at - (lastListAt + SKILL_LIST_INTERVAL_MS)).toBeLessThan(
      35 * SECOND,
    );
    const refresh = gets(NAME).find((request) => request.at > start)!;
    expect(refresh.at - listing.at).toBeLessThan(35 * SECOND);
  });
});

describe("fencing", () => {
  test("advance, store and publish with an old generation change nothing", async () => {
    skills.add(NAME);
    await cached(NAME);
    const before = await stored();
    const fetcher = await t.run(
      async (ctx) => (await ctx.db.query("skillFetcher").first())!,
    );
    const old = fetcher.generation - 1;
    expect(
      await t.mutation(internal.skills.advance, {
        generation: old,
        report: { end: Date.now(), limited: {} },
      }),
    ).toEqual({ kind: "done" });
    expect(
      await t.mutation(internal.skills.store, {
        generation: old,
        name: NAME,
        remoteId: "recreated",
        version: 9,
        description: "",
        frontmatter: "{}",
        files: [{ path: "SKILL.md", sha256: sha256Base64(""), content: "" }],
      }),
    ).toBeNull();
    await t.mutation(internal.skills.publish, {
      generation: old,
      name: NAME,
      production: { outcome: "gone" },
      latest: { outcome: "gone" },
    });
    expect(await stored()).toEqual(before);
    expect(
      await t.run(async (ctx) => await ctx.db.query("skillFetcher").first()),
    ).toEqual(fetcher);
    expect((await get(NAME))?.version).toBe(1);
  });

  test("after a lease expiry with a request in flight, the next generation's first request starts 12.5 s after that hand-out", async () => {
    skills.add(NAME);
    skills.add("other-skill");
    await sync();
    await firstWalk();
    // The request hangs; its run stalls past its lease.
    fake.respond({ hang: true });
    await notify(NAME);
    await run(() => gets(NAME).length === 1);
    const handOut = gets(NAME)[0]!.at;
    await t.run(async (ctx) => {
      const fetcher = (await ctx.db.query("skillFetcher").first())!;
      await ctx.db.patch("skillFetcher", fetcher._id, {
        leaseExpiresAt: Date.now(),
      });
    });
    await notify("other-skill");
    await run(serves("other-skill", 1));

    const next = skillRequests().find((request) => request.at > handOut)!;
    expect(next.at - handOut).toBeGreaterThanOrEqual(
      PROMPT_TIMEOUT_MS + SKILL_REQUEST_SPACING_MS,
    );
  });
});

describe("spacing", () => {
  test("request starts across names, listing pages and runs are at least 2.5 s apart", async () => {
    const names = skillNames("skill", 120);
    for (const name of names) skills.add(name, { labels: [] });
    skills.add(NAME);
    await sync();
    // 2 listing pages, 2 GETs for each name without `production`, 1 more.
    await run(
      async () => skillRequests().length >= 243 && (await health()).due === 0,
      2 * HOUR,
    );

    const requests = skillRequests();
    expect(listings().map(pageOf).slice(0, 2)).toEqual([1, 2]);
    expect(Math.min(...gaps(requests))).toBeGreaterThanOrEqual(
      SKILL_REQUEST_SPACING_MS,
    );
    // The refreshes spread over several 1-minute runs.
    expect(requests.at(-1)!.at - requests[0]!.at).toBeGreaterThan(5 * MINUTE);
  });

  const retryAfter = (value: string) => () => ({ "Retry-After": value });
  test.each([
    ["in seconds", retryAfter("7"), 7 * SECOND],
    [
      "as an HTTP date",
      () => ({
        "Retry-After": new Date(Date.now() + 7 * SECOND).toUTCString(),
      }),
      7 * SECOND,
    ],
    ["missing", () => ({}), MINUTE],
    ["over 15 minutes", retryAfter("3600"), 15 * MINUTE],
    ["of 0 s", retryAfter("0"), 5 * SECOND],
  ])(
    "a 429 with Retry-After %s stops every request for the right time",
    async (_, headers: () => Record<string, string>, wait) => {
      skills.add(NAME);
      skills.add("other-skill");
      await sync([NAME, "other-skill"]);
      await run(async () => (await health()).due === 0);
      const before = skillRequests().length;
      fake.respond(() => ({ status: 429, headers: headers() }));
      await notify(NAME);
      await notify("other-skill");
      await run(() => skillRequests().length === before + 1);
      const limited = skillRequests().at(-1)!.at;
      await runFor(100);
      expect((await health()).cooldownUntil).toBeGreaterThanOrEqual(
        limited + wait - SECOND,
      );
      await run(async () => (await health()).due === 0, HOUR);

      const next = skillRequests().find((request) => request.at > limited)!;
      // An HTTP date has whole seconds.
      expect(next.at - limited).toBeGreaterThanOrEqual(wait - SECOND);
      expect(next.at - limited).toBeLessThan(wait + SECOND);
    },
  );
});

describe("listing", () => {
  test("a production label moved without a webhook gets a refresh from the next listing", async () => {
    skills.add(NAME);
    skills.add(NAME, { labels: [] });
    await sync();
    await run(serves(NAME, 2, { label: "latest" }));
    const lastListAt = (await health()).lastListAt!;
    skills.move(NAME, 2, "production");
    await run(serves(NAME, 2), HOUR);

    expect(listings().at(-1)!.at).toBeGreaterThanOrEqual(
      lastListAt + SKILL_LIST_INTERVAL_MS,
    );
  });

  test("a page of 100 names with maximal metadata compares within the transaction limits", async () => {
    t = initConvexTest({ transactionLimits: true });
    const names = Array.from(
      { length: 100 },
      (_, i) => `${"n".repeat(60)}-${String(i).padStart(3, "0")}`,
    );
    for (const name of names) skills.add(name, { labels: [] });
    await sync();
    await run(
      async () =>
        (await health()).due === 0 && (await health()).tracked === 100,
      2 * HOUR,
    );
    for (const name of names) skills.add(name, { labels: [] });
    await run(async () => (await health()).due === 100, HOUR);
    expect((await health()).listError).toBeUndefined();
  });

  test("a walk cut short keeps its progress and marks no vanished name", async () => {
    const names = skillNames("skill", 150);
    for (const name of names) skills.add(name);
    await sync(names);
    await run(async () => (await health()).due === 0, 2 * HOUR);
    const lastListAt = (await health()).lastListAt!;
    // A change every listing page shows, and a skill that vanished.
    for (const name of names) skills.move(name, 1, "production");
    skills.add(names[0]!, { labels: [] });
    skills.delete(names[149]!);
    fake.fallback = (request) =>
      pathOf(request) === "/api/public/skills" && pageOf(request) === 2
        ? { status: 500 }
        : skills.answer(request);
    const before = gets(names[149]!).length;
    await run(async () => (await health()).lastListAt! > lastListAt, HOUR);
    expect((await health()).listError).toBe("http_500");
    await run(async () => (await health()).due === 0, HOUR);

    expect(gets(names[0]!).at(-1)!.at).toBeGreaterThan(lastListAt);
    expect(gets(names[149]!)).toHaveLength(before);
    expect((await get(names[149]!))?.version).toBe(1);
  });

  test.each([
    ["all", 0],
    ["names", 1],
  ] as const)(
    "a complete walk refreshes a vanished name; its 404s delete it in mode %s",
    async (mode, kept) => {
      skills.add(NAME);
      skills.add("other-skill");
      if (mode === "all") {
        await sync();
      } else {
        await sync([NAME, "other-skill"]);
      }
      await run(
        async () =>
          (await health()).due === 0 &&
          (await health()).lastListAt !== undefined,
      );
      skills.delete(NAME);
      await run(
        async () => (await get(NAME)) === null && (await health()).due === 0,
        HOUR,
      );

      expect(gets(NAME).slice(-2).map(labelOf)).toEqual([
        "production",
        "latest",
      ]);
      expect((await health()).tracked).toBe(1 + kept);
    },
  );

  test("a project of 1,000 skills with 500 tracked in mode names is walked to its end", async () => {
    const names = skillNames("skill", 1_000);
    for (const name of names) skills.add(name);
    await sync(names.slice(0, MAX_SKILL_NAMES));
    await run(async () => (await health()).lastListAt !== undefined, 2 * HOUR);

    expect(listings().map(pageOf)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect((await health()).listError).toBeUndefined();
    expect((await health()).tracked).toBe(MAX_SKILL_NAMES);
  });

  test("a tick during a listing page leaves the walk alone; an 8-page walk continues across runs", async () => {
    const names = skillNames("skill", 800);
    for (const name of names) skills.add(name);
    // 100 urgent names keep the runs busy, so pages go one per share.
    await sync(names.slice(0, 100));
    let ticked = false;
    await run(
      async () => (await health()).lastListAt !== undefined,
      2 * HOUR,
      async () => {
        if (!ticked && listings().length === 3) {
          ticked = true;
          await t.mutation(internal.skills.tick, {});
        }
      },
    );

    expect(listings().map(pageOf)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(listings().at(-1)!.at - listings()[0]!.at).toBeGreaterThan(MINUTE);
    expect((await health()).listError).toBeUndefined();
  });
});

describe("recreation", () => {
  test("a version number recreated with a new id replaces the served version, also twice in a row", async () => {
    skills.add(NAME);
    await cached(NAME);
    for (const note of ["recreated once", "recreated twice"]) {
      skills.deleteVersion(NAME, 1);
      skills.add(NAME, { files: skillFiles(NAME, note) });
      await notify(NAME);
      await run(async () =>
        ((await get(NAME))?.files[0]?.content ?? "").includes(note),
      );
      expect((await get(NAME, { version: 1 }))!.files[0]!.content).toContain(
        note,
      );
    }
  });

  test("a stored, unpublished replacement does not shadow the published version", async () => {
    skills.add(NAME);
    await cached(NAME);
    const published = await get(NAME, { version: 1 });
    vi.setSystemTime(Date.now() + MINUTE);
    // A run stores a recreated version 1 and stops before it publishes.
    await t.run(async (ctx) => {
      const fetcher = (await ctx.db.query("skillFetcher").first())!;
      await ctx.db.patch("skillFetcher", fetcher._id, {
        generation: fetcher.generation + 1,
        leaseExpiresAt: Date.now() + MINUTE,
      });
      const row = (await ctx.db.query("skillNames").first())!;
      await ctx.db.patch("skillNames", row._id, {
        claimed: {
          generation: fetcher.generation + 1,
          requested: row.requested,
        },
      });
    });
    const generation = (await t.run(
      async (ctx) => await ctx.db.query("skillFetcher").first(),
    ))!.generation;
    const content = "---\nname: weather-report\n---\nOther\n";
    expect(
      await t.mutation(internal.skills.store, {
        generation,
        name: NAME,
        remoteId: "recreated-id",
        version: 1,
        description: "Other",
        frontmatter: "{}",
        files: [{ path: "SKILL.md", sha256: sha256Base64(content), content }],
      }),
    ).not.toBeNull();

    expect(await get(NAME, { version: 1 })).toEqual(published);
    expect(await get(NAME)).toEqual(published);
  });
});

describe("bound", () => {
  test("sync tracks at most 500 names and reports the overflow", async () => {
    vi.stubEnv("LANGFUSE_BASE_URL", "");
    const names = skillNames("skill", MAX_SKILL_NAMES);
    expect(await sync(names)).toEqual({ status: "ok", tracked: 500 });
    expect(await sync(["one-more"])).toEqual({
      status: "incomplete",
      tracked: 500,
    });
    expect(await sync(names.slice(0, 10))).toEqual({
      status: "ok",
      tracked: 500,
    });
  });

  test("in mode all, a listing over the bound reports the overflow", async () => {
    for (const name of skillNames("skill", MAX_SKILL_NAMES + 1)) {
      skills.add(name);
    }
    expect((await sync()).status).toBe("ok");
    await firstWalk();

    expect(await health()).toMatchObject({
      tracked: MAX_SKILL_NAMES,
      overflow: true,
    });
    expect((await health()).listError).toBeUndefined();
    expect((await sync()).status).toBe("incomplete");
  });

  test("in mode all, an overflow and a later page's error are both reported", async () => {
    for (const name of skillNames("skill", MAX_SKILL_NAMES + 200)) {
      skills.add(name);
    }
    // Page 6 lists names over the bound, page 7 fails.
    fake.fallback = (request) =>
      pathOf(request) === "/api/public/skills" && pageOf(request) === 7
        ? { status: 500 }
        : skills.answer(request);
    await sync();
    await firstWalk();

    expect(await health()).toMatchObject({
      listError: "http_500",
      overflow: true,
    });
    expect((await sync()).status).toBe("incomplete");
  });

  test("in mode all, names deleted at the bound free their slots for new ones", async () => {
    const old = skillNames("old", MAX_SKILL_NAMES);
    for (const name of old) skills.add(name);
    await sync();
    // 5 listing pages and one GET per name.
    await run(
      async () => skillRequests().length >= 505 && (await health()).due === 0,
      4 * HOUR,
    );
    expect((await health()).tracked).toBe(MAX_SKILL_NAMES);
    const gone = old.slice(0, 5);
    const fresh = skillNames("fresh", 5);
    for (const name of gone) skills.delete(name);
    for (const name of fresh) skills.add(name);
    await run(async () => {
      for (const name of fresh) if (!(await get(name))) return false;
      return true;
    }, 2 * HOUR);

    for (const name of gone) expect(await get(name)).toBeNull();
    for (const name of fresh) expect((await get(name))?.version).toBe(1);
    expect((await health()).tracked).toBe(MAX_SKILL_NAMES);
  });
});

describe("daily refresh", () => {
  test("500 names synced at once are spread over 24 hours, and a queued name moves a day ahead", async () => {
    vi.stubEnv("LANGFUSE_BASE_URL", "");
    const start = Date.now();
    await sync(skillNames("skill", MAX_SKILL_NAMES));
    const due = (await stored()).names.map((row) => row.fullDueAt - start);
    const hours = Array.from({ length: 24 }, () => 0);
    for (const offset of due) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(DAY);
      hours[Math.floor(offset / HOUR)]! += 1;
    }
    expect(Math.min(...hours)).toBeGreaterThanOrEqual(5);
    expect(Math.max(...hours)).toBeLessThanOrEqual(45);

    vi.setSystemTime(start + 6 * HOUR);
    const before = new Map(
      (await stored()).names.map((row) => [row.name, row.fullDueAt]),
    );
    await t.mutation(internal.skills.tick, {});
    const moved = (await stored()).names.filter(
      (row) => row.fullDueAt !== before.get(row.name),
    );
    expect(moved).toHaveLength(5);
    for (const row of moved) {
      expect(row.fullDueAt).toBe(before.get(row.name)! + DAY);
    }
  });

  test("names that always fail at the head of the daily queue do not hold back the others", async () => {
    const failing = skillNames("failing", 5);
    const healthy = skillNames("healthy", 10);
    for (const name of [...failing, ...healthy]) skills.add(name);
    await sync([...failing, ...healthy]);
    await run(async () => (await health()).due === 0);
    // Every daily refresh is due, the failing names first.
    const now = Date.now();
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("skillNames").collect()) {
        await ctx.db.patch("skillNames", row._id, {
          fullDueAt: now - (row.name.startsWith("failing") ? 2 : 1) * HOUR,
        });
      }
    });
    fake.fallback = (request) =>
      pathOf(request).includes("/failing-")
        ? { status: 500 }
        : skills.answer(request);
    const before = new Map(healthy.map((name) => [name, gets(name).length]));
    let nextTick = Date.now();
    await run(
      () => healthy.every((name) => gets(name).length > before.get(name)!),
      HOUR,
      async () => {
        if (Date.now() >= nextTick) {
          nextTick += 5 * MINUTE;
          await t.mutation(internal.skills.tick, {});
        }
      },
    );
    expect(Date.now() - now).toBeLessThan(20 * MINUTE);
  });
});

describe("sweep", () => {
  const files = (count: number, note: string): SkillFile[] => [
    ...skillFiles(NAME, note),
    ...Array.from({ length: count - 3 }, (_, i) => ({
      path: `reference/${i}.md`,
      content: `${note} ${i}`,
    })),
  ];
  const sweep = () => t.mutation(internal.skills.sweep, {});

  test("released versions are deleted after 7 days in batches of 200 files, and an interrupted deletion resumes", async () => {
    skills.add(NAME, { files: files(150, "first") });
    await cached(NAME);
    skills.add(NAME, { files: files(150, "second") });
    await notify(NAME);
    await run(serves(NAME, 2));
    skills.add(NAME);
    await notify(NAME);
    await run(serves(NAME, 3));
    expect((await stored()).files).toHaveLength(303);

    vi.setSystemTime(Date.now() + 7 * DAY + MINUTE);
    await sweep();
    expect((await stored()).files).toHaveLength(103);
    expect((await stored()).versions).toHaveLength(2);
    await sweep();
    expect((await stored()).files).toHaveLength(3);
    expect((await stored()).versions).toHaveLength(1);
    expect((await get(NAME))?.version).toBe(3);
  });

  test("a version relabelled after part of its files were deleted is stored again and served whole", async () => {
    skills.add(NAME, { files: files(150, "first") });
    await cached(NAME);
    skills.add(NAME, { files: files(150, "second") });
    await notify(NAME);
    await run(serves(NAME, 2));
    skills.add(NAME);
    await notify(NAME);
    await run(serves(NAME, 3));
    vi.setSystemTime(Date.now() + 7 * DAY + MINUTE);
    await sweep();
    // The sweep stops here for now: its next run is not due yet.
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system
        .query("_scheduled_functions")
        .collect()) {
        if (job.name === "skills:sweep" && job.state.kind === "pending") {
          await ctx.scheduler.cancel(job._id);
        }
      }
    });
    expect(
      (await stored()).versions.find((v) => v.version === 2)?.deleting,
    ).toBe(true);

    skills.move(NAME, 2, "production");
    await notify(NAME);
    await run(serves(NAME, 2));
    const skill = await get(NAME);
    expect(skill!.files).toHaveLength(150);
    expect(skill!.files.find((f) => f.path === "SKILL.md")!.content).toContain(
      "second",
    );
    expect((await get(NAME, { version: 2 }))!.files).toHaveLength(150);
  });

  test("a version that regains a label is kept", async () => {
    skills.add(NAME);
    await cached(NAME);
    skills.add(NAME);
    await notify(NAME);
    await run(serves(NAME, 2));
    vi.setSystemTime(Date.now() + 6 * DAY);
    skills.move(NAME, 1, "production");
    await notify(NAME);
    await run(serves(NAME, 1));
    vi.setSystemTime(Date.now() + 2 * DAY);
    await sweep();

    expect((await get(NAME))?.version).toBe(1);
    expect((await get(NAME, { version: 1 }))?.version).toBe(1);
  });

  test("an unpublished version is deleted after 1 hour unless a live claim holds it", async () => {
    skills.add(NAME);
    await cached(NAME);
    const claim = async (leaseMs: number) =>
      await t.run(async (ctx) => {
        const fetcher = (await ctx.db.query("skillFetcher").first())!;
        await ctx.db.patch("skillFetcher", fetcher._id, {
          leaseExpiresAt: Date.now() + leaseMs,
        });
        const row = (await ctx.db.query("skillNames").first())!;
        await ctx.db.patch("skillNames", row._id, {
          claimed: { generation: fetcher.generation, requested: row.requested },
        });
        return fetcher.generation;
      });
    const generation = await claim(2 * HOUR);
    const content = "---\nname: weather-report\n---\nUnpublished\n";
    await t.mutation(internal.skills.store, {
      generation,
      name: NAME,
      remoteId: "unpublished-id",
      version: 2,
      description: "",
      frontmatter: "{}",
      files: [{ path: "SKILL.md", sha256: sha256Base64(content), content }],
    });
    const count = async () => (await stored()).versions.length;
    expect(await count()).toBe(2);

    vi.setSystemTime(Date.now() + HOUR + MINUTE);
    await sweep();
    expect(await count()).toBe(2);
    await claim(-1);
    await sweep();
    expect(await count()).toBe(1);
    expect((await get(NAME))?.version).toBe(1);
  });
});
