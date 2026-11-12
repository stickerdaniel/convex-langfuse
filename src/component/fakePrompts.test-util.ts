// Test-only fake of the Langfuse prompt API and a webhook signer. Not part
// of the build. It serves `GET /api/public/v2/prompts` and
// `GET /api/public/v2/prompts/{name}` from state a test changes between
// calls, and resolves prompt references the way the server does
// (`packages/shared/src/server/services/PromptService/index.ts`).

import { createHmac } from "node:crypto";
import type { Behaviour, RecordedRequest } from "./fakeLangfuse.test-util.js";

type Message = Record<string, unknown>;

export type FakeVersion = {
  version: number;
  type: "text" | "chat";
  /** Text or messages; may hold `@@@langfusePrompt:name=X|label=Y@@@` tags. */
  prompt: string | Message[];
  config: unknown;
  labels: string[];
};

type GraphNode = { id: string; name: string; version: number };

const LIST_PATH = "/api/public/v2/prompts";
const TAG = /@@@langfusePrompt:name=([^|@]+)\|(label|version)=([^@]+)@@@/g;

/**
 * Prompt names with their versions. A label belongs to at most one version
 * of a name: `add` and `move` take it from the others.
 */
export class FakePrompts {
  readonly prompts = new Map<string, FakeVersion[]>();
  /** Lists resolution graph dependencies and keys in reverse order. */
  reverseGraphs = false;
  /** Answers a request before the state does, unless it returns `undefined`. */
  override?: (request: RecordedRequest) => Behaviour | undefined;

  /** Adds the next version of `name` and returns its number. */
  add(
    name: string,
    prompt: string | Message[],
    labels: string[] = ["production"],
    config: unknown = {},
  ): number {
    const versions = this.prompts.get(name) ?? [];
    this.prompts.set(name, versions);
    const version = (versions.at(-1)?.version ?? 0) + 1;
    versions.push({
      version,
      type: typeof prompt === "string" ? "text" : "chat",
      prompt,
      config,
      labels: [],
    });
    this.move(name, version, ...labels);
    return version;
  }

  /** Points `labels` of `name` to `version`. */
  move(name: string, version: number, ...labels: string[]): void {
    for (const entry of this.prompts.get(name) ?? []) {
      entry.labels = entry.labels.filter((label) => !labels.includes(label));
      if (entry.version === version) entry.labels.push(...labels);
    }
  }

  delete(name: string): void {
    this.prompts.delete(name);
  }

  answer(request: RecordedRequest): Behaviour {
    const overridden = this.override?.(request);
    if (overridden) return overridden;
    const url = new URL(request.url);
    if (url.pathname === LIST_PATH) return this.#list(url.searchParams);
    if (url.pathname.startsWith(`${LIST_PATH}/`)) {
      const segment = url.pathname.slice(LIST_PATH.length + 1);
      // An unencoded slash would reach another route.
      if (segment.includes("/")) return { status: 404, body: {} };
      return this.#get(decodeURIComponent(segment), url.searchParams);
    }
    return { status: 404, body: {} };
  }

  #list(params: URLSearchParams): Behaviour {
    const page = Number(params.get("page") ?? 1);
    const limit = Number(params.get("limit") ?? 10);
    const filter = params.get("name");
    const names = [...this.prompts.keys()]
      .filter((name) => filter === null || name === filter)
      .sort();
    const data = names.slice((page - 1) * limit, page * limit).map((name) => {
      const versions = this.prompts.get(name)!;
      return {
        name,
        versions: versions.map((entry) => entry.version),
        labels: [...new Set(versions.flatMap((entry) => entry.labels))].sort(),
        tags: [],
        lastUpdatedAt: new Date().toISOString(),
        type: versions.at(-1)!.type,
        lastConfig: versions.at(-1)!.config,
      };
    });
    return {
      status: 200,
      body: {
        data,
        meta: {
          page,
          limit,
          totalItems: names.length,
          totalPages: Math.ceil(names.length / limit),
        },
      },
    };
  }

  #find(name: string, by: "label" | "version", value: string) {
    return this.prompts
      .get(name)
      ?.find((entry) =>
        by === "label"
          ? entry.labels.includes(value)
          : entry.version === Number(value),
      );
  }

  #get(name: string, params: URLSearchParams): Behaviour {
    const version = params.get("version");
    const entry =
      version === null
        ? this.#find(name, "label", params.get("label") ?? "production")
        : this.#find(name, "version", version);
    if (!entry) return { status: 404, body: { message: "not found" } };
    const dependencies: Record<string, GraphNode[]> = {};
    let prompt: unknown;
    try {
      prompt = this.#resolve(name, entry, dependencies);
    } catch {
      return { status: 409, body: { message: "dependency not found" } };
    }
    let graph: unknown = null;
    if (Object.keys(dependencies).length > 0) {
      const entries = Object.entries(dependencies).map(
        ([parent, nodes]) =>
          [parent, this.reverseGraphs ? [...nodes].reverse() : nodes] as const,
      );
      graph = {
        root: { name, version: entry.version, id: `${name}@${entry.version}` },
        dependencies: Object.fromEntries(
          this.reverseGraphs ? entries.reverse() : entries,
        ),
      };
      if (this.reverseGraphs) {
        const { root, dependencies: deps } = graph as Record<string, unknown>;
        graph = { dependencies: deps, root };
      }
    }
    return {
      status: 200,
      body: {
        id: `${name}@${entry.version}`,
        name,
        version: entry.version,
        type: entry.type,
        prompt,
        config: entry.config,
        labels: entry.labels,
        tags: [],
        resolutionGraph: graph,
      },
    };
  }

  /** The prompt of `entry` with every tag replaced; throws on a missing one. */
  #resolve(
    name: string,
    entry: FakeVersion,
    dependencies: Record<string, GraphNode[]>,
  ): unknown {
    const text = JSON.stringify(entry.prompt);
    const resolved = text.replace(
      TAG,
      (_, child: string, by: "label" | "version", value: string) => {
        const target = this.#find(child, by, value);
        if (!target) throw new Error("missing dependency");
        (dependencies[`${name}@${entry.version}`] ??= []).push({
          id: `${child}@${target.version}`,
          name: child,
          version: target.version,
        });
        const inner = this.#resolve(child, target, dependencies);
        return JSON.stringify(inner).slice(1, -1);
      },
    );
    return JSON.parse(resolved);
  }
}

export const WEBHOOK_SECRET = "lf-whsec_0123456789abcdef";

/**
 * The `x-langfuse-signature` header Langfuse sends for `body` at `at` ms,
 * computed as `generateWebhookSignature` in
 * `packages/shared/src/encryption/signature.ts` does.
 */
export function signature(
  body: string,
  at: number = Date.now(),
  secret: string = WEBHOOK_SECRET,
): string {
  const timestamp = Math.floor(at / 1000);
  const hex = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${hex}`;
}

/** A `prompt-version` webhook body for `name`. */
export function webhookBody(
  name: string,
  action: "created" | "updated" | "deleted" = "updated",
): string {
  return JSON.stringify({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: "prompt-version",
    apiVersion: "v1",
    action,
    prompt: { name, version: 1, labels: ["production"] },
  });
}
