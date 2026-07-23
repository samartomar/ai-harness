import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HostTuple, SUPPORTED_HOST_TUPLE } from "../../src/binding/host-tuple.js";
import {
  ciscoSkillScannerInspector,
  deepScanIdentityOf,
  deepScanKey,
  readDeepScanCache,
  readRuntimeQualification,
  recordRuntimeQualification,
  runDeepScanTier,
  runtimeQualKey,
  ScanCacheTierError,
  skillspectorInspector,
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
import { fakeRunner, type Runner, type RunResult } from "../../src/internals/proc.js";

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

/** A well-formed Cisco skill-scanner SARIF payload (two findings, distinct levels). */
const CISCO_SARIF = JSON.stringify({
  version: "2.1.0",
  runs: [
    {
      tool: { driver: { name: "cisco-ai-skill-scanner" } },
      results: [
        {
          ruleId: "skill-metadata-license",
          level: "warning",
          message: { text: "Skill manifest does not include a 'license' field." },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "skills/foo/SKILL.md" },
                region: { startLine: 1 },
              },
            },
          ],
        },
        {
          ruleId: "prompt-injection",
          level: "error",
          message: { text: "Pattern detected: ignore previous rules" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "skills/foo/SKILL.md" },
                region: { startLine: 16 },
              },
            },
          ],
        },
      ],
    },
  ],
});

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
// Deep-scanner dimensions (§C.3, O6) — fake runner, NO real uvx/docker/network
// ===========================================================================

describe("ciscoSkillScannerInspector (uvx, produced)", () => {
  const ctx = (runner: Runner) => ({ treePath: "/fake/tree", runner });

  it("maps a captured SARIF payload to deterministic trust.cisco-finding findings", async () => {
    const runner = fakeRunner((argv) => {
      if (argv[0] === "uvx" && argv[1] === "--version") return { code: 0, stdout: "uvx 0.5.1" };
      if (argv[0] === "uvx" && argv.includes("skill-scanner"))
        return { code: 0, stdout: CISCO_SARIF };
      return undefined;
    });
    const report = await ciscoSkillScannerInspector.run(ctx(runner));
    expect(report.status).toBe("produced");
    expect(report.findings.every((f) => f.code === "trust.cisco-finding")).toBe(true);
    // Sorted by detail: the :1 license finding precedes the :16 injection finding.
    expect(report.findings.map((f) => f.detail)).toEqual([
      "skills/foo/SKILL.md:1 — Skill manifest does not include a 'license' field.",
      "skills/foo/SKILL.md:16 — Pattern detected: ignore previous rules",
    ]);
    expect(report.findings.map((f) => f.severity)).toEqual(["medium", "high"]);
    expect(report.findings.map((f) => f.path)).toEqual([
      "skills/foo/SKILL.md",
      "skills/foo/SKILL.md",
    ]);

    // Deterministic: a second identical run yields byte-identical findings.
    const again = await ciscoSkillScannerInspector.run(ctx(runner));
    expect(again).toEqual(report);
  });

  it("passes the pinned spec + offline SARIF argv through the runner", async () => {
    const seen: string[][] = [];
    const runner: Runner = async (argv) => {
      seen.push(argv);
      if (argv[1] === "--version") return { code: 0, stdout: "uvx 0.5.1", stderr: "" };
      return { code: 0, stdout: CISCO_SARIF, stderr: "" };
    };
    await ciscoSkillScannerInspector.run(ctx(runner));
    expect(seen[0]).toEqual(["uvx", "--version"]);
    expect(seen[1]).toEqual([
      "uvx",
      "--from",
      "cisco-ai-skill-scanner==2.0.12",
      "skill-scanner",
      "--offline",
      "--format",
      "sarif",
      "/fake/tree",
    ]);
  });

  it("reports MISSING (never a fabricated pass) on tool-absent / spawn / non-zero / unparseable", async () => {
    const unavailable = fakeRunner((argv) =>
      argv[1] === "--version" ? { code: 127, spawnError: true } : undefined,
    );
    expect((await ciscoSkillScannerInspector.run(ctx(unavailable))).status).toBe("missing");

    const scanSpawnFail = fakeRunner((argv) => {
      if (argv[1] === "--version") return { code: 0, stdout: "uvx 0.5.1" };
      return { code: 1, spawnError: true };
    });
    expect((await ciscoSkillScannerInspector.run(ctx(scanSpawnFail))).status).toBe("missing");

    const nonZero = fakeRunner((argv) => {
      if (argv[1] === "--version") return { code: 0, stdout: "uvx 0.5.1" };
      return { code: 2, stderr: "boom" };
    });
    expect((await ciscoSkillScannerInspector.run(ctx(nonZero))).status).toBe("missing");

    const unparseable = fakeRunner((argv) => {
      if (argv[1] === "--version") return { code: 0, stdout: "uvx 0.5.1" };
      return { code: 0, stdout: "not sarif at all" };
    });
    const report = await ciscoSkillScannerInspector.run(ctx(unparseable));
    expect(report.status).toBe("missing");
    expect(report.findings).toEqual([]);
    expect(report.reason).toContain("parseable");
  });

  it("PRODUCES a clean report (zero findings) for a valid empty SARIF envelope", async () => {
    const clean = fakeRunner((argv) => {
      if (argv[1] === "--version") return { code: 0, stdout: "uvx 0.5.1" };
      return { code: 0, stdout: JSON.stringify({ version: "2.1.0", runs: [{ results: [] }] }) };
    });
    const report = await ciscoSkillScannerInspector.run(ctx(clean));
    expect(report.status).toBe("produced");
    expect(report.findings).toEqual([]);
  });
});

describe("skillspectorInspector (docker)", () => {
  it("reports MISSING when docker is unavailable on this VM (incomplete coverage, not a false green)", async () => {
    const noDocker = fakeRunner((argv) =>
      argv[0] === "docker" && argv[1] === "--version" ? { code: 127, spawnError: true } : undefined,
    );
    const report = await skillspectorInspector.run({ treePath: "/fake/tree", runner: noDocker });
    expect(report.status).toBe("missing");
    expect(report.reason).toContain("docker");
    expect(report.findings).toEqual([]);
  });

  it("PRODUCES trust.detector-finding where docker exists and emits SARIF", async () => {
    const withDocker = fakeRunner((argv) => {
      if (argv[0] === "docker" && argv[1] === "--version") return { code: 0, stdout: "Docker 27" };
      if (argv[0] === "docker" && argv[1] === "run") return { code: 0, stdout: CISCO_SARIF };
      return undefined;
    });
    const report = await skillspectorInspector.run({ treePath: "/fake/tree", runner: withDocker });
    expect(report.status).toBe("produced");
    expect(report.findings.every((f) => f.code === "trust.detector-finding")).toBe(true);
    expect(report.findings.length).toBe(2);
  });
});

// ===========================================================================
// Deep-scan cache tier (§C.1) — hit/miss, version bump, corruption, no re-scan
// ===========================================================================

/** A call-counting runner wrapping the cisco/skillspector fake handler. */
function countingRunner(): { runner: Runner; calls: () => number } {
  let calls = 0;
  const handler = fakeRunner((argv) => {
    if (argv[1] === "--version") return { code: 0, stdout: "tool 1.0" };
    if (argv.includes("skill-scanner")) return { code: 0, stdout: CISCO_SARIF };
    if (argv[0] === "docker") return { code: 127, spawnError: true };
    return undefined;
  });
  const runner: Runner = async (argv, opts) => {
    calls += 1;
    return handler(argv, opts);
  };
  return { runner, calls: () => calls };
}

describe("runDeepScanTier — cache hit means NO re-scan", () => {
  const tierInput = (runner: Runner, extra: Record<string, unknown> = {}) => ({
    cacheHome,
    framework: "ecc" as const,
    sourceId: COMMIT,
    treeDigest: SHA_TREE,
    treePath: "/fake/tree",
    runner,
    inspectors: [ciscoSkillScannerInspector, skillspectorInspector],
    ...extra,
  });

  it("runs the deep inspectors on a miss, then serves the second identical run from cache with zero runner calls", async () => {
    const { runner, calls } = countingRunner();

    const first = await runDeepScanTier(tierInput(runner));
    expect(first.cacheHit).toBe(false);
    const callsAfterFirst = calls();
    expect(callsAfterFirst).toBeGreaterThan(0);
    // cisco produced, skillspector missing (no docker) -> incomplete coverage present.
    expect(first.coverage.find((c) => c.dimension === "cisco-skill-scanner")?.status).toBe(
      "produced",
    );
    expect(first.coverage.find((c) => c.dimension === "skillspector")?.status).toBe("missing");

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
    expect(existsSync(path)).toBe(true);
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

  beforeEach(() => {
    treePath = mkdtempSync(join(tmpdir(), "aih-tier-tree-"));
    writeFileSync(join(treePath, "SKILL.md"), "# bland deterministic skill\n", "utf8");
  });
  afterEach(() => {
    rmSync(treePath, { recursive: true, force: true });
  });

  it("is byte-identical to the pre-Phase-2 gate when the option is absent (or clean-produced deep dims)", () => {
    const bare = runFastScanGate(source(), { posture: "enterprise" }, { cacheHome });
    // Same cacheHome -> the second call is a warm read -> identical producedAt.
    const withCleanDeep = runFastScanGate(
      source(),
      { posture: "enterprise", deepDimensionReports: [cleanDeep] },
      { cacheHome },
    );
    expect(withCleanDeep).toEqual(bare);
  });

  it("folds a MISSING deep dimension through the same coverage path: BLOCK at enterprise", () => {
    const disposition = runFastScanGate(
      source(),
      { posture: "enterprise", deepDimensionReports: [missingDeep] },
      { cacheHome },
    );
    expect(disposition.verdict).toBe("block");
    expect(disposition.selectedProfileGate).toBe("BLOCK");
  });

  it("a MISSING deep dimension ALLOWS at vibe with allowIncompleteAtVibe (existing posture path)", () => {
    const disposition = runFastScanGate(
      source(),
      { posture: "vibe", allowIncompleteAtVibe: true, deepDimensionReports: [missingDeep] },
      { cacheHome },
    );
    expect(disposition.verdict).toBe("allow");
  });

  it("a PRODUCED deep dimension carrying a finding surfaces it in the disposition", () => {
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
    const disposition = runFastScanGate(
      source(),
      { posture: "enterprise", deepDimensionReports: [producedFinding] },
      { cacheHome },
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
  it("a missing docker dimension from runDeepScanTier drives incomplete coverage at the gate", async () => {
    const treePath = mkdtempSync(join(tmpdir(), "aih-tier-e2e-"));
    writeFileSync(join(treePath, "SKILL.md"), "# bland\n", "utf8");
    try {
      const noDocker: Runner = async (argv): Promise<RunResult> => {
        if (argv[1] === "--version" && argv[0] === "uvx")
          return { code: 0, stdout: "uvx 1", stderr: "" };
        if (argv.includes("skill-scanner")) return { code: 0, stdout: CISCO_SARIF, stderr: "" };
        return { code: 127, stdout: "", stderr: "not found", spawnError: true }; // docker absent
      };
      const tier = await runDeepScanTier({
        cacheHome,
        framework: "ecc",
        sourceId: COMMIT,
        treeDigest: SHA_TREE,
        treePath,
        runner: noDocker,
      });
      const disposition = runFastScanGate(
        { digest: SHA_TREE, treePath, identityFiles: ["SKILL.md"] },
        { posture: "enterprise", deepDimensionReports: tier.dimensionReports },
        { cacheHome },
      );
      // skillspector missing -> incomplete coverage -> BLOCK at enterprise.
      expect(disposition.verdict).toBe("block");
    } finally {
      rmSync(treePath, { recursive: true, force: true });
    }
  });
});
