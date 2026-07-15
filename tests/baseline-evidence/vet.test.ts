import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import { defaultComponentScanner, vetBaselineCatalog } from "../../src/baseline-evidence/vet.js";
import type { Check } from "../../src/internals/verify.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-baseline-vet-"));
  mkdirSync(join(root, "skills", "clean"), { recursive: true });
  mkdirSync(join(root, "skills", "blocked"), { recursive: true });
  writeFileSync(join(root, "skills", "clean", "SKILL.md"), "# Clean\n");
  writeFileSync(join(root, "skills", "blocked", "SKILL.md"), "# Blocked\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function catalog() {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: "d".repeat(40),
    components: [
      { id: "skill:clean", paths: ["skills/clean"] },
      { id: "skill:blocked", paths: ["skills/blocked"] },
    ],
  });
}

function pass(name: string): Check {
  return { name, verdict: "pass", detail: `${name} passed` };
}

describe("vetBaselineCatalog", () => {
  it("binds each scanner verdict to the component's exact deterministic tree hash", async () => {
    const scanComponent = vi.fn(async ({ component }: { component: { id: string } }) => ({
      analyzersRun: ["aih-native"],
      checks: [pass(component.id)],
    }));

    const evidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions: { "aih-native": "2.7.0" },
    });

    expect(scanComponent).toHaveBeenCalledTimes(2);
    expect(evidence).toMatchObject({
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: "d".repeat(40),
      components: [
        { id: "skill:clean", verdict: "pass", findings: [] },
        { id: "skill:blocked", verdict: "pass", findings: [] },
      ],
    });
    expect(evidence.components[0]?.treeSha256).toBe(
      hashComponentTree(root, ["skills/clean"]).treeSha256,
    );
    expect(evidence.components[0]?.analyzers).toEqual([{ name: "aih-native", version: "2.7.0" }]);
  });

  it("preserves failing danger checks as a blocked verdict instead of acknowledging them", async () => {
    const danger: Check = {
      name: "trust.hidden-unicode",
      verdict: "fail",
      code: "trust.hidden-unicode",
      detail: "instruction surface contains non-ASCII typography",
      fingerprint: "trust-hidden-unicode:SKILL.md:1:abc123",
    };
    const evidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent: async ({ component }) => ({
        analyzersRun: ["aih-native"],
        checks: component.id === "skill:blocked" ? [danger] : [pass(component.id)],
      }),
      requiredAnalyzers: ["aih-native"],
      analyzerVersions: { "aih-native": "2.7.0" },
    });

    expect(evidence.components[1]).toMatchObject({
      id: "skill:blocked",
      verdict: "blocked",
      findings: [
        {
          code: "trust.hidden-unicode",
          detail: danger.detail,
          fingerprint: danger.fingerprint,
        },
      ],
    });
  });

  it("treats a required unavailable detector failure as blocked evidence", async () => {
    const unavailable: Check = {
      name: "trust detector skillspector",
      verdict: "fail",
      code: "trust.detector-unavailable",
      detail: "required detector skillspector unavailable",
    };
    const evidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent: async () => ({ analyzersRun: ["aih-native"], checks: [unavailable] }),
      requiredAnalyzers: ["aih-native"],
      analyzerVersions: { "aih-native": "2.7.0" },
    });
    expect(evidence.components.every((component) => component.verdict === "blocked")).toBe(true);
  });

  it("summarizes repeated findings by code for a bounded shipped lock", async () => {
    const repeated: Check[] = [
      {
        name: "unicode one",
        verdict: "fail",
        code: "trust.hidden-unicode",
        detail: "first hidden Unicode finding",
      },
      {
        name: "unicode two",
        verdict: "fail",
        code: "trust.hidden-unicode",
        detail: "second hidden Unicode finding",
      },
    ];
    const evidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent: async () => ({ analyzersRun: ["aih-native"], checks: repeated }),
      requiredAnalyzers: ["aih-native"],
      analyzerVersions: { "aih-native": "2.7.0" },
    });
    expect(evidence.components[0]?.findings).toEqual([
      {
        code: "trust.hidden-unicode",
        count: 2,
        detail: "2 findings; first: first hidden Unicode finding",
      },
    ]);
  });

  it("fails closed when an analyzer ran without an attributable version receipt", async () => {
    await expect(
      vetBaselineCatalog(root, catalog(), {
        scanComponent: async () => ({
          analyzersRun: ["aih-native", "skillspector@docker"],
          checks: [pass("scan")],
        }),
        requiredAnalyzers: ["aih-native"],
        analyzerVersions: { "aih-native": "2.7.0" },
      }),
    ).rejects.toThrow(/skillspector.*version/i);
  });

  it("fails closed when a component is missing any required baseline analyzer", async () => {
    await expect(
      vetBaselineCatalog(root, catalog(), {
        scanComponent: async () => ({
          analyzersRun: ["aih-native"],
          checks: [pass("scan")],
        }),
        requiredAnalyzers: ["aih-native", "skillspector@docker", "cisco@uvx"],
        analyzerVersions: {
          "aih-native": "2.7.0",
          "skillspector@docker": "326a2b489411@sha256:e82fd471e156",
          "cisco@uvx": "2.0.12",
        },
      }),
    ).rejects.toThrow(/missing required baseline analyzers: skillspector@docker, cisco@uvx/i);
  });

  it("surfaces the underlying detector reason when a required analyzer is missing", async () => {
    const unavailable: Check = {
      name: "trust detector cisco",
      verdict: "fail",
      code: "trust.detector-unavailable",
      detail:
        "required detector cisco is unavailable at enterprise posture. cisco not available (uvx --offline: cisco-ai-skill-scanner was not found in the cache)",
    };
    await expect(
      vetBaselineCatalog(root, catalog(), {
        scanComponent: async () => ({
          analyzersRun: ["aih-native", "skillspector@docker"],
          checks: [unavailable],
        }),
        requiredAnalyzers: ["aih-native", "skillspector@docker", "cisco@uvx"],
        analyzerVersions: {
          "aih-native": "2.7.0",
          "skillspector@docker": "326a2b489411@sha256:e82fd471e156",
          "cisco@uvx": "2.0.12",
        },
      }),
    ).rejects.toThrow(
      /missing required baseline analyzers: cisco@uvx; detector diagnostics:.*not found in the cache/is,
    );
  });

  it("records every required baseline analyzer with an attributable exact version", async () => {
    const evidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent: async () => ({
        analyzersRun: ["aih-native", "skillspector@docker", "cisco@uvx"],
        checks: [pass("scan")],
      }),
      requiredAnalyzers: ["aih-native", "skillspector@docker", "cisco@uvx"],
      analyzerVersions: {
        "aih-native": "2.7.0",
        "skillspector@docker": "326a2b489411@sha256:e82fd471e156",
        "cisco@uvx": "2.0.12",
      },
    });

    expect(evidence.components[0]?.analyzers).toEqual([
      { name: "aih-native", version: "2.7.0" },
      { name: "cisco@uvx", version: "2.0.12" },
      { name: "skillspector@docker", version: "326a2b489411@sha256:e82fd471e156" },
    ]);
  });

  it("throws at entry when requiredAnalyzers is omitted instead of vetting receipt-unenforced", async () => {
    await expect(
      vetBaselineCatalog(root, catalog(), {
        scanComponent: async () => ({ analyzersRun: ["aih-native"], checks: [pass("scan")] }),
        analyzerVersions: { "aih-native": "2.7.0" },
      }),
    ).rejects.toThrow(/requires an explicit requiredAnalyzers floor/i);
  });

  it("fails closed when component bytes change during analyzer execution", async () => {
    await expect(
      vetBaselineCatalog(root, catalog(), {
        scanComponent: async ({ component }) => {
          if (component.id === "skill:clean") {
            writeFileSync(join(root, "skills", "clean", "SKILL.md"), "# Swapped during scan\n");
          }
          return { analyzersRun: ["aih-native"], checks: [pass(component.id)] };
        },
        requiredAnalyzers: ["aih-native"],
        analyzerVersions: { "aih-native": "2.7.0" },
      }),
    ).rejects.toThrow(/changed during.*vet/i);
  });

  it("scans one path-preserving isolated projection per component and removes it", async () => {
    writeFileSync(join(root, "outside.txt"), "must not enter a component scan\n");
    const projections: string[] = [];
    const scanTree = vi.fn(async (projectionRoot: string) => {
      projections.push(projectionRoot);
      expect(projectionRoot).toContain(join(dirname(root), ".aih-baseline-component-"));
      expect(existsSync(join(projectionRoot, "outside.txt"))).toBe(false);
      expect(
        existsSync(join(projectionRoot, "skills", "clean", "SKILL.md")) ||
          existsSync(join(projectionRoot, "skills", "blocked", "SKILL.md")),
      ).toBe(true);
      return { analyzersRun: ["aih-native"], checks: [pass("projected scan")] };
    });

    await vetBaselineCatalog(root, catalog(), {
      scanTree,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions: { "aih-native": "2.7.0" },
    });

    expect(scanTree).toHaveBeenCalledTimes(2);
    expect(projections.every((projection) => !existsSync(projection))).toBe(true);
  });

  it("reports bounded detector timing only as baseline-vet diagnostics", async () => {
    const progress = vi.fn();
    const now = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(15)
      .mockReturnValueOnce(40)
      .mockReturnValueOnce(50);
    const scanTree = async (
      _projectionRoot: string,
      options?: Parameters<typeof defaultComponentScanner>[0],
    ) => {
      if (options === undefined) throw new Error("expected scan options");
      options.progress?.("trust scan: detector skillspector started");
      options.progress?.("trust scan: detector skillspector complete");
      options.progress?.("trust scan: detector cisco started");
      return {
        analyzersRun: ["aih-native", "skillspector@docker"],
        checks: [
          { name: "trust detector skillspector", verdict: "pass" as const },
          {
            name: "trust detector cisco",
            verdict: "fail" as const,
            code: "trust.detector-unavailable" as const,
          },
        ],
      };
    };
    const scanComponent = defaultComponentScanner({ progress }, scanTree);
    const [firstComponent] = catalog().components;
    if (firstComponent === undefined) throw new Error("expected fixture catalog component");

    await scanComponent({ sourceRoot: root, component: firstComponent });

    const lines = progress.mock.calls.map(([message]) => message as string);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^baseline vet: component skill:clean, detector skillspector complete in 5ms$/,
        ),
        expect.stringMatching(
          /^baseline vet: component skill:clean, detector cisco failed in \d+ms$/,
        ),
      ]),
    );
    now.mockRestore();
  });

  it("prunes vendor-authored symlinks from the component projection instead of following them off-host", async (ctx) => {
    // hashComponentTree already hard-refuses any symlink under a component's
    // declared paths, so a symlinked entry can never reach vetBaselineCatalog's
    // scan step through the public entry point. Exercise defaultComponentScanner
    // (via the exported scanComponent it builds) directly so the cpSync
    // projection's own symlink defense is verified independently of that
    // earlier guard.
    const outside = mkdtempSync(join(tmpdir(), "aih-baseline-outside-"));
    try {
      writeFileSync(join(outside, "SECRET.md"), "must never enter a component projection\n");
      try {
        symlinkSync(join(outside, "SECRET.md"), join(root, "skills", "clean", "LEAK.md"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") ctx.skip();
        throw err;
      }

      const [component] = catalog().components;
      if (component === undefined) throw new Error("fixture catalog is missing a component");

      const scanTree = vi.fn(async (projectionRoot: string) => {
        expect(existsSync(join(projectionRoot, "skills", "clean", "SKILL.md"))).toBe(true);
        expect(() => lstatSync(join(projectionRoot, "skills", "clean", "LEAK.md"))).toThrow();
        return { analyzersRun: ["aih-native"], checks: [pass("projected scan")] };
      });
      const scanComponent = defaultComponentScanner({}, scanTree);

      const scan = await scanComponent({ sourceRoot: root, component });

      expect(scanTree).toHaveBeenCalledTimes(1);
      expect(scan.analyzersRun).toEqual(["aih-native"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("vetBaselineCatalog incremental reuse (issue #444)", () => {
  const analyzerVersions = { "aih-native": "native.aaaaaaaaaaaa" };

  function scannerFor(
    resultByComponent: Record<string, { analyzersRun: string[]; checks: Check[] }>,
  ) {
    return vi.fn(async ({ component }: { component: { id: string } }) => {
      const result = resultByComponent[component.id];
      if (!result) throw new Error(`unexpected scan of ${component.id}`);
      return result;
    });
  }

  it("reuses every component byte-identically when the tree and analyzer identities are unchanged (bullet 1)", async () => {
    const scanComponent = scannerFor({
      "skill:clean": { analyzersRun: ["aih-native"], checks: [pass("skill:clean")] },
      "skill:blocked": {
        analyzersRun: ["aih-native"],
        checks: [
          {
            name: "trust.hidden-unicode",
            verdict: "fail",
            code: "trust.hidden-unicode",
            detail: "blocked",
          },
        ],
      },
    });
    const priorEvidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
    });
    expect(scanComponent).toHaveBeenCalledTimes(2);

    const mustNotScan = vi.fn(async () => {
      throw new Error("must not rescan when fully reusing");
    });
    const reusedEvidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent: mustNotScan,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
      reuseFrom: { schemaVersion: 1, sources: [priorEvidence] },
    });

    expect(mustNotScan).not.toHaveBeenCalled();
    expect(JSON.stringify(reusedEvidence)).toBe(JSON.stringify(priorEvidence));
  });

  it("rescans exactly the one component whose content changed, reusing the rest (bullet 2)", async () => {
    const scanComponent = scannerFor({
      "skill:clean": { analyzersRun: ["aih-native"], checks: [pass("skill:clean")] },
      "skill:blocked": { analyzersRun: ["aih-native"], checks: [pass("skill:blocked")] },
    });
    const priorEvidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
    });

    writeFileSync(join(root, "skills", "clean", "SKILL.md"), "# Clean, but edited\n");
    const rescanOnly = vi.fn(async ({ component }: { component: { id: string } }) => {
      if (component.id !== "skill:clean") throw new Error(`unexpected rescan of ${component.id}`);
      return { analyzersRun: ["aih-native"], checks: [pass("skill:clean")] };
    });
    const evidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent: rescanOnly,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
      reuseFrom: { schemaVersion: 1, sources: [priorEvidence] },
    });

    expect(rescanOnly).toHaveBeenCalledTimes(1);
    expect(evidence.components.find((c) => c.id === "skill:blocked")).toEqual(
      priorEvidence.components.find((c) => c.id === "skill:blocked"),
    );
    expect(evidence.components.find((c) => c.id === "skill:clean")?.treeSha256).not.toBe(
      priorEvidence.components.find((c) => c.id === "skill:clean")?.treeSha256,
    );
  });

  it("reuses unchanged components across a pin rebind, since reuse keys on content not pin (bullet 2, Decision 4)", async () => {
    const scanComponent = scannerFor({
      "skill:clean": { analyzersRun: ["aih-native"], checks: [pass("skill:clean")] },
      "skill:blocked": { analyzersRun: ["aih-native"], checks: [pass("skill:blocked")] },
    });
    const priorEvidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
    });

    const rebound = defineBaselineCatalog({ ...catalog(), pinnedSha: "e".repeat(40) });
    const mustNotScan = vi.fn(async () => {
      throw new Error("must not rescan across a pure pin rebind with unchanged content");
    });
    const evidence = await vetBaselineCatalog(root, rebound, {
      scanComponent: mustNotScan,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
      reuseFrom: { schemaVersion: 1, sources: [priorEvidence] },
    });

    expect(mustNotScan).not.toHaveBeenCalled();
    expect(evidence.pinnedSha).toBe("e".repeat(40));
    expect(evidence.components).toEqual(priorEvidence.components);
  });

  it("rescans every component when a universally-required analyzer identity changes (bullet 3)", async () => {
    const versionsR1 = {
      "aih-native": "native.aaaaaaaaaaaa",
      "skillspector@docker": "rev@sha256:r1",
    };
    const scanComponent = scannerFor({
      "skill:clean": {
        analyzersRun: ["aih-native", "skillspector@docker"],
        checks: [pass("skill:clean")],
      },
      "skill:blocked": {
        analyzersRun: ["aih-native", "skillspector@docker"],
        checks: [pass("skill:blocked")],
      },
    });
    const priorEvidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent,
      requiredAnalyzers: ["aih-native", "skillspector@docker"],
      analyzerVersions: versionsR1,
    });

    const versionsR2 = { ...versionsR1, "skillspector@docker": "rev@sha256:r2" };
    const rescanBoth = vi.fn(async ({ component }: { component: { id: string } }) => ({
      analyzersRun: ["aih-native", "skillspector@docker"],
      checks: [pass(component.id)],
    }));
    const evidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent: rescanBoth,
      requiredAnalyzers: ["aih-native", "skillspector@docker"],
      analyzerVersions: versionsR2,
      reuseFrom: { schemaVersion: 1, sources: [priorEvidence] },
    });

    expect(rescanBoth).toHaveBeenCalledTimes(2);
    expect(
      evidence.components.every((c) => c.analyzers.every((a) => a.version !== "rev@sha256:r1")),
    ).toBe(true);
  });

  it("rescans only the components that require the changed analyzer, reusing the rest (bullet 3, cisco-only subset)", async () => {
    const mixedCatalog = defineBaselineCatalog({
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: "d".repeat(40),
      components: [
        { id: "skill:clean", paths: ["skills/clean"] },
        { id: "skill:blocked", paths: ["skills/blocked"], skillContent: true },
      ],
    });
    const requiredAnalyzers = (component: { id: string }) =>
      component.id === "skill:blocked" ? ["aih-native", "cisco@uvx"] : ["aih-native"];
    const versionsR1 = { "aih-native": "native.aaaaaaaaaaaa", "cisco@uvx": "2.0.12" };
    const scanComponent = scannerFor({
      "skill:clean": { analyzersRun: ["aih-native"], checks: [pass("skill:clean")] },
      "skill:blocked": {
        analyzersRun: ["aih-native", "cisco@uvx"],
        checks: [pass("skill:blocked")],
      },
    });
    const priorEvidence = await vetBaselineCatalog(root, mixedCatalog, {
      scanComponent,
      requiredAnalyzers,
      analyzerVersions: versionsR1,
    });

    const versionsR2 = { ...versionsR1, "cisco@uvx": "2.0.13" };
    const rescanCiscoOnly = vi.fn(async ({ component }: { component: { id: string } }) => {
      if (component.id !== "skill:blocked") throw new Error(`unexpected rescan of ${component.id}`);
      return { analyzersRun: ["aih-native", "cisco@uvx"], checks: [pass("skill:blocked")] };
    });
    const evidence = await vetBaselineCatalog(root, mixedCatalog, {
      scanComponent: rescanCiscoOnly,
      requiredAnalyzers,
      analyzerVersions: versionsR2,
      reuseFrom: { schemaVersion: 1, sources: [priorEvidence] },
    });

    expect(rescanCiscoOnly).toHaveBeenCalledTimes(1);
    expect(evidence.components.find((c) => c.id === "skill:clean")).toEqual(
      priorEvidence.components.find((c) => c.id === "skill:clean"),
    );
  });

  it("invalidates every component's reuse when only the aih-native identity changes, even with the package VERSION unchanged (bullet 4)", async () => {
    const scanComponent = scannerFor({
      "skill:clean": { analyzersRun: ["aih-native"], checks: [pass("skill:clean")] },
      "skill:blocked": { analyzersRun: ["aih-native"], checks: [pass("skill:blocked")] },
    });
    const priorEvidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions: { "aih-native": "native.old000000000a" },
    });

    const rescanAll = vi.fn(async ({ component }: { component: { id: string } }) => ({
      analyzersRun: ["aih-native"],
      checks: [pass(component.id)],
    }));
    const evidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent: rescanAll,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions: { "aih-native": "native.new000000000b" },
      reuseFrom: { schemaVersion: 1, sources: [priorEvidence] },
    });

    expect(rescanAll).toHaveBeenCalledTimes(2);
    expect(
      evidence.components.every((c) =>
        c.analyzers.every((a) => a.version === "native.new000000000b"),
      ),
    ).toBe(true);
    expect(
      evidence.components.every((c) =>
        c.analyzers.every((a) => a.version !== "native.old000000000a"),
      ),
    ).toBe(true);
  });

  it("preserves a blocked verdict and its findings byte-identically on reuse, never fabricating (bullet 5)", async () => {
    const danger: Check = {
      name: "trust.hidden-unicode",
      verdict: "fail",
      code: "trust.hidden-unicode",
      detail: "instruction surface contains non-ASCII typography",
      fingerprint: "trust-hidden-unicode:SKILL.md:1:abc123",
    };
    const scanComponent = scannerFor({
      "skill:clean": { analyzersRun: ["aih-native"], checks: [pass("skill:clean")] },
      "skill:blocked": { analyzersRun: ["aih-native"], checks: [danger] },
    });
    const priorEvidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
    });
    const blockedPrior = priorEvidence.components.find((c) => c.id === "skill:blocked");
    expect(blockedPrior?.verdict).toBe("blocked");

    const mustNotScan = vi.fn(async () => {
      throw new Error("must not rescan on full reuse");
    });
    const evidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent: mustNotScan,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
      reuseFrom: { schemaVersion: 1, sources: [priorEvidence] },
    });

    const blocked = evidence.components.find((c) => c.id === "skill:blocked");
    expect(blocked).toEqual(blockedPrior);
    expect(blocked?.verdict).toBe("blocked");
    expect(blocked?.findings).toEqual(blockedPrior?.findings);
  });

  it("never reuses a hand-crafted pass entry whose treeSha256 does not match the current tree", async () => {
    const staleLock = {
      schemaVersion: 1 as const,
      sources: [
        {
          id: "ecc",
          owner: "affaan-m",
          repo: "ECC",
          pinnedSha: "d".repeat(40),
          components: [
            {
              id: "skill:clean",
              paths: ["skills/clean"],
              treeSha256: "0".repeat(64),
              verdict: "pass" as const,
              analyzers: [{ name: "aih-native", version: analyzerVersions["aih-native"] }],
              findings: [],
            },
            {
              id: "skill:blocked",
              paths: ["skills/blocked"],
              treeSha256: "1".repeat(64),
              verdict: "pass" as const,
              analyzers: [{ name: "aih-native", version: analyzerVersions["aih-native"] }],
              findings: [],
            },
          ],
        },
      ],
    };
    const scanComponent = scannerFor({
      "skill:clean": { analyzersRun: ["aih-native"], checks: [pass("skill:clean")] },
      "skill:blocked": { analyzersRun: ["aih-native"], checks: [pass("skill:blocked")] },
    });
    const evidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
      reuseFrom: staleLock,
    });
    expect(scanComponent).toHaveBeenCalledTimes(2);
    expect(
      evidence.components.every(
        (c) => c.treeSha256 !== "0".repeat(64) && c.treeSha256 !== "1".repeat(64),
      ),
    ).toBe(true);
  });

  it("--full rescans every component even when a byte-identical prior lock exists", async () => {
    const scanComponent = scannerFor({
      "skill:clean": { analyzersRun: ["aih-native"], checks: [pass("skill:clean")] },
      "skill:blocked": { analyzersRun: ["aih-native"], checks: [pass("skill:blocked")] },
    });
    const priorEvidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
    });

    const rescanAll = vi.fn(async ({ component }: { component: { id: string } }) => ({
      analyzersRun: ["aih-native"],
      checks: [pass(component.id)],
    }));
    await vetBaselineCatalog(root, catalog(), {
      scanComponent: rescanAll,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
      reuseFrom: { schemaVersion: 1, sources: [priorEvidence] },
      full: true,
    });

    expect(rescanAll).toHaveBeenCalledTimes(2);
  });

  it("emits a reuse summary through the progress hook naming reused and rescanned components (bullet 7)", async () => {
    const scanComponent = scannerFor({
      "skill:clean": { analyzersRun: ["aih-native"], checks: [pass("skill:clean")] },
      "skill:blocked": { analyzersRun: ["aih-native"], checks: [pass("skill:blocked")] },
    });
    const priorEvidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
    });

    writeFileSync(join(root, "skills", "clean", "SKILL.md"), "# Clean, edited again\n");
    const progress = vi.fn();
    const mixedScan = vi.fn(async ({ component }: { component: { id: string } }) => ({
      analyzersRun: ["aih-native"],
      checks: [pass(component.id)],
    }));
    await vetBaselineCatalog(root, catalog(), {
      scanComponent: mixedScan,
      scanOptions: { progress },
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
      reuseFrom: { schemaVersion: 1, sources: [priorEvidence] },
    });

    const lines = progress.mock.calls.map((call) => call[0] as string);
    expect(lines[0]).toBe("baseline reuse [ecc @ dddddddddddd]: reused 1/2, rescanned 1/2");
    expect(lines.some((line) => line.includes("reused") && line.includes("skill:blocked"))).toBe(
      true,
    );
    expect(
      lines.some(
        (line) =>
          line.includes("rescan") &&
          line.includes("skill:clean") &&
          line.includes("reason=content-changed"),
      ),
    ).toBe(true);
  });

  it("emits reason=full for every component and a 0-reused header under --full", async () => {
    const scanComponent = scannerFor({
      "skill:clean": { analyzersRun: ["aih-native"], checks: [pass("skill:clean")] },
      "skill:blocked": { analyzersRun: ["aih-native"], checks: [pass("skill:blocked")] },
    });
    const priorEvidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent,
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
    });

    const progress = vi.fn();
    const rescanAll = vi.fn(async ({ component }: { component: { id: string } }) => ({
      analyzersRun: ["aih-native"],
      checks: [pass(component.id)],
    }));
    await vetBaselineCatalog(root, catalog(), {
      scanComponent: rescanAll,
      scanOptions: { progress },
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
      reuseFrom: { schemaVersion: 1, sources: [priorEvidence] },
      full: true,
    });

    const lines = progress.mock.calls.map((call) => call[0] as string);
    expect(lines[0]).toBe("baseline reuse [ecc @ dddddddddddd]: reused 0/2, rescanned 2/2");
    expect(lines.every((line) => !line.includes("reason=unchanged"))).toBe(true);
  });
});
