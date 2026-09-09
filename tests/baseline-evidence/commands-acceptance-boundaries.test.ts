import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import {
  type BaselineVetPlanOptions,
  baselineVetPlanForSource,
} from "../../src/baseline-evidence/commands.js";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import { parseOutputManifest } from "../../src/baseline-evidence/output-manifest.js";
import { ECC_UPSTREAM_FULL_PROFILE_ID } from "../../src/baseline-evidence/profiles.js";
import { BaselineSourceEvidenceSchema } from "../../src/baseline-evidence/schema.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  dispositionForTrustFinding,
  type NormalizedTrustFinding,
} from "../../src/trust/evidence.js";
import { resolveTrustSource } from "../../src/trust/fetch.js";
import type { TrustScanResult } from "../../src/trust/scan.js";

const PIN = "a".repeat(40);
const REPORT = `.aih/baseline-reports/ecc-${PIN.slice(0, 12)}.json`;
const OCCURRENCES = `.aih/baseline-reports/ecc-${PIN.slice(0, 12)}-${ECC_UPSTREAM_FULL_PROFILE_ID}-occurrences.json`;
const MANIFEST = `.aih/baseline-reports/ecc-${PIN.slice(0, 12)}-${ECC_UPSTREAM_FULL_PROFILE_ID}-outputs.sha256`;

let root: string;
let sourceRoot: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "aih-baseline-command-boundary-")));
  sourceRoot = join(root, "source");
  mkdirSync(join(sourceRoot, "skills", "clean"), { recursive: true });
  writeFileSync(join(sourceRoot, "skills", "clean", "SKILL.md"), "# Clean\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function context(): PlanContext {
  const run = fakeRunner((argv) =>
    argv[0] === "git" ? { stdout: argv.includes("status") ? "" : `${PIN}\n` } : undefined,
  );
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: true,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

function catalog() {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "samartomar",
    repo: "ECC",
    pinnedSha: PIN,
    components: [{ id: "skill:clean", paths: ["skills/clean"] }],
  });
}

function evidence(sourceCatalog = catalog()) {
  return BaselineSourceEvidenceSchema.parse({
    id: "ecc",
    owner: "samartomar",
    repo: "ECC",
    pinnedSha: PIN,
    components: sourceCatalog.components.map((component) => ({
      id: component.id,
      paths: component.paths,
      treeSha256: hashComponentTree(sourceRoot, component.paths).treeSha256,
      verdict: "pass",
      analyzers: [{ name: "aih-native", version: "2.7.0" }],
      findings: [],
    })),
  });
}

const cleanScan: TrustScanResult = {
  checks: [],
  analyzersRun: ["aih-native"],
  rawOccurrences: [],
  normalizedFindings: [],
  policyDispositions: [],
};

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function controlledVet(
  retainSourceLedger: boolean,
  componentScan: TrustScanResult = cleanScan,
  sourceScan: TrustScanResult = componentScan,
): NonNullable<BaselineVetPlanOptions["vetCatalog"]> {
  return async (_root, sourceCatalog, options = {}) => {
    const [component] = sourceCatalog.components;
    if (component === undefined) throw new Error("controlled fixture requires one component");
    options.onComponentScan?.(component, componentScan);
    if (retainSourceLedger) options.onSourceWideScan?.(sourceScan);
    return evidence(sourceCatalog);
  };
}

function findingsScan(): TrustScanResult {
  const findings: NormalizedTrustFinding[] = [
    "trust.external-egress",
    "trust.malicious-code",
    "trust.cisco-finding",
    "trust.visible-unicode",
    "trust.detector-finding",
  ].map((code, index) => ({
    fingerprint: `finding:${index}`,
    code: code as NormalizedTrustFinding["code"],
    detail: `Controlled fixture finding ${index}`,
    location: { uri: "skills/x-api/SKILL.md", startLine: index + 1 },
    sourceValue: `fixture value ${index}`,
    rawOccurrenceFingerprints: [`raw:${index}`],
  }));
  return {
    ...cleanScan,
    normalizedFindings: findings,
    policyDispositions: findings.map(dispositionForTrustFinding),
    rawOccurrences: findings.map((finding, index) => ({
      fingerprint: `raw:${index}`,
      analyzer: "fixture-scanner",
      ruleId: `fixture-rule-${index}`,
      message: finding.detail,
      location: finding.location,
      sourceValue: finding.sourceValue,
    })),
  };
}

describe("baseline vet command qualification boundaries", () => {
  it("retains unique full-source findings and exact residual review requirements in verified output bytes", async () => {
    mkdirSync(join(sourceRoot, "skills", "x-api"), { recursive: true });
    writeFileSync(
      join(sourceRoot, "skills", "x-api", "SKILL.md"),
      Array.from({ length: 5 }, (_, index) => `fixture value ${index}`).join("\n"),
    );
    const sourceCatalog = defineBaselineCatalog({
      ...catalog(),
      components: [{ id: "skill:x-api", paths: ["skills/x-api"] }],
    });
    const scan = findingsScan();
    const sourceScan = {
      ...scan,
      rawOccurrences: [...(scan.rawOccurrences ?? [])].reverse().concat(scan.rawOccurrences ?? []),
      normalizedFindings: [...(scan.normalizedFindings ?? [])]
        .reverse()
        .concat(scan.normalizedFindings ?? []),
      policyDispositions: [...(scan.policyDispositions ?? [])]
        .reverse()
        .concat(scan.policyDispositions ?? []),
    };
    const ctx = context();
    const result = await executePlan(
      await baselineVetPlanForSource(ctx, resolveTrustSource(sourceRoot, { root }), sourceCatalog, {
        vetCatalog: controlledVet(true, scan, sourceScan),
        profileId: ECC_UPSTREAM_FULL_PROFILE_ID,
      }),
      ctx,
    );
    const report = JSON.parse(readFileSync(join(root, OCCURRENCES), "utf8"));
    expect(report.fullSourceDisclosure).toMatchObject({
      rawOccurrences: 5,
      normalizedFindings: 5,
      block: 1,
      review: 1,
      warn: 1,
      informational: 1,
      suppressed: 1,
    });
    expect(report.sourceOccurrenceLedger).toEqual({
      rawOccurrences: scan.rawOccurrences,
      normalizedFindings: scan.normalizedFindings,
      policyDispositions: scan.policyDispositions,
    });
    expect(report.activeProfile.verdict).toBe("BLOCK");
    expect(report.components[0]).toMatchObject({ correctedVerdict: "BLOCK" });
    expect(report.acceptanceRecordsStillRequired).toEqual([
      {
        componentId: "skill:x-api",
        fingerprint: "finding:0",
        code: "trust.external-egress",
        path: "skills/x-api/SKILL.md",
        line: 1,
        value: "fixture value 0",
      },
    ]);
    expect(report.groupedResidualReviewDecisions).toEqual([
      expect.objectContaining({
        id: "x-api-authenticated-access",
        occurrenceFingerprints: ["finding:0"],
      }),
    ]);
    expect(result.digests[0]?.text).toContain(
      'REVIEW skill:x-api skills/x-api/SKILL.md:1 = "fixture value 0"',
    );
    expect(result.digests[0]?.text).toContain(
      'BLOCK skill:x-api skills/x-api/SKILL.md:2 = "fixture value 1"',
    );
    expect(
      Object.fromEntries(
        parseOutputManifest(readFileSync(join(root, MANIFEST), "utf8")).map((entry) => [
          entry.path,
          entry.sha256,
        ]),
      ),
    ).toEqual({
      [REPORT]: sha256(join(root, REPORT)),
      [OCCURRENCES]: sha256(join(root, OCCURRENCES)),
    });
    expect(existsSync(join(sourceRoot, ".aih"))).toBe(false);
  });

  it.each(["raw occurrence", "normalized finding", "policy disposition"] as const)(
    "refuses to seal conflicting %s rows with the same fingerprint",
    async (kind) => {
      const scan = findingsScan();
      if (kind === "raw occurrence") {
        const first = scan.rawOccurrences?.[0];
        if (first === undefined) throw new Error("Missing raw fixture occurrence");
        scan.rawOccurrences?.push({ ...first, message: "contradictory retained message" });
      } else if (kind === "normalized finding") {
        const first = scan.normalizedFindings?.[0];
        if (first === undefined) throw new Error("Missing normalized fixture finding");
        scan.normalizedFindings?.push({ ...first, detail: "contradictory retained detail" });
      } else {
        const first = scan.policyDispositions?.[0];
        if (first === undefined) throw new Error("Missing fixture disposition");
        scan.policyDispositions?.push({ ...first, level: "SUPPRESSED" });
      }
      const ctx = context();
      await expect(
        executePlan(
          await baselineVetPlanForSource(ctx, resolveTrustSource(sourceRoot, { root }), catalog(), {
            vetCatalog: controlledVet(true, cleanScan, scan),
            profileId: ECC_UPSTREAM_FULL_PROFILE_ID,
          }),
          ctx,
        ),
      ).rejects.toThrow(
        kind === "policy disposition"
          ? "conflicting policy dispositions share fingerprint"
          : `conflicting ${kind} rows share fingerprint`,
      );
      expect(existsSync(join(root, OCCURRENCES))).toBe(false);
      expect(existsSync(join(root, MANIFEST))).toBe(false);
    },
  );

  it("seals a complete exact-pin qualification output without installing the source", async () => {
    const ctx = context();
    const result = await executePlan(
      await baselineVetPlanForSource(ctx, resolveTrustSource(sourceRoot, { root }), catalog(), {
        vetCatalog: controlledVet(true),
        profileId: ECC_UPSTREAM_FULL_PROFILE_ID,
      }),
      ctx,
    );

    expect(result.digests[0]?.text).toContain("source integrity: EXACT PIN VERIFIED");
    expect(result.digests[0]?.text).toContain("This command installed nothing.");
    expect(existsSync(join(root, REPORT))).toBe(true);
    expect(existsSync(join(root, OCCURRENCES))).toBe(true);
    expect(existsSync(join(root, MANIFEST))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, OCCURRENCES), "utf8"))).toMatchObject({
      source: { pinnedSha: PIN, integrity: "EXACT PIN VERIFIED" },
      fullSourceDisclosure: { rawOccurrences: 0, normalizedFindings: 0 },
      activeProfile: { verdict: "PASS", selectedComponents: ["skill:clean"] },
    });
    expect(
      Object.fromEntries(
        parseOutputManifest(readFileSync(join(root, MANIFEST), "utf8")).map((entry) => [
          entry.path,
          entry.sha256,
        ]),
      ),
    ).toEqual({
      [REPORT]: sha256(join(root, REPORT)),
      [OCCURRENCES]: sha256(join(root, OCCURRENCES)),
    });
    expect(existsSync(join(sourceRoot, ".aih"))).toBe(false);
  });

  it("refuses qualification without a complete source-wide custody ledger", async () => {
    const ctx = context();
    await expect(
      executePlan(
        await baselineVetPlanForSource(ctx, resolveTrustSource(sourceRoot, { root }), catalog(), {
          vetCatalog: controlledVet(false),
          profileId: ECC_UPSTREAM_FULL_PROFILE_ID,
        }),
        ctx,
      ),
    ).rejects.toThrow("baseline qualification did not retain a complete source-wide scan");

    expect(existsSync(join(root, REPORT))).toBe(true);
    expect(existsSync(join(root, OCCURRENCES))).toBe(false);
    expect(existsSync(join(root, MANIFEST))).toBe(false);
    expect(existsSync(join(sourceRoot, ".aih"))).toBe(false);
  });
});
