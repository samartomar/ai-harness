import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HostTuple, SUPPORTED_HOST_TUPLE } from "../../src/binding/host-tuple.js";
import {
  type DeepDimensionInspector,
  deepScanIdentityOf,
  deepScanKey,
  readDeepScanCache,
  readRuntimeQualification,
  recordRuntimeQualification,
  runDeepScanTier,
  runtimeQualKey,
  ScanCacheTierError,
  sourceIdOf,
} from "../../src/binding/scan-cache-tiers.js";
import {
  type DimensionReport,
  type ResolvedGitSource,
  type ResolvedNpmSource,
  runFastScanGate,
  type ScannableSource,
} from "../../src/binding/scan-gate.js";
import type { BindingSource } from "../../src/binding/schema.js";
import type { Runner, RunResult } from "../../src/internals/proc.js";
import { fakeBindingGateScan } from "./fake-binding-gate.js";

const SHA_TREE = "a".repeat(64);
const COMMIT = "c".repeat(40);
const INTEGRITY = `sha512-${"A".repeat(86)}==`;

const GIT_SOURCE: BindingSource = {
  kind: "git",
  repository: "samartomar/ECC",
  commitSha: COMMIT,
  treeDigest: SHA_TREE,
};
const NPM_SOURCE: BindingSource = {
  kind: "npm",
  package: "@obra/superpowers",
  exactVersion: "1.2.3",
  integrity: INTEGRITY,
};

let cacheHome: string;
beforeEach(() => {
  cacheHome = mkdtempSync(join(tmpdir(), "aih-tier-cache-"));
});
afterEach(() => {
  rmSync(cacheHome, { recursive: true, force: true });
});

// ===========================================================================
// Key determinism (§C.1 / §C.2)
// ===========================================================================

describe("deepScanKey — determinism", () => {
  const base = { framework: "ecc" as const, sourceId: COMMIT, treeDigest: SHA_TREE };

  it("is stable for identical inputs and is a sha256 hex", () => {
    expect(deepScanKey(base)).toBe(deepScanKey({ ...base }));
    expect(deepScanKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when ANY keyed field changes", () => {
    const k = deepScanKey(base);
    expect(deepScanKey({ ...base, framework: "superpowers" })).not.toBe(k);
    expect(deepScanKey({ ...base, sourceId: "d".repeat(40) })).not.toBe(k);
    expect(deepScanKey({ ...base, treeDigest: "b".repeat(64) })).not.toBe(k);
    expect(deepScanKey({ ...base, scannerVersion: 2 })).not.toBe(k);
    expect(deepScanKey({ ...base, policyVersion: 2 })).not.toBe(k);
  });
});

describe("runtimeQualKey — determinism + the fixed tuple semantics", () => {
  const base = {
    framework: "ecc" as const,
    sourceId: COMMIT,
    treeDigest: SHA_TREE,
    selectedProfile: "ecc-lean",
    adapterVersion: 1,
    tuple: SUPPORTED_HOST_TUPLE,
  };

  it("is stable for identical inputs", () => {
    expect(runtimeQualKey(base)).toBe(
      runtimeQualKey({ ...base, tuple: { ...SUPPORTED_HOST_TUPLE } }),
    );
  });

  it("changes when a keyed field changes (profile, adapterVersion, or a keyed tuple fact)", () => {
    const k = runtimeQualKey(base);
    expect(runtimeQualKey({ ...base, selectedProfile: "ecc-full" })).not.toBe(k);
    expect(runtimeQualKey({ ...base, adapterVersion: 2 })).not.toBe(k);
    // claudeCode IS in the key (D12): a CLI bump = a different key = a miss.
    expect(
      runtimeQualKey({
        ...base,
        tuple: { ...SUPPORTED_HOST_TUPLE, claudeCode: { measuredOn: "9.9.9" } },
      }),
    ).not.toBe(k);
    expect(
      runtimeQualKey({ ...base, tuple: { ...SUPPORTED_HOST_TUPLE, windowsBuild: "0" } }),
    ).not.toBe(k);
    expect(runtimeQualKey({ ...base, tuple: { ...SUPPORTED_HOST_TUPLE, arch: "arm64" } })).not.toBe(
      k,
    );
    expect(
      runtimeQualKey({ ...base, tuple: { ...SUPPORTED_HOST_TUPLE, node: "22.0.0" } }),
    ).not.toBe(k);
    expect(runtimeQualKey({ ...base, tuple: { ...SUPPORTED_HOST_TUPLE, bun: "9.9.9" } })).not.toBe(
      k,
    );
  });

  it("does NOT key on windowsUbr (provenance), ramClassGb, or vcpuClass", () => {
    const k = runtimeQualKey(base);
    expect(
      runtimeQualKey({ ...base, tuple: { ...SUPPORTED_HOST_TUPLE, windowsUbr: "99999" } }),
    ).toBe(k);
    expect(runtimeQualKey({ ...base, tuple: { ...SUPPORTED_HOST_TUPLE, ramClassGb: 48 } })).toBe(k);
    expect(runtimeQualKey({ ...base, tuple: { ...SUPPORTED_HOST_TUPLE, vcpuClass: 12 } })).toBe(k);
  });
});

describe("sourceIdOf / deepScanIdentityOf", () => {
  it("maps git -> commitSha, npm -> package@version", () => {
    expect(sourceIdOf(GIT_SOURCE)).toBe(COMMIT);
    expect(sourceIdOf(NPM_SOURCE)).toBe("@obra/superpowers@1.2.3");
  });

  it("extracts {sourceId, treeDigest} from a resolved git source", () => {
    const resolved: ResolvedGitSource = {
      kind: "git",
      repository: "samartomar/ECC",
      commitSha: COMMIT,
      treeDigest: SHA_TREE,
      treePath: "/cache/x",
    };
    expect(deepScanIdentityOf(resolved)).toEqual({ sourceId: COMMIT, treeDigest: SHA_TREE });
  });

  it("extracts {sourceId, treeDigest} from an acquired npm source, and fails closed without a tree", () => {
    const acquired: ResolvedNpmSource = {
      kind: "npm",
      package: "@obra/superpowers",
      exactVersion: "1.2.3",
      integrity: INTEGRITY,
      treeDigest: SHA_TREE,
      treePath: "/cache/npm",
    };
    expect(deepScanIdentityOf(acquired)).toEqual({
      sourceId: "@obra/superpowers@1.2.3",
      treeDigest: SHA_TREE,
    });
    const identityOnly: ResolvedNpmSource = {
      kind: "npm",
      package: "@obra/superpowers",
      exactVersion: "1.2.3",
      integrity: INTEGRITY,
    };
    expect(() => deepScanIdentityOf(identityOnly)).toThrow(ScanCacheTierError);
  });
});

// ===========================================================================
// Deep-scan cache tier (§C.1)// ===========================================================================
// Deep-scan cache tier (§C.1) — hit/miss, version bump, corruption, no re-scan
// ===========================================================================

/** A call-counting runner: every deep dimension run spawns through it. */
function countingRunner(): { runner: Runner; calls: () => number } {
  let calls = 0;
  const runner: Runner = async (): Promise<RunResult> => {
    calls += 1;
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls: () => calls };
}

/**
 * Caller-supplied deep dimensions (Core ships none): one that runs a tool
 * through the runner and produces, one whose tool is unavailable (missing).
 */
const producedDeepInspector: DeepDimensionInspector = {
  dimension: "fixture-deep-produced",
  async run(ctx) {
    await ctx.runner(["fixture-deep-tool", ctx.treePath]);
    return { dimension: "fixture-deep-produced", status: "produced", findings: [] };
  },
};
const missingDeepInspector: DeepDimensionInspector = {
  dimension: "fixture-deep-missing",
  async run(ctx) {
    await ctx.runner(["fixture-docker-tool", "--version"]);
    return {
      dimension: "fixture-deep-missing",
      status: "missing",
      reason: "fixture docker tool is unavailable on this host",
      findings: [],
    };
  },
};

describe("runDeepScanTier — cache hit means NO re-scan", () => {
  const tierInput = (runner: Runner, extra: Record<string, unknown> = {}) => ({
    cacheHome,
    framework: "ecc" as const,
    sourceId: COMMIT,
    treeDigest: SHA_TREE,
    treePath: "/fake/tree",
    runner,
    inspectors: [producedDeepInspector, missingDeepInspector],
    ...extra,
  });

  it("runs the deep inspectors on a miss, then serves the second identical run from cache with zero runner calls", async () => {
    const { runner, calls } = countingRunner();

    const first = await runDeepScanTier(tierInput(runner));
    expect(first.cacheHit).toBe(false);
    const callsAfterFirst = calls();
    expect(callsAfterFirst).toBeGreaterThan(0);
    // one produced, one missing -> incomplete coverage present.
    expect(first.coverage.find((c) => c.dimension === "fixture-deep-produced")?.status).toBe(
      "produced",
    );
    expect(first.coverage.find((c) => c.dimension === "fixture-deep-missing")?.status).toBe(
      "missing",
    );

    const second = await runDeepScanTier(tierInput(runner));
    expect(second.cacheHit).toBe(true);
    expect(calls()).toBe(callsAfterFirst); // no scanner ran the second time
    expect(second.dimensionReports).toEqual(first.dimensionReports);
    expect(second.deepScanKey).toBe(first.deepScanKey);
  });

  it("MISSES (recomputes) when the scanner or policy version bumps", async () => {
    const { runner } = countingRunner();
    await runDeepScanTier(tierInput(runner));
    expect((await runDeepScanTier(tierInput(runner, { scannerVersion: 2 }))).cacheHit).toBe(false);
    expect((await runDeepScanTier(tierInput(runner, { policyVersion: 2 }))).cacheHit).toBe(false);
  });

  it("treats a corrupted record as a MISS (recompute), never a throw", async () => {
    const { runner } = countingRunner();
    await runDeepScanTier(tierInput(runner));
    const key = deepScanKey({ framework: "ecc", sourceId: COMMIT, treeDigest: SHA_TREE });
    const path = join(cacheHome, "deep-scan-cache", `${key}.json`);
    // The prior run wrote a valid record — prove it reads back as a hit, then
    // corrupt it in place (no existsSync check-then-write: the read IS the proof).
    expect(
      readDeepScanCache(cacheHome, { framework: "ecc", sourceId: COMMIT, treeDigest: SHA_TREE }),
    ).toBeDefined();
    writeFileSync(path, "{ this is not valid json", "utf8");
    expect(
      readDeepScanCache(cacheHome, { framework: "ecc", sourceId: COMMIT, treeDigest: SHA_TREE }),
    ).toBeUndefined();
    expect((await runDeepScanTier(tierInput(runner))).cacheHit).toBe(false);
  });

  it("re-checks identity on read: a record whose digest guard mismatches is a miss", async () => {
    const { runner } = countingRunner();
    await runDeepScanTier(tierInput(runner));
    // A different treeDigest computes a different key -> nothing at that path -> miss.
    expect(
      readDeepScanCache(cacheHome, {
        framework: "ecc",
        sourceId: COMMIT,
        treeDigest: "b".repeat(64),
      }),
    ).toBeUndefined();
  });
});

// ===========================================================================
// Runtime-qualification cache tier (§C.2) — off-tuple never satisfies
// ===========================================================================

describe("recordRuntimeQualification / readRuntimeQualification", () => {
  const qualBase = {
    cacheHome: "",
    framework: "ecc" as const,
    sourceId: COMMIT,
    treeDigest: SHA_TREE,
    selectedProfile: "ecc-lean",
    adapterVersion: 1,
  };
  const write = (tuple: HostTuple) =>
    recordRuntimeQualification({
      ...qualBase,
      cacheHome,
      tuple,
      result: "qualified",
      evidence: "deep scan produced; host in-tuple",
    });
  const read = (tuple: HostTuple) => readRuntimeQualification({ ...qualBase, cacheHome, tuple });

  it("round-trips a written record for the same key + tuple", () => {
    const written = write(SUPPORTED_HOST_TUPLE);
    expect(written.runtimeQualKey).toBe(
      runtimeQualKey({ ...qualBase, tuple: SUPPORTED_HOST_TUPLE }),
    );
    const back = read(SUPPORTED_HOST_TUPLE);
    expect(back).toEqual(written);
    expect(back?.result).toBe("qualified");
  });

  it("off-tuple NEVER satisfies — a Linux/off-tuple host computes a different key = miss", () => {
    write(SUPPORTED_HOST_TUPLE);
    const offTuple: HostTuple = { ...SUPPORTED_HOST_TUPLE, arch: "arm64", windowsBuild: "6.8.0" };
    expect(runtimeQualKey({ ...qualBase, tuple: offTuple })).not.toBe(
      runtimeQualKey({ ...qualBase, tuple: SUPPORTED_HOST_TUPLE }),
    );
    expect(read(offTuple)).toBeUndefined();
  });

  it("a NEWER Claude CLI with every hard fact equal is a different key = miss (D12; claudeCode is keyed)", () => {
    write(SUPPORTED_HOST_TUPLE);
    const newerCli: HostTuple = { ...SUPPORTED_HOST_TUPLE, claudeCode: { measuredOn: "2.1.400" } };
    expect(runtimeQualKey({ ...qualBase, tuple: newerCli })).not.toBe(
      runtimeQualKey({ ...qualBase, tuple: SUPPORTED_HOST_TUPLE }),
    );
    expect(read(newerCli)).toBeUndefined();
  });

  it("RAM above the qualified class (dynamic-memory balloon) still HITS — same key, drift not off-tuple", () => {
    write(SUPPORTED_HOST_TUPLE);
    expect(read({ ...SUPPORTED_HOST_TUPLE, ramClassGb: 48 })).not.toBeUndefined();
  });

  it("RAM below the qualified class (a rollback) MISSES via the read-time guard", () => {
    write(SUPPORTED_HOST_TUPLE);
    // Same key (RAM not keyed), but the classifyTuple guard rejects the downward move.
    expect(
      runtimeQualKey({ ...qualBase, tuple: { ...SUPPORTED_HOST_TUPLE, ramClassGb: 16 } }),
    ).toBe(runtimeQualKey({ ...qualBase, tuple: SUPPORTED_HOST_TUPLE }));
    expect(read({ ...SUPPORTED_HOST_TUPLE, ramClassGb: 16 })).toBeUndefined();
  });

  it("a vCPU rollback MISSES via the read-time guard (same key; vCPU not keyed)", () => {
    write(SUPPORTED_HOST_TUPLE);
    expect(read({ ...SUPPORTED_HOST_TUPLE, vcpuClass: 12 })).toBeUndefined();
  });

  it("a UBR-only change (provenance) still HITS — same key AND in-tuple", () => {
    write(SUPPORTED_HOST_TUPLE);
    expect(read({ ...SUPPORTED_HOST_TUPLE, windowsUbr: "99999" })).not.toBeUndefined();
  });

  it("a different selectedProfile or adapterVersion is a miss (both are keyed)", () => {
    write(SUPPORTED_HOST_TUPLE);
    expect(
      readRuntimeQualification({
        ...qualBase,
        cacheHome,
        selectedProfile: "ecc-full",
        tuple: SUPPORTED_HOST_TUPLE,
      }),
    ).toBeUndefined();
    expect(
      readRuntimeQualification({
        ...qualBase,
        cacheHome,
        adapterVersion: 2,
        tuple: SUPPORTED_HOST_TUPLE,
      }),
    ).toBeUndefined();
  });

  it("treats a corrupted runtime-qual record as a MISS, never a throw", () => {
    const written = write(SUPPORTED_HOST_TUPLE);
    const path = join(cacheHome, "runtime-qual-cache", `${written.runtimeQualKey}.json`);
    writeFileSync(path, "}}corrupt", "utf8");
    expect(read(SUPPORTED_HOST_TUPLE)).toBeUndefined();
  });
});

// ===========================================================================
// The ONE scan-gate seam (§C.4) — fold, incomplete coverage, byte-identical
// ===========================================================================

describe("runFastScanGate deep-dimension fold (§C.4)", () => {
  let treePath: string;
  const source = (): ScannableSource => ({
    digest: SHA_TREE,
    treePath,
    identityFiles: ["SKILL.md"],
  });
  const cleanDeep: DimensionReport = {
    dimension: "cisco-skill-scanner",
    status: "produced",
    findings: [],
  };
  const missingDeep: DimensionReport = {
    dimension: "skillspector",
    status: "missing",
    reason: "docker is unavailable on this host",
    findings: [],
  };
  const deps = () => ({ cacheHome, scanExecution: fakeBindingGateScan() });

  beforeEach(() => {
    treePath = mkdtempSync(join(tmpdir(), "aih-tier-tree-"));
    writeFileSync(join(treePath, "SKILL.md"), "# bland deterministic skill\n", "utf8");
  });
  afterEach(() => {
    rmSync(treePath, { recursive: true, force: true });
  });

  it("is byte-identical to the pre-Phase-2 gate when the option is absent (or clean-produced deep dims)", async () => {
    const bare = await runFastScanGate(source(), { posture: "enterprise" }, deps());
    // Same cacheHome -> the second call is a warm read -> identical producedAt.
    const withCleanDeep = await runFastScanGate(
      source(),
      { posture: "enterprise", deepDimensionReports: [cleanDeep] },
      deps(),
    );
    expect(withCleanDeep).toEqual(bare);
  });

  it("folds a MISSING deep dimension through the same coverage path: BLOCK at enterprise", async () => {
    const disposition = await runFastScanGate(
      source(),
      { posture: "enterprise", deepDimensionReports: [missingDeep] },
      deps(),
    );
    expect(disposition.verdict).toBe("block");
    expect(disposition.selectedProfileGate).toBe("BLOCK");
  });

  it("a MISSING deep dimension ALLOWS at vibe with allowIncompleteAtVibe (existing posture path)", async () => {
    const disposition = await runFastScanGate(
      source(),
      { posture: "vibe", allowIncompleteAtVibe: true, deepDimensionReports: [missingDeep] },
      deps(),
    );
    expect(disposition.verdict).toBe("allow");
  });

  it("a PRODUCED deep dimension carrying a finding surfaces it in the disposition", async () => {
    const producedFinding: DimensionReport = {
      dimension: "cisco-skill-scanner",
      status: "produced",
      findings: [
        {
          code: "trust.cisco-finding",
          severity: "high",
          detail: "skills/foo/SKILL.md:16 — Pattern detected: ignore previous rules",
          coverage: "complete",
        },
      ],
    };
    const disposition = await runFastScanGate(
      source(),
      { posture: "enterprise", deepDimensionReports: [producedFinding] },
      deps(),
    );
    expect(disposition.findings.some((f) => f.code === "trust.cisco-finding")).toBe(true);
    // A high raw finding drives BLOCK in the legacy (no-closure) gate.
    expect(disposition.verdict).toBe("block");
  });
});

// ===========================================================================
// End-to-end: runDeepScanTier output folds through runFastScanGate
// ===========================================================================

describe("end-to-end: deep tier output folds through the gate", () => {
  it("a missing deep dimension from runDeepScanTier drives incomplete coverage at the gate", async () => {
    const treePath = mkdtempSync(join(tmpdir(), "aih-tier-e2e-"));
    writeFileSync(join(treePath, "SKILL.md"), "# bland\n", "utf8");
    try {
      const { runner } = countingRunner();
      const tier = await runDeepScanTier({
        cacheHome,
        framework: "ecc",
        sourceId: COMMIT,
        treeDigest: SHA_TREE,
        treePath,
        runner,
        inspectors: [producedDeepInspector, missingDeepInspector],
      });
      const disposition = await runFastScanGate(
        { digest: SHA_TREE, treePath, identityFiles: ["SKILL.md"] },
        { posture: "enterprise", deepDimensionReports: tier.dimensionReports },
        { cacheHome, scanExecution: fakeBindingGateScan() },
      );
      // A missing deep dimension -> incomplete coverage -> BLOCK at enterprise.
      expect(disposition.verdict).toBe("block");
    } finally {
      rmSync(treePath, { recursive: true, force: true });
    }
  });
});
