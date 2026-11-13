// Test-only fake of the Langfuse skill API, a `skill-version` webhook body
// and a driver for the skill loop under fake timers. Not part of the build.
// The response shapes follow the captures of Langfuse Cloud 4.80.0
// (`GET /api/public/skills/{name}?includeContent=true`,
// `GET /api/public/skills`) and `web/src/features/skills/server/
// skill-service.ts`, with ids of the fake's own.

import { createHash } from "node:crypto";
import { vi } from "vitest";
import type {
  Behaviour,
  FakeLangfuse,
  RecordedRequest,
  TestConvex,
} from "./fakeLangfuse.test-util.js";

export type SkillFile = { path: string; content: string };

type FakeSkillVersion = {
  id: string;
  version: number;
  description: string;
  frontmatter: Record<string, unknown>;
  files: SkillFile[];
  labels: string[];
  createdAt: string;
};

const PATH = "/api/public/skills";
const NOT_FOUND = {
  message: "Skill version not found",
  error: "LangfuseNotFoundError",
};

export const SKILL_WEBHOOK_SECRET = "lf-whsec_skill_fedcba9876543210";

/** Base64 SHA-256 of the UTF-8 content, as Langfuse's `sha256Hash`. */
export function sha256Base64(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("base64");
}

/** The three files of the captured skill, under `name`. */
export function skillFiles(
  name: string,
  note = "three sentences",
): SkillFile[] {
  return [
    {
      path: "scripts/round.py",
      content: "print(round(21.4))\n",
    },
    {
      path: "SKILL.md",
      content:
        `---\nname: ${name}\ndescription: Writes a short weather report ` +
        `from a forecast.\n---\n\nReport the forecast in ${note}.\n`,
    },
    { path: "reference/units.md", content: "Use Celsius and km/h.\n" },
  ];
}

/**
 * Skill names with their versions. `latest` is managed as Langfuse does: a
 * new version takes it, and deleting its holder moves it to the highest
 * version left. A label belongs to at most one version of a name.
 */
export class FakeSkills {
  readonly skills = new Map<string, FakeSkillVersion[]>();
  /** Changes a version's GET body before it is sent. */
  mangle?: (body: Record<string, unknown>) => void;
  #updated = new Map<string, number>();
  #clock = 0;

  /** Adds the next version of `name` with `labels` and `latest`; returns its number. */
  add(
    name: string,
    {
      files = skillFiles(name),
      labels = ["production"],
      frontmatter = {
        name,
        description: "Writes a short weather report from a forecast.",
      },
    }: {
      files?: SkillFile[];
      labels?: string[];
      frontmatter?: Record<string, unknown>;
    } = {},
  ): number {
    const versions = this.skills.get(name) ?? [];
    this.skills.set(name, versions);
    const version = Math.max(0, ...versions.map((entry) => entry.version)) + 1;
    versions.push({
      id: crypto.randomUUID(),
      version,
      description: "Writes a short weather report from a forecast.",
      frontmatter,
      files,
      labels: [],
      createdAt: new Date().toISOString(),
    });
    this.move(name, version, ...labels, "latest");
    return version;
  }

  /** Points `labels` of `name` to `version`. */
  move(name: string, version: number, ...labels: string[]): void {
    for (const entry of this.skills.get(name) ?? []) {
      entry.labels = entry.labels.filter((label) => !labels.includes(label));
      if (entry.version === version) entry.labels.push(...labels);
    }
    this.#updated.set(name, ++this.#clock);
  }

  /** Removes `labels` from every version of `name`. */
  unlabel(name: string, ...labels: string[]): void {
    this.move(name, 0, ...labels);
  }

  /** Deletes one version; `latest` moves to the highest version left. */
  deleteVersion(name: string, version: number): void {
    const versions = (this.skills.get(name) ?? []).filter(
      (entry) => entry.version !== version,
    );
    if (versions.length === 0) {
      this.delete(name);
      return;
    }
    this.skills.set(name, versions);
    const highest = Math.max(...versions.map((entry) => entry.version));
    this.move(name, highest, "latest");
  }

  delete(name: string): void {
    this.skills.delete(name);
    this.#updated.delete(name);
  }

  find(name: string, label: string): FakeSkillVersion | undefined {
    return this.skills.get(name)?.find((entry) => entry.labels.includes(label));
  }

  /** The `skill` object of a GET response or a webhook event. */
  skill(name: string, entry: FakeSkillVersion, content: boolean) {
    return {
      id: entry.id,
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
      projectId: "project-test",
      createdBy: "API",
      name,
      description: entry.description,
      frontmatter: entry.frontmatter,
      version: entry.version,
      tags: [],
      labels: entry.labels,
      commitMessage: null,
      files: entry.files.map((file, i) => ({
        id: `${entry.id}-file-${i}`,
        path: file.path,
        blobId: `${entry.id}-blob-${i}`,
        sha256Hash: sha256Base64(file.content),
        contentType: "text/plain",
        contentLength: Buffer.byteLength(file.content, "utf8"),
        ...(content ? { content: file.content } : {}),
      })),
    };
  }

  answer(request: RecordedRequest): Behaviour {
    const url = new URL(request.url);
    if (url.pathname === PATH) return this.#list(url.searchParams);
    if (!url.pathname.startsWith(`${PATH}/`)) return { status: 404, body: {} };
    const name = decodeURIComponent(url.pathname.slice(PATH.length + 1));
    const version = url.searchParams.get("version");
    const entry =
      version === null
        ? this.find(name, url.searchParams.get("label") ?? "production")
        : this.skills.get(name)?.find((e) => e.version === Number(version));
    if (!entry) return { status: 404, body: NOT_FOUND };
    const body: Record<string, unknown> = this.skill(
      name,
      entry,
      url.searchParams.get("includeContent") === "true",
    );
    this.mangle?.(body);
    return { status: 200, body };
  }

  /** One row per name, latest version, most recently updated first. */
  #list(params: URLSearchParams): Behaviour {
    const page = Number(params.get("page") ?? 1);
    const limit = Number(params.get("limit") ?? 10);
    const names = [...this.skills.keys()].sort(
      (a, b) =>
        this.#updated.get(b)! - this.#updated.get(a)! || (a < b ? -1 : 1),
    );
    const data = names.slice((page - 1) * limit, page * limit).map((name) => {
      const latest = this.find(name, "latest")!;
      return {
        name,
        description: latest.description,
        tags: [],
        latestVersion: latest.version,
        latestVersionCreatedAt: latest.createdAt,
        latestVersionLastUpdatedAt: latest.createdAt,
        productionVersion: this.find(name, "production")?.version ?? null,
      };
    });
    const totalPages = Math.ceil(names.length / limit);
    return {
      status: 200,
      body: {
        data,
        meta: {
          page,
          limit,
          totalItems: names.length,
          totalPages,
          hasNextPage: page < totalPages,
        },
      },
    };
  }
}

/**
 * A `skill-version` webhook body as Langfuse sends it: the full version after
 * the change, without file contents. A version the fake no longer has goes
 * out with its number only, as a `deleted` event would carry it.
 */
export function skillEvent(
  skills: FakeSkills,
  name: string,
  action: "created" | "updated" | "deleted" = "updated",
  version?: number,
): string {
  const entry =
    version === undefined
      ? skills.find(name, "latest")
      : skills.skills.get(name)?.find((e) => e.version === version);
  return JSON.stringify({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: "skill-version",
    apiVersion: "v1",
    action,
    skill: entry
      ? skills.skill(name, entry, false)
      : { name, version: version ?? 1, labels: [], files: [] },
  });
}

// Captured before a test installs fake timers.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realTick = () => new Promise((resolve) => realSetTimeout(resolve, 1));

/**
 * Advances the fake clock one timer at a time until `until` holds, for at
 * most `maxMs` of fake time. The skill run sleeps on the fake clock between
 * requests, so it never finishes while the clock stands still: after 4 real
 * ticks of 1 ms without the scheduled functions finishing, the step treats
 * them as waiting for a timer and advances the clock. `onStep` runs after every
 * step, for sampling state or interleaving a delivery.
 */
export async function driveSkills(
  t: Pick<TestConvex, "finishInProgressScheduledFunctions">,
  fake: FakeLangfuse,
  {
    until = () => false,
    onStep,
    maxMs = 24 * 60 * 60 * 1_000,
  }: {
    until?: () => boolean | Promise<boolean>;
    onStep?: () => void | Promise<void>;
    maxMs?: number;
  } = {},
): Promise<void> {
  const deadline = Date.now() + maxMs;
  for (let step = 0; step < 200_000; step++) {
    let settled = false;
    void t.finishInProgressScheduledFunctions().then(() => {
      settled = true;
    });
    for (let tick = 0; tick < 4 && !settled && fake.hanging === 0; tick++) {
      await realTick();
    }
    await onStep?.();
    if (await until()) return;
    if (Date.now() >= deadline || vi.getTimerCount() === 0) return;
    await vi.advanceTimersToNextTimerAsync();
  }
  throw new Error("driveSkills: too many steps");
}
