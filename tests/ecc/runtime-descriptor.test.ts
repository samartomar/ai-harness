import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import {
  currentEccRuntimeAdapterCompatibilityV1,
  type EccRuntimeDescriptorV1,
  EccRuntimeDescriptorV1Schema,
  packagedEccRuntimeDescriptorsV1,
  registerPackagedEccRuntimeDescriptorsV1,
} from "../../src/ecc/runtime-descriptor.js";
import { deriveEccRuntimeDeclaredEvaluationV1 } from "../../src/ecc/runtime-descriptor-evaluation.js";
import { sealPreparedEccRuntimeDescriptorV1 } from "../../src/org-policy/workbench/core/source-data-scanner.js";

const sha = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const raw = (value: string) => value.repeat(64).slice(0, 64);
const commit = "a".repeat(40);

function seal() {
  const adapterComponents = [
    {
      id: "skill:control",
      kind: "skill",
      files: [{ path: "skills/control/SKILL.md", digest: sha("f") }],
    },
  ];
  const rawReport = {
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: commit,
    sourceTreeSha256: raw("a"),
    components: [
      {
        id: "runtime:raw",
        paths: ["runtime"],
        treeSha256: raw("b"),
        verdict: "blocked" as const,
        analyzers: [{ name: "semgrep@uvx", version: "1" }],
        findings: [{ code: "unsafe", detail: "Original raw finding" }],
      },
    ],
  };
  const evaluation = deriveEccRuntimeDeclaredEvaluationV1({
    rawReport,
    mappings: [{ componentId: "skill:control", rawComponentIds: ["runtime:raw"] }],
    components: [{ id: "skill:control", paths: ["skills/control"], identityTreeSha256: raw("d") }],
  });
  const descriptor: EccRuntimeDescriptorV1 = {
    version: "ecc-runtime-descriptor/v1",
    source: { repository: "affaan-m/ECC", commit, treeSha256: raw("a") },
    compilerInputDigest: sha("c"),
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
      mappings: [{ componentId: "skill:control", rawComponentIds: ["runtime:raw"] }],
    },
    components: [
      {
        id: "skill:control",
        kind: "skill",
        primaryPath: "skills/control",
        paths: ["skills/control"],
        files: [{ path: "skills/control/SKILL.md", digest: sha("f") }],
        treeSha256: raw("d"),
        identityTreeSha256: raw("d"),
      },
    ],
    revisionRelations: [
      {
        componentId: "skill:control",
        sourceId: "source:ecc",
        sourceRevisionId: commit,
        contentDigest: sha("e"),
      },
    ],
    relations: [],
    riderRelations: [],
    adapterCompatibility: structuredClone(
      currentEccRuntimeAdapterCompatibilityV1(adapterComponents),
    ) as EccRuntimeDescriptorV1["adapterCompatibility"],
  };
  const bytes = canonicalStrictJsonBytesV1(descriptor);
  return {
    bytesBase64: bytes.toString("base64"),
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

describe("ECC runtime descriptor", () => {
  it("retains raw blocked findings through the package-only containment mapping", () => {
    const owner = {};
    registerPackagedEccRuntimeDescriptorsV1(owner, [seal()]);
    const [descriptor] = packagedEccRuntimeDescriptorsV1(owner);
    expect(descriptor?.evidence.rawReport.components[0]).toMatchObject({
      id: "runtime:raw",
      verdict: "blocked",
      findings: [{ code: "unsafe", detail: "Original raw finding" }],
    });
    expect(descriptor?.evidence.mappings).toEqual([
      { componentId: "skill:control", rawComponentIds: ["runtime:raw"] },
    ]);
    expect(descriptor?.evidence.custodyPublications).toEqual([
      expect.objectContaining({
        reportSignedAt: "2026-07-03T00:00:00.000Z",
        reportVerificationExpiresAt: "2026-07-03T00:45:00.000Z",
        attestedAt: "2026-07-03T00:15:00.000Z",
      }),
    ]);
    expect(descriptor?.adapterCompatibility).toEqual(
      currentEccRuntimeAdapterCompatibilityV1([
        {
          id: "skill:control",
          kind: "skill",
          files: [{ path: "skills/control/SKILL.md", digest: sha("f") }],
        },
      ]),
    );
  });

  it("rejects mutated sealed facts and returns detached registry values", () => {
    const mutated = { ...seal(), bytesBase64: Buffer.from("{}").toString("base64") };
    expect(() => registerPackagedEccRuntimeDescriptorsV1({}, [mutated])).toThrow();

    const owner = {};
    registerPackagedEccRuntimeDescriptorsV1(owner, [seal()]);
    const first = packagedEccRuntimeDescriptorsV1(owner);
    const firstComponent = first[0]?.components[0];
    if (firstComponent === undefined) throw new Error("fixture");
    firstComponent.paths[0] = "changed";
    expect(packagedEccRuntimeDescriptorsV1(owner)[0]?.components[0]?.paths).toEqual([
      "skills/control",
    ]);
  });

  it("rejects unsafe paths, duplicate relation keys, and unsorted raw report joins", () => {
    const sealed = seal();
    const value = JSON.parse(Buffer.from(sealed.bytesBase64, "base64").toString("utf8"));
    value.components[0].paths = ["C:/descriptor"];
    expect(EccRuntimeDescriptorV1Schema.safeParse(value).success).toBe(false);

    const duplicate = JSON.parse(Buffer.from(sealed.bytesBase64, "base64").toString("utf8"));
    duplicate.relations = [
      { from: "skill:control", to: "skill:control", kind: "requires" },
      { from: "skill:control", to: "skill:control", kind: "requires" },
    ];
    expect(EccRuntimeDescriptorV1Schema.safeParse(duplicate).success).toBe(false);

    const rawJoin = JSON.parse(Buffer.from(sealed.bytesBase64, "base64").toString("utf8"));
    rawJoin.evidence.mappings[0].rawComponentIds = ["runtime:raw", "runtime:raw"];
    expect(EccRuntimeDescriptorV1Schema.safeParse(rawJoin).success).toBe(false);

    const custodyBoundary = JSON.parse(Buffer.from(sealed.bytesBase64, "base64").toString("utf8"));
    custodyBoundary.evidence.custodyPublications[0].attestedAt =
      custodyBoundary.evidence.custodyPublications[0].reportVerificationExpiresAt;
    expect(EccRuntimeDescriptorV1Schema.safeParse(custodyBoundary).success).toBe(false);
  });

  it("does not let a clone mint an operational local or package seal", () => {
    const clone = {};
    expect(() => sealPreparedEccRuntimeDescriptorV1(clone)).toThrow();
  });
});
