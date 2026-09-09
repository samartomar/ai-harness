import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import {
  currentEccRuntimeAdapterCompatibilityV1,
  type EccRuntimeDescriptorV1,
} from "../../src/ecc/runtime-descriptor.js";
import { deriveEccRuntimeDeclaredEvaluationV1 } from "../../src/ecc/runtime-descriptor-evaluation.js";

const candidates = vi.hoisted(() => ({
  packaged: [] as EccRuntimeDescriptorV1[],
  local: [] as EccRuntimeDescriptorV1[],
}));

vi.mock("../../src/org-policy/workbench/core/packaged-source-data.js", () => ({
  packagedEccRuntimeDescriptorsV1: () => candidates.packaged,
}));
vi.mock("../../src/org-policy/workbench/core/source-data.js", () => ({
  historicalEccRuntimeDescriptorsFromSourceDataV1: () => candidates.local,
  workbenchSourceDataRootV1: () => "unused",
}));

const { resolveHistoricalEccRuntimeDescriptorV1 } = await import(
  "../../src/ecc/runtime-descriptor-resolver.js"
);

const commit = "a".repeat(40);
const raw = (value: string) => value.repeat(64).slice(0, 64);
const digest = (value: string) => `sha256:${raw(value)}`;

function descriptor(
  options: { riderOnly?: boolean; incompatibleAdapter?: boolean } = {},
): EccRuntimeDescriptorV1 {
  const components = [
    {
      id: "skill:control",
      kind: "skill",
      primaryPath: "skills/control/SKILL.md",
      paths: ["skills/control"],
      files: [{ path: "skills/control/SKILL.md", digest: digest("d") }],
      treeSha256: raw("e"),
      identityTreeSha256: raw("f"),
    },
    {
      id: "skill:helper",
      kind: "skill",
      primaryPath: "skills/helper/SKILL.md",
      paths: ["skills/helper"],
      files: [{ path: "skills/helper/SKILL.md", digest: digest("1") }],
      treeSha256: raw("2"),
      identityTreeSha256: raw("3"),
    },
  ];
  const rawReport = {
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: commit,
    sourceTreeSha256: raw("4"),
    components: components.map((_component, index) => ({
      id: `raw:${index}`,
      paths: [`raw/${index}`],
      treeSha256: raw(index === 0 ? "5" : "6"),
      verdict: "pass" as const,
      analyzers: [],
      findings: [],
    })),
  };
  const mappings = components.map((component, index) => ({
    componentId: component.id,
    rawComponentIds: [`raw:${index}`],
  }));
  const evaluation = deriveEccRuntimeDeclaredEvaluationV1({
    rawReport,
    mappings,
    components: components.map((component) => ({
      id: component.id,
      paths: component.paths,
      identityTreeSha256: component.identityTreeSha256,
    })),
  });
  const current = currentEccRuntimeAdapterCompatibilityV1(components);
  const compatibility = {
    contractVersion: current.contractVersion,
    contractDigest: options.incompatibleAdapter ? digest("9") : current.contractDigest,
    targets: [...current.targets],
    outcomes: current.outcomes.map((outcome) => ({ ...outcome })),
  };
  return {
    version: "ecc-runtime-descriptor/v1",
    source: { repository: "affaan-m/ECC", commit, treeSha256: raw("4") },
    compilerInputDigest: digest("7"),
    evidence: {
      rawReport,
      rawReportDigest: `sha256:${createHash("sha256").update(canonicalStrictJsonBytesV1(rawReport)).digest("hex")}`,
      custodyPublications: [
        {
          publicationSha256: raw("1"),
          requestSha256: raw("2"),
          receiptSha256: raw("3"),
          reportSignedAt: "2026-07-03T00:00:00.000Z",
          reportVerificationExpiresAt: "2026-07-03T00:45:00.000Z",
          attestedAt: "2026-07-03T00:15:00.000Z",
        },
      ],
      validUntil: "2026-10-01T00:00:00.000Z",
      coreDerivedEvaluationDigest: evaluation.coreDerivedEvaluationDigest,
      projectionContractDigest: evaluation.projectionContractDigest,
      mappings,
    },
    components,
    revisionRelations: components.map((component) => ({
      componentId: component.id,
      sourceId: "source:ecc",
      sourceRevisionId: commit,
      contentDigest: digest(component.id === "skill:control" ? "8" : "a"),
    })),
    relations: [{ from: "skill:control", to: "skill:helper", kind: "requires" as const }],
    riderRelations: options.riderOnly ? [{ from: "skill:control", to: "skill:helper" }] : [],
    adapterCompatibility: compatibility,
  } satisfies EccRuntimeDescriptorV1;
}

const policy = {
  externalSelections: [
    {
      framework: "ecc",
      items: [{ source: { repository: "affaan-m/ECC", commit } }],
    },
  ],
};
const now = "2026-09-09T03:30:00.000Z";

describe("historical ECC runtime descriptor resolution", () => {
  it("uses the first matching local receipt ahead of package data and preserves rider optionality", () => {
    const packageDescriptor = descriptor();
    const localDescriptor = descriptor({ riderOnly: true });
    candidates.packaged = [packageDescriptor];
    candidates.local = [localDescriptor, packageDescriptor];

    const resolved = resolveHistoricalEccRuntimeDescriptorV1(policy, { now });
    expect(resolved.descriptorSha256).toBe(
      `sha256:${createHash("sha256").update(canonicalStrictJsonBytesV1(localDescriptor)).digest("hex")}`,
    );
    expect(resolved.relations.mandatoryRequirementsById.get("skill:control")).toBeUndefined();
    expect(resolved.relations.declarationRidersById.get("skill:control")).toEqual(["skill:helper"]);
  });

  it("keeps an overlap already removed from rider relations mandatory", () => {
    const localDescriptor = descriptor();
    candidates.packaged = [];
    candidates.local = [localDescriptor];

    const resolved = resolveHistoricalEccRuntimeDescriptorV1(policy, { now });
    expect(resolved.relations.mandatoryRequirementsById.get("skill:control")).toEqual([
      "skill:helper",
    ]);
    expect(resolved.relations.declarationRidersById.get("skill:control")).toBeUndefined();
  });

  it("retains archived custody after its original window but rejects future original facts", () => {
    const packageDescriptor = descriptor();
    candidates.local = [];
    candidates.packaged = [packageDescriptor];
    const resolved = resolveHistoricalEccRuntimeDescriptorV1(policy, { now });
    expect(resolved.evidence.custodyPublications[0]).toMatchObject({
      reportVerificationExpiresAt: "2026-07-03T00:45:00.000Z",
      attestedAt: "2026-07-03T00:15:00.000Z",
    });

    const future = descriptor();
    future.evidence.custodyPublications[0]!.attestedAt = "2026-09-10T00:00:00.000Z";
    future.evidence.custodyPublications[0]!.reportVerificationExpiresAt =
      "2026-09-10T00:45:00.000Z";
    candidates.packaged = [future];
    expect(() => resolveHistoricalEccRuntimeDescriptorV1(policy, { now })).toThrow();
  });

  it("deduplicates identical package literals but rejects divergent package or incompatible local facts", () => {
    const packageDescriptor = descriptor();
    candidates.local = [];
    candidates.packaged = [packageDescriptor, structuredClone(packageDescriptor)];
    expect(resolveHistoricalEccRuntimeDescriptorV1(policy, { now }).source.commit).toBe(commit);

    const divergent = descriptor();
    divergent.evidence.validUntil = "2026-10-02T00:00:00.000Z";
    candidates.packaged = [packageDescriptor, divergent];
    expect(() => resolveHistoricalEccRuntimeDescriptorV1(policy, { now })).toThrow();

    candidates.packaged = [packageDescriptor];
    candidates.local = [descriptor({ incompatibleAdapter: true })];
    expect(() => resolveHistoricalEccRuntimeDescriptorV1(policy, { now })).toThrow();
  });
});
