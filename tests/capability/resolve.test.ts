import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AIH_CAPABILITIES_FILE,
  capabilityPruneCommand,
  capabilityResolveCommand,
  type MachineCapabilityCache,
  machineCapabilityCachePath,
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

function requirement(id: string, install = "auto-add") {
  return {
    id,
    install,
    reason: `${id} requirement`,
    evidence: [{ kind: "catalog", source: id, detail: `${id} evidence` }],
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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

  it("rejects unsafe repo roots before planning cache writes", async () => {
    const c = ctx({ root: "\\\\example.invalid\\share" });

    await expect(async () => {
      await capabilityResolveCommand.plan(c);
    }).rejects.toThrow(/safe local absolute repo root/);
  });

  it("normalizes safe absolute repo roots before writing machine cache entries", async () => {
    seedNodeRepo();
    mkdirSync(join(workspace, "nested"));
    const c = ctx({ apply: true, root: join(workspace, "nested", "..") });

    await executePlan(await capabilityResolveCommand.plan(c), c);

    const cache = readJson<MachineCapabilityCache>(machineCapabilityCachePath(c));
    expect(cache.repos[0]?.root).toBe(resolve(workspace));
  });

  it("preserves committed intent and never downgrades stricter existing installs", async () => {
    seedNodeRepo();
    write(
      AIH_CAPABILITIES_FILE,
      JSON.stringify({
        schemaVersion: 1,
        requires: [
          requirement("custom.manual", "warn"),
          requirement("stack.node-typescript", "requires-approval"),
        ],
      }),
    );
    const c = ctx({ apply: true, posture: "vibe" });

    await executePlan(await capabilityResolveCommand.plan(c), c);

    const manifest = readJson<{
      requires: Array<{ id: string; install: string }>;
    }>(join(workspace, AIH_CAPABILITIES_FILE));
    expect(manifest.requires).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "custom.manual", install: "warn" }),
        expect.objectContaining({
          id: "stack.node-typescript",
          install: "requires-approval",
        }),
        expect.objectContaining({ id: "common.security-review", install: "auto-add" }),
      ]),
    );

    const cache = readJson<MachineCapabilityCache>(machineCapabilityCachePath(c));
    expect(cache.repos[0]?.capabilities).toEqual(
      expect.arrayContaining(["custom.manual", "stack.node-typescript"]),
    );
  });

  it("preserves committed audit context while appending generated evidence", async () => {
    seedNodeRepo();
    write(
      AIH_CAPABILITIES_FILE,
      JSON.stringify({
        schemaVersion: 1,
        requires: [
          {
            ...requirement("stack.node-typescript", "warn"),
            reason: "manually reviewed TypeScript capability",
          },
        ],
      }),
    );
    const c = ctx({ apply: true, posture: "vibe" });

    await executePlan(await capabilityResolveCommand.plan(c), c);

    const manifest = readJson<{
      requires: Array<{ id: string; install: string; reason: string; evidence: unknown[] }>;
    }>(join(workspace, AIH_CAPABILITIES_FILE));
    const stack = manifest.requires.find((item) => item.id === "stack.node-typescript");
    expect(stack).toMatchObject({
      install: "warn",
      reason: "manually reviewed TypeScript capability",
    });
    expect(stack?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: "stack.node-typescript evidence" }),
        expect.objectContaining({ source: "profile.scanRepo.languages" }),
      ]),
    );
  });

  it("rejects duplicate committed capability ids instead of guessing intent", async () => {
    write(
      AIH_CAPABILITIES_FILE,
      JSON.stringify({
        schemaVersion: 1,
        requires: [
          requirement("common.security-review", "auto-add"),
          requirement("common.security-review", "requires-approval"),
        ],
      }),
    );

    await expect(async () => {
      await capabilityResolveCommand.plan(ctx());
    }).rejects.toThrow(/contains entries aih cannot parse/);
  });

  it("refuses a non-regular committed manifest before reading capability intent", async () => {
    mkdirSync(join(workspace, AIH_CAPABILITIES_FILE));

    await expect(async () => {
      await capabilityResolveCommand.plan(ctx());
    }).rejects.toThrow(/must be a regular root file/);
  });

  it("refuses a symlinked committed manifest instead of following it", async () => {
    const target = join(staleRepo, "outside-capabilities.json");
    writeFileSync(
      target,
      JSON.stringify({ schemaVersion: 1, requires: [requirement("custom.manual")] }),
      "utf8",
    );
    try {
      symlinkSync(target, join(workspace, AIH_CAPABILITIES_FILE));
    } catch {
      return;
    }

    await expect(async () => {
      await capabilityResolveCommand.plan(ctx());
    }).rejects.toThrow(/must be a regular root file/);
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

  it("normalizes enterprise posture case before selecting install mode", async () => {
    seedNodeRepo();

    const c = ctx({ posture: "Enterprise" as unknown as PlanContext["posture"] });
    const result = await executePlan(await capabilityResolveCommand.plan(c), c);
    const digest = result.digests.find((item) => item.describe === "capability resolve");
    const data = digest?.data as {
      decisions: Array<{ install: string }>;
    };

    expect(data.decisions.map((d) => d.install)).toEqual([
      "requires-approval",
      "requires-approval",
      "requires-approval",
    ]);
  });

  it("rejects unknown posture values instead of falling back to auto-add", async () => {
    seedNodeRepo();

    await expect(async () => {
      await capabilityResolveCommand.plan(
        ctx({ posture: "enterprsie" as unknown as PlanContext["posture"] }),
      );
    }).rejects.toThrow(/invalid posture/);
  });

  it("team posture records detected needs as warnings", async () => {
    seedNodeRepo();

    const result = await executePlan(
      await capabilityResolveCommand.plan(ctx({ posture: "team" })),
      ctx({ posture: "team" }),
    );
    const digest = result.digests.find((item) => item.describe === "capability resolve");
    const data = digest?.data as {
      decisions: Array<{ install: string }>;
    };

    expect(data.decisions.map((d) => d.install)).toEqual(["warn", "warn", "warn"]);
  });

  it("fails closed when the catalog engine check cannot parse the current aih version", async () => {
    seedNodeRepo();
    vi.resetModules();
    vi.doMock("../../src/version.js", () => ({ VERSION: "dev" }));
    try {
      const module = await import("../../src/capability/index.js");
      await expect(async () => {
        await module.capabilityResolveCommand.plan(ctx());
      }).rejects.toThrow(/requires a semver aih VERSION/);
    } finally {
      vi.doUnmock("../../src/version.js");
      vi.resetModules();
    }
  });

  it("fails closed when the mandatory security-review capability is engine-incompatible", async () => {
    seedNodeRepo();
    vi.resetModules();
    vi.doMock("../../src/version.js", () => ({ VERSION: "3.0.0" }));
    try {
      const module = await import("../../src/capability/index.js");
      await expect(async () => {
        await module.capabilityResolveCommand.plan(ctx());
      }).rejects.toThrow(/common\.security-review is unavailable/);
    } finally {
      vi.doUnmock("../../src/version.js");
      vi.resetModules();
    }
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

  it("prunes cache entries whose committed manifest is unreadable", async () => {
    seedNodeRepo();
    const c = ctx({ apply: true });
    await executePlan(await capabilityResolveCommand.plan(c), c);

    write(AIH_CAPABILITIES_FILE, "{ not json", staleRepo);
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

    await executePlan(await capabilityPruneCommand.plan(c), c);

    const next = readJson<MachineCapabilityCache>(cachePath);
    expect(next.repos.map((repo) => repo.root)).toEqual([workspace]);
  });

  it("refreshes stale cache entries from committed manifests", async () => {
    seedNodeRepo();
    const c = ctx({ apply: true });
    await executePlan(await capabilityResolveCommand.plan(c), c);
    const cachePath = machineCapabilityCachePath(c);
    const before = readJson<MachineCapabilityCache>(cachePath);

    write(
      AIH_CAPABILITIES_FILE,
      JSON.stringify({
        schemaVersion: 1,
        requires: [requirement("common.security-review", "warn")],
      }),
    );

    const result = await executePlan(await capabilityPruneCommand.plan(c), c);

    const next = readJson<MachineCapabilityCache>(cachePath);
    const rawManifest = readFileSync(join(workspace, AIH_CAPABILITIES_FILE), "utf8");
    expect(next.repos).toHaveLength(1);
    expect(next.repos[0]?.capabilities).toEqual(["common.security-review"]);
    expect(next.repos[0]?.manifestSha256).not.toBe(before.repos[0]?.manifestSha256);
    expect(next.repos[0]?.manifestSha256).toBe(sha256Hex(rawManifest));
    expect(result.digests[0]?.data).toMatchObject({ pruned: 0, refreshed: 1 });
    expect(result.digests[0]?.text).toContain("refreshed 1 repo");
  });

  it("prunes invalid cache roots before touching their manifests", async () => {
    const c = ctx({ apply: true });
    const cachePath = machineCapabilityCachePath(c);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          repos: [
            {
              root: "\\\\example.invalid\\share",
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

    const result = await executePlan(await capabilityPruneCommand.plan(c), c);

    const next = readJson<MachineCapabilityCache>(cachePath);
    expect(next.repos).toEqual([]);
    expect(result.digests[0]?.data).toMatchObject({ pruned: 1, refreshed: 0 });
  });

  it("fails closed on a malformed machine cache instead of overwriting it", async () => {
    const c = ctx({ apply: true });
    const cachePath = machineCapabilityCachePath(c);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, "{ not json", "utf8");

    await expect(async () => {
      await capabilityPruneCommand.plan(c);
    }).rejects.toThrow(/machine capability cache is not valid JSON/);
    expect(readFileSync(cachePath, "utf8")).toBe("{ not json");
  });
});
