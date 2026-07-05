import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AIH_CAPABILITIES_FILE,
  capabilityPruneCommand,
  capabilityResolveCommand,
  machineCapabilityCachePath,
  type MachineCapabilityCache,
} from "../../src/capability/index.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const CONTEXT_DIR = "ai-coding";

let workspace: string;
let staleRepo: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-capability-root-"));
  staleRepo = mkdtempSync(join(tmpdir(), "aih-capability-stale-"));
  home = mkdtempSync(join(tmpdir(), "aih-capability-home-"));
});

afterEach(() => {
  for (const dir of [workspace, staleRepo, home]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  const env = { HOME: home, USERPROFILE: home };
  return {
    root: workspace,
    contextDir: CONTEXT_DIR,
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env }),
    env,
    posture: "vibe",
    options: {},
    ...over,
  };
}

function write(rel: string, body: string, root = workspace): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function seedNodeRepo(): void {
  write(
    "package.json",
    JSON.stringify({
      name: "svc",
      scripts: { test: "vitest run", build: "tsc -p ." },
      devDependencies: { typescript: "^5.0.0", vitest: "^2.0.0" },
    }),
  );
  write("tsconfig.json", "{}");
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("aih capability resolve", () => {
  it("plans evidence-backed repo capability decisions without fetching or executing", async () => {
    seedNodeRepo();

    const result = await executePlan(await capabilityResolveCommand.plan(ctx()), ctx());
    const digest = result.digests.find((item) => item.describe === "capability resolve");
    const data = digest?.data as {
      decisions: Array<{ name: string; install: string; reason: string; evidence: unknown[] }>;
    };

    expect(result.execs).toEqual([]);
    expect(result.writes.map((w) => w.path)).toEqual([
      AIH_CAPABILITIES_FILE,
      machineCapabilityCachePath(ctx()),
    ]);
    expect(existsSync(join(workspace, AIH_CAPABILITIES_FILE))).toBe(false);
    expect(existsSync(machineCapabilityCachePath(ctx()))).toBe(false);
    expect(data.decisions.map((d) => d.name)).toEqual(
      expect.arrayContaining([
        "common.security-review",
        "common.tdd-workflow",
        "stack.node-typescript",
      ]),
    );
    for (const decision of data.decisions) {
      expect(decision.reason).not.toHaveLength(0);
      expect(decision.evidence.length).toBeGreaterThan(0);
    }
  });

  it("--apply writes committed repo intent and a derived machine cache outside the repo", async () => {
    seedNodeRepo();
    const c = ctx({ apply: true });

    const result = await executePlan(await capabilityResolveCommand.plan(c), c);

    expect(result.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: AIH_CAPABILITIES_FILE, effect: "create" }),
        expect.objectContaining({ path: machineCapabilityCachePath(c), effect: "create" }),
      ]),
    );
    const manifest = readJson<{ schemaVersion: 1; requires: Array<{ id: string }> }>(
      join(workspace, AIH_CAPABILITIES_FILE),
    );
    expect(manifest.requires.map((item) => item.id)).toContain("stack.node-typescript");

    const cache = readJson<MachineCapabilityCache>(machineCapabilityCachePath(c));
    expect(cache.repos).toHaveLength(1);
    expect(cache.repos[0]).toMatchObject({
      root: workspace,
      manifestPath: AIH_CAPABILITIES_FILE,
    });
    expect(cache.repos[0]?.capabilities).toContain("common.security-review");
    expect(existsSync(join(workspace, ".aih", "capabilities"))).toBe(false);
  });

  it("enterprise posture records needs as approval-required hints, not auto-adds", async () => {
    seedNodeRepo();

    const result = await executePlan(
      await capabilityResolveCommand.plan(ctx({ posture: "enterprise" })),
      ctx({ posture: "enterprise" }),
    );
    const digest = result.digests.find((item) => item.describe === "capability resolve");
    const data = digest?.data as {
      decisions: Array<{ name: string; install: string }>;
    };

    expect(data.decisions.map((d) => d.install)).not.toContain("auto-add");
    expect(data.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "stack.node-typescript",
          install: "requires-approval",
        }),
      ]),
    );
  });
});

describe("aih capability prune", () => {
  it("rewrites the derived machine cache to drop repos whose committed manifest is absent", async () => {
    seedNodeRepo();
    const c = ctx({ apply: true });
    await executePlan(await capabilityResolveCommand.plan(c), c);

    write(
      AIH_CAPABILITIES_FILE,
      JSON.stringify({ schemaVersion: 1, requires: [{ id: "common.security-review" }] }),
      staleRepo,
    );
    const cachePath = machineCapabilityCachePath(c);
    const cache = readJson<MachineCapabilityCache>(cachePath);
    writeFileSync(
      cachePath,
      JSON.stringify(
        {
          ...cache,
          repos: [
            ...cache.repos,
            {
              root: staleRepo,
              manifestPath: AIH_CAPABILITIES_FILE,
              manifestSha256: "0".repeat(64),
              capabilities: ["common.security-review"],
            },
          ],
        },
        null,
        2,
      ),
    );
    rmSync(join(staleRepo, AIH_CAPABILITIES_FILE));

    const result = await executePlan(await capabilityPruneCommand.plan(c), c);

    const next = readJson<MachineCapabilityCache>(cachePath);
    expect(next.repos.map((repo) => repo.root)).toEqual([workspace]);
    expect(result.digests[0]?.text).toContain("pruned 1 stale repo");
    expect(result.removed).toEqual([]);
  });

  it("fails closed on a malformed machine cache instead of overwriting it", async () => {
    const c = ctx({ apply: true });
    const cachePath = machineCapabilityCachePath(c);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, "{ not json", "utf8");

    await expect(executePlan(await capabilityPruneCommand.plan(c), c)).rejects.toThrow(
      /machine capability cache is not valid JSON/,
    );
    expect(readFileSync(cachePath, "utf8")).toBe("{ not json");
  });
});
