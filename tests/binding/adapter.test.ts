import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  BindingAdapterRegistryError,
  type BindingContext,
  type ProvisionRequest,
} from "../../src/binding/adapter.js";
import { parseBindingLock } from "../../src/binding/lock.js";
import {
  BindingScanError,
  type DimensionInspector,
  type FastScanPolicy,
  type ResolvedGitSource,
  type ResolvedSource,
  resolveGitSource,
  runFastScanGate,
  type ScanDisposition,
  scannableFromGit,
} from "../../src/binding/scan-gate.js";
import {
  type BindingDeclaration,
  BindingFrameworkConflictError,
} from "../../src/binding/schema.js";
import { defaultRunner } from "../../src/internals/proc.js";
import { createFakeAdapter } from "./fake-adapter.js";

const DUMMY_RESOLVED: ResolvedSource = {
  kind: "git",
  repository: "affaan-m/ECC",
  commitSha: "c".repeat(40),
  treeDigest: "d".repeat(64),
  treePath: "/does/not/matter",
};

const producedClean: DimensionInspector = {
  dimension: "c",
  run: () => ({ dimension: "c", status: "produced", findings: [] }),
};
const producedCritical: DimensionInspector = {
  dimension: "x",
  run: () => ({
    dimension: "x",
    status: "produced",
    findings: [
      { code: "trust.malicious-code", severity: "critical", detail: "boom", coverage: "complete" },
    ],
  }),
};
const missingDim: DimensionInspector = {
  dimension: "m",
  run: () => ({ dimension: "m", status: "missing", reason: "deferred", findings: [] }),
};

function eccDeclaration(): BindingDeclaration {
  return {
    schemaVersion: 1,
    framework: { id: "ecc", mode: "lean", host: "claude" },
    source: {
      kind: "git",
      repository: "affaan-m/ECC",
      commitSha: "c".repeat(40),
      treeDigest: "d".repeat(64),
    },
  };
}

let repoDir: string;
const cleanups: string[] = [];

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  g(["init", "-b", "main"]);
  g(["config", "user.email", "test@example.com"]);
  g(["config", "user.name", "Binding Test"]);
  g(["config", "commit.gpgsign", "false"]);
  const skill = join(dir, "SKILL.md");
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, "# skill\n");
  g(["add", "-A"]);
  g(["commit", "-m", "init"]);
}

async function resolveFixture(): Promise<ResolvedGitSource> {
  const home = mkdtempSync(join(tmpdir(), "aih-adapter-home-"));
  cleanups.push(home);
  return resolveGitSource(
    { repository: repoDir, ref: "HEAD" },
    { runner: defaultRunner, cacheHome: home },
  );
}

async function makeDisposition(
  inspectors: DimensionInspector[],
  policy: FastScanPolicy,
): Promise<ScanDisposition> {
  const home = mkdtempSync(join(tmpdir(), "aih-adapter-scan-"));
  cleanups.push(home);
  const resolved = await resolveGitSource(
    { repository: repoDir, ref: "HEAD" },
    { runner: defaultRunner, cacheHome: home },
  );
  return runFastScanGate(scannableFromGit(resolved), policy, { cacheHome: home, inspectors });
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "aih-adapter-repo-"));
  initGitRepo(repoDir);
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("adapter-type registry (D6)", () => {
  it("registers each of the four active adapter types across the v1 framework set", () => {
    const registry = new AdapterRegistry();
    const pairs = [
      ["ecc", "host-plugin"],
      ["superpowers", "project-skills"],
      ["gstack", "upstream-local-installer"],
    ] as const;
    for (const [framework, adapterType] of pairs) {
      registry.register(createFakeAdapter({ framework, adapterType, resolved: DUMMY_RESOLVED }));
    }
    expect(registry.frameworks().sort()).toEqual(["ecc", "gstack", "superpowers"]);
    expect(registry.get("ecc")?.adapterType).toBe("host-plugin");
    // The fourth active type registers too (the v1 set has three frameworks, so
    // shared-runtime is proven on a fresh registry rather than a fourth id).
    const second = new AdapterRegistry();
    second.register(
      createFakeAdapter({
        framework: "gstack",
        adapterType: "shared-runtime",
        resolved: DUMMY_RESOLVED,
      }),
    );
    expect(second.get("gstack")?.adapterType).toBe("shared-runtime");
  });

  it("refuses to register a deferred standalone-host adapter", () => {
    const registry = new AdapterRegistry();
    expect(() =>
      registry.register(
        createFakeAdapter({
          framework: "ecc",
          adapterType: "standalone-host",
          resolved: DUMMY_RESOLVED,
        }),
      ),
    ).toThrow(BindingAdapterRegistryError);
  });

  it("refuses a duplicate framework registration", () => {
    const registry = new AdapterRegistry();
    registry.register(
      createFakeAdapter({ framework: "ecc", adapterType: "host-plugin", resolved: DUMMY_RESOLVED }),
    );
    expect(() =>
      registry.register(
        createFakeAdapter({
          framework: "ecc",
          adapterType: "project-skills",
          resolved: DUMMY_RESOLVED,
        }),
      ),
    ).toThrow(BindingAdapterRegistryError);
  });
});

describe("adapter contract — provision authorization (D12 code path)", () => {
  it("requires a scan disposition to provision (compile-level type + runtime fail-closed)", async () => {
    const adapter = createFakeAdapter({
      framework: "ecc",
      adapterType: "host-plugin",
      resolved: DUMMY_RESOLVED,
    });
    const resolved = await resolveFixture();
    const request: ProvisionRequest = { context: { declaration: eccDeclaration() }, resolved };
    // @ts-expect-error provision is not callable without a ScanDisposition argument
    await expect(adapter.provision(request)).rejects.toBeInstanceOf(BindingScanError);
  });

  it("provisions with an allow disposition whose digest matches the resolved source", async () => {
    const adapter = createFakeAdapter({
      framework: "ecc",
      adapterType: "host-plugin",
      resolved: DUMMY_RESOLVED,
    });
    const resolved = await resolveFixture();
    const disposition = await makeDisposition([producedClean], { posture: "enterprise" });
    const request: ProvisionRequest = { context: { declaration: eccDeclaration() }, resolved };

    const result = await adapter.provision(request, disposition);
    expect(result.lock.scannedDigest).toBe(resolved.treeDigest);
    expect(result.lock.match).toBe(true);
    // The produced applied-state is a valid lock record.
    expect(() => parseBindingLock(result.lock)).not.toThrow();
  });

  it("rejects a forged, unbranded disposition", async () => {
    const adapter = createFakeAdapter({
      framework: "ecc",
      adapterType: "host-plugin",
      resolved: DUMMY_RESOLVED,
    });
    const resolved = await resolveFixture();
    const forged = {
      digest: resolved.treeDigest,
      verdict: "allow",
      findings: [],
      posture: "enterprise",
      producedAt: new Date().toISOString(),
    } as unknown as ScanDisposition;
    const request: ProvisionRequest = { context: { declaration: eccDeclaration() }, resolved };
    await expect(adapter.provision(request, forged)).rejects.toBeInstanceOf(BindingScanError);
  });

  it("rejects a disposition whose digest does not match the resolved source", async () => {
    const adapter = createFakeAdapter({
      framework: "ecc",
      adapterType: "host-plugin",
      resolved: DUMMY_RESOLVED,
    });
    const disposition = await makeDisposition([producedClean], { posture: "enterprise" });
    const mismatchedResolved: ResolvedGitSource = {
      kind: "git",
      repository: repoDir,
      commitSha: "e".repeat(40),
      treeDigest: "f".repeat(64),
      treePath: "/x",
    };
    const request: ProvisionRequest = {
      context: { declaration: eccDeclaration() },
      resolved: mismatchedResolved,
    };
    await expect(adapter.provision(request, disposition)).rejects.toBeInstanceOf(BindingScanError);
  });

  it("rejects a block-verdict disposition", async () => {
    const adapter = createFakeAdapter({
      framework: "ecc",
      adapterType: "host-plugin",
      resolved: DUMMY_RESOLVED,
    });
    const resolved = await resolveFixture();
    const blocked = await makeDisposition([producedCritical], {
      posture: "vibe",
      allowIncompleteAtVibe: true,
    });
    const request: ProvisionRequest = { context: { declaration: eccDeclaration() }, resolved };
    await expect(adapter.provision(request, blocked)).rejects.toBeInstanceOf(BindingScanError);
  });

  it("handles incomplete coverage per posture", async () => {
    const adapter = createFakeAdapter({
      framework: "ecc",
      adapterType: "host-plugin",
      resolved: DUMMY_RESOLVED,
    });
    const resolved = await resolveFixture();
    const request: ProvisionRequest = { context: { declaration: eccDeclaration() }, resolved };

    const vibeAllows = await makeDisposition([producedClean, missingDim], {
      posture: "vibe",
      allowIncompleteAtVibe: true,
    });
    await expect(adapter.provision(request, vibeAllows)).resolves.toBeDefined();

    const enterpriseBlocks = await makeDisposition([producedClean, missingDim], {
      posture: "enterprise",
    });
    await expect(adapter.provision(request, enterpriseBlocks)).rejects.toBeInstanceOf(
      BindingScanError,
    );
  });
});

describe("adapter contract — one framework per project (D8 layers 2 and 3)", () => {
  it("plan re-rejects a second framework (layer 2), independent of provision", () => {
    const adapter = createFakeAdapter({
      framework: "ecc",
      adapterType: "host-plugin",
      resolved: DUMMY_RESOLVED,
    });
    const context: BindingContext = {
      declaration: eccDeclaration(),
      existingFramework: "superpowers",
    };
    expect(() => adapter.plan(context)).toThrow(BindingFrameworkConflictError);
  });

  it("plan allows re-binding the same framework", () => {
    const adapter = createFakeAdapter({
      framework: "ecc",
      adapterType: "host-plugin",
      resolved: DUMMY_RESOLVED,
    });
    const context: BindingContext = { declaration: eccDeclaration(), existingFramework: "ecc" };
    expect(() => adapter.plan(context)).not.toThrow();
  });

  it("provision re-rejects a second framework (layer 3), even with a valid allow disposition", async () => {
    const adapter = createFakeAdapter({
      framework: "ecc",
      adapterType: "host-plugin",
      resolved: DUMMY_RESOLVED,
    });
    const resolved = await resolveFixture();
    const disposition = await makeDisposition([producedClean], { posture: "enterprise" });
    const request: ProvisionRequest = {
      context: { declaration: eccDeclaration(), existingFramework: "superpowers" },
      resolved,
    };
    await expect(adapter.provision(request, disposition)).rejects.toBeInstanceOf(
      BindingFrameworkConflictError,
    );
  });
});

describe("adapter contract — inspect/resolve/verify/remove/report smoke", () => {
  it("exposes the full D6 contract surface", async () => {
    const adapter = createFakeAdapter({
      framework: "ecc",
      adapterType: "host-plugin",
      resolved: DUMMY_RESOLVED,
    });
    expect((await adapter.inspect({ treePath: "/t" })).framework).toBe("ecc");
    expect((await adapter.resolve({ declaration: eccDeclaration() })).kind).toBe("git");
    expect(adapter.verify({ declaration: eccDeclaration() }).ok).toBe(true);
    expect(adapter.remove({ declaration: eccDeclaration() }).mode).toBe("drift-report-only");
    expect(adapter.report({ declaration: eccDeclaration() }).framework).toBe("ecc");
  });
});
