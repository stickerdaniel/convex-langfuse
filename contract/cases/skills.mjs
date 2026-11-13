// Cases for the skill cache. Skills are created, relabelled and deleted
// through Langfuse's public API; the cache is read through the client's
// `skills.get` and `health`, and the component's requests through the
// recording proxy. The cases rely on the stack's skill webhook, which
// Langfuse posts through the relay to the component's mounted route. The
// first case calls `skills.sync()`, so the cache tracks every skill of the
// project from then on.

/** How long a refresh may take to reach the cache, times the pace's scale. */
const REFRESH_MS = 60_000;
/**
 * Hard gate on the host clock: from sending a label move's PATCH to the end
 * of the first read that returns the new version.
 */
const PUBLISH_GATE_MS = 60_000;
/** Target for delivery to publication with an idle loop; reported only. */
const PUBLISH_TARGET_MS = 10_000;
/** Time for late deliveries of earlier changes, times the pace's scale. */
const QUIET_MS = 5_000;
/** Pause between two Convex reads that time a label move. */
const WATCH_PAUSE_MS = 200;
/** The component starts skill requests at least this far apart. */
const SPACING_MS = 2_500;
/** Fewer skill requests in the record prove nothing about their spacing. */
const MIN_SPACED_REQUESTS = 4;

const SKILLS_PATH = "/api/public/skills";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A `SKILL.md` with the frontmatter Langfuse reads the name from. */
const skillMd = (name, body) =>
  `---\nname: ${name}\ndescription: Writes a short weather report from a forecast.\n---\n\n${body}`;

/**
 * Files whose bytes a lossy store would change: CRLF line ends, trailing
 * spaces and blank lines, a tab, text outside ASCII and a file without a
 * final newline.
 */
const UNITS =
  "Use Celsius and km/h.\r\nGrüße aus Zürich, 東京 und 🌤.\r\n  two spaces  \r\n";
const versionOneFiles = (name) => [
  {
    path: "SKILL.md",
    content: skillMd(name, "Report the forecast in three sentences.\n"),
  },
  { path: "reference/units.md", content: UNITS },
  { path: "scripts/round.py", content: "print(round(21.4))" },
];
const versionTwoFiles = (name) => [
  {
    path: "SKILL.md",
    content: skillMd(name, "Report the forecast in one sentence.\n"),
  },
  { path: "reference/units.md", content: UNITS },
  { path: "notes/v2.txt", content: "\tIndented line\n\n\n" },
];

/** Creates a skill version through the public API and returns its body. */
async function createSkill(langfuse, files) {
  const response = await langfuse.send("POST", SKILLS_PATH, { files });
  if (response.status !== 201) {
    throw new Error(`creating a skill version: HTTP ${response.status}`);
  }
  return await response.json();
}

/** Sets the labels of one version; Langfuse moves them off other versions. */
async function setLabels(langfuse, name, version, labels) {
  const response = await langfuse.send(
    "PATCH",
    `${SKILLS_PATH}/${name}/versions/${version}`,
    { labels },
  );
  if (!response.ok) {
    throw new Error(`labelling ${name} v${version}: HTTP ${response.status}`);
  }
}

/** The version a label holds, with each file's content, from the API. */
const apiSkill = (langfuse, name, label) =>
  langfuse.get(`${SKILLS_PATH}/${name}?label=${label}&includeContent=true`);

/**
 * What differs between the cached files and the API's: a missing or extra
 * path, or the first byte offset where the UTF-8 bytes differ.
 */
function fileDifferences(cached, api) {
  const expected = new Map(api.files.map((file) => [file.path, file.content]));
  const problems = [];
  for (const { path, content } of cached?.files ?? []) {
    if (!expected.has(path)) {
      problems.push(`${path}: not in the API's version`);
      continue;
    }
    const want = expected.get(path);
    expected.delete(path);
    if (typeof want !== "string") {
      problems.push(`${path}: the API returned no content`);
      continue;
    }
    const got = Buffer.from(content, "utf8");
    const bytes = Buffer.from(want, "utf8");
    if (got.equals(bytes)) continue;
    let at = 0;
    while (at < Math.min(got.length, bytes.length) && got[at] === bytes[at]) {
      at++;
    }
    problems.push(
      `${path}: ${got.length} bytes, expected ${bytes.length}, first difference at byte ${at}`,
    );
  }
  for (const path of expected.keys()) problems.push(`${path}: not cached`);
  return problems;
}

/** Problems while the skill loop has work: a pending request or a pause. */
const busy = ({ skills }) => [
  ...(skills.due === 0 ? [] : [`${skills.due} skill names due`]),
  ...(skills.cooldownUntil === undefined ? [] : ["skill requests paused"]),
];

const ms = (value) => `${(value / 1_000).toFixed(1)} s`;

/** The name and API versions the label move case reuses, set by the first. */
const shared = {};

export default [
  {
    name: "skill cache: sync, both labels byte for byte",
    oracle: "client result, Langfuse API",
    async run({
      runId,
      langfuse,
      mutation,
      query,
      poll,
      differences,
      ownSkills,
    }) {
      const name = `contract-${runId}-weather`;
      ownSkills.add(name);
      // Version 1 holds `production`, version 2 `latest`.
      await createSkill(langfuse, versionOneFiles(name));
      await createSkill(langfuse, versionTwoFiles(name));
      await setLabels(langfuse, name, 1, ["production"]);
      const synced = await mutation("syncSkills", {});
      if (synced.status !== "ok") {
        throw new Error(`sync result: ${JSON.stringify(synced)}`);
      }
      const cached = await poll(
        "both labels cached, the loop idle",
        async () => ({
          production: await query("getSkill", { name }),
          latest: await query("getSkill", { name, label: "latest" }),
          health: await query("health", {}),
        }),
        ({ production, latest, health }) => [
          ...differences(production, { version: 1 }).map(
            (p) => `production ${p}`,
          ),
          ...differences(latest, { version: 2 }).map((p) => `latest ${p}`),
          ...busy(health),
        ],
        REFRESH_MS,
      );
      const problems = [];
      for (const label of ["production", "latest"]) {
        const api = await apiSkill(langfuse, name, label);
        problems.push(
          ...[
            ...differences(cached[label], {
              name,
              version: api.version,
              description: api.description,
              frontmatter: api.frontmatter,
            }),
            ...fileDifferences(cached[label], api),
          ].map((problem) => `${label}: ${problem}`),
        );
        shared[label] = api;
      }
      if (problems.length > 0) throw new Error(problems.join("; "));
      shared.name = name;
      const bytes = (skill) =>
        skill.files.reduce(
          (sum, file) => sum + Buffer.byteLength(file.content, "utf8"),
          0,
        );
      return (
        `production v1 ${cached.production.files.length} files ` +
        `${bytes(cached.production)} bytes, latest v2 ` +
        `${cached.latest.files.length} files ${bytes(cached.latest)} bytes, equal to the API`
      );
    },
  },

  {
    name: "skill label move via webhook",
    oracle: "client result, recording proxy",
    async run({ langfuse, query, proxy, poll, steps, differences, scale }) {
      const { name, latest } = shared;
      if (!name) throw new Error("needs the skill cache case before it");
      // Deliveries of the first case's changes may still be on their way.
      // The loop must be idle before and after a quiet period.
      const idle = () =>
        poll(
          "the skill loop idle before the move",
          () => query("health", {}),
          busy,
          REFRESH_MS,
        );
      await idle();
      await sleep(QUIET_MS * scale);
      await idle();

      // The gate runs on the host clock, from sending the PATCH to the end
      // of the first read that returns version 2. It includes Langfuse's
      // delivery latency. Langfuse changes the labels while it answers the
      // PATCH and can deliver before the answer arrives.
      const movedFrom = Date.now();
      await setLabels(langfuse, name, 2, ["production"]);
      const changedAt = Date.now();
      // Reported only: with no name due before the move, the first pending
      // request after it is most likely the delivery's. `oldestDueAt` is the
      // Convex clock's time at which the route queued it.
      let deliveredAt;
      let served;
      let readAt;
      for (;;) {
        const [health, skill] = await Promise.all([
          query("health", {}),
          query("getSkill", { name }),
        ]);
        readAt = Date.now();
        const queuedAt = health.skills.oldestDueAt;
        if (deliveredAt === undefined && queuedAt >= movedFrom) {
          deliveredAt = queuedAt;
        }
        const elapsed = readAt - movedFrom;
        if (skill?.version === 2) {
          // A read that returns late fails, also when it succeeds.
          if (elapsed > PUBLISH_GATE_MS) {
            throw new Error(
              `version 2 first read ${ms(elapsed)} after the PATCH, ` +
                `over the ${ms(PUBLISH_GATE_MS)} gate`,
            );
          }
          served = skill;
          break;
        }
        if (elapsed > PUBLISH_GATE_MS) {
          throw new Error(
            `version 2 not read within ${ms(PUBLISH_GATE_MS)} of the PATCH; ` +
              `get returned ${JSON.stringify(skill?.version ?? null)}`,
          );
        }
        await sleep(WATCH_PAUSE_MS);
      }
      const problems = [
        ...differences(served, { name, version: 2 }),
        ...fileDifferences(served, latest),
      ];
      if (problems.length > 0) throw new Error(problems.join("; "));

      // The refresh must come from the webhook: no listing request may
      // start between the PATCH and the first GET of the skill after it.
      const after = proxy.records.filter(
        (r) => r.at >= movedFrom && r.at <= readAt,
      );
      const gets = after.filter((r) =>
        r.path.startsWith(`${SKILLS_PATH}/${name}?`),
      );
      if (gets.length === 0) {
        throw new Error("version 2 read without a GET of the skill");
      }
      const listings = after.filter(
        (r) => r.path.startsWith(`${SKILLS_PATH}?`) && r.at <= gets[0].at,
      );
      if (listings.length > 0) {
        throw new Error(
          `${listings.length} listing requests before the first GET of the skill`,
        );
      }

      const gated = readAt - movedFrom;
      steps.push({
        step: "label move: PATCH sent to version 2 read",
        ms: gated,
        deadlineMs: PUBLISH_GATE_MS,
      });
      const durations = gets.map((r) => r.answeredAt - r.at);
      steps.push({ step: "label move: GET durations", ms: durations });
      const gate =
        `PATCH sent to version 2 read ${gated} ms on the host clock ` +
        `(gate ${ms(PUBLISH_GATE_MS)}; PATCH round trip ${changedAt - movedFrom} ms), ` +
        `no listing before the first GET, GETs ${durations.join(", ")} ms`;
      if (deliveredAt === undefined) {
        return `${gate}\n  reported: no delivery observed in health`;
      }
      const reported = {
        "change to delivery": deliveredAt - movedFrom,
        "delivery to first GET": gets[0].at - deliveredAt,
        "delivery to publication": readAt - deliveredAt,
      };
      for (const [step, value] of Object.entries(reported)) {
        steps.push({ step: `label move, reported: ${step}`, ms: value });
      }
      const onTarget = reported["delivery to publication"] < PUBLISH_TARGET_MS;
      return (
        `${gate}\n  reported, delivery time on the Convex clock: change to ` +
        `delivery ${reported["change to delivery"]} ms, delivery to first GET ` +
        `${reported["delivery to first GET"]} ms, delivery to publication ` +
        `${reported["delivery to publication"]} ms (target under ` +
        `${ms(PUBLISH_TARGET_MS)}: ${onTarget ? "yes" : "no"})`
      );
    },
  },

  {
    name: "deleted skill served as null",
    oracle: "client result",
    async run({
      runId,
      langfuse,
      mutation,
      query,
      poll,
      differences,
      ownSkills,
    }) {
      const name = `contract-${runId}-deleted`;
      ownSkills.add(name);
      await mutation("syncSkills", {});
      await createSkill(langfuse, versionOneFiles(name));
      await setLabels(langfuse, name, 1, ["production"]);
      await poll(
        "the skill cached",
        () => query("getSkill", { name }),
        (skill) => differences(skill, { name, version: 1 }),
        REFRESH_MS,
      );
      const deleted = await langfuse.send(
        "DELETE",
        `${SKILLS_PATH}/${name}/versions/1`,
      );
      if (!deleted.ok) throw new Error(`deleting v1: HTTP ${deleted.status}`);
      await poll(
        "both labels null after the deletion",
        async () => ({
          production: await query("getSkill", { name }),
          latest: await query("getSkill", { name, label: "latest" }),
        }),
        ({ production, latest }) => [
          ...(production === null ? [] : [`production v${production.version}`]),
          ...(latest === null ? [] : [`latest v${latest.version}`]),
        ],
        REFRESH_MS,
      );
      return "version 1 served, then null for both labels";
    },
  },

  {
    name: "skill request spacing",
    oracle: "recording proxy",
    async run({ proxy }) {
      const starts = proxy.records
        .filter((r) => r.path.startsWith(SKILLS_PATH))
        .map((r) => r.at);
      if (starts.length < MIN_SPACED_REQUESTS) {
        throw new Error(
          `${starts.length} skill requests, expected at least ${MIN_SPACED_REQUESTS}`,
        );
      }
      const gaps = starts.slice(1).map((at, i) => at - starts[i]);
      const short = gaps.filter((gap) => gap < SPACING_MS);
      if (short.length > 0) {
        throw new Error(
          `${short.length} of ${gaps.length} gaps under ${SPACING_MS} ms: ${short.join(", ")} ms`,
        );
      }
      return `${starts.length} skill requests, shortest gap ${Math.min(...gaps)} ms`;
    },
  },
];
