import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../../src/contract/strict-json-v1.js";

const fixture = vi.hoisted(() => ({
  generated: undefined as unknown,
  prepare: vi.fn(),
}));
const emptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const tinyCatalog = {
  hosts: [],
  externalMcp: [],
  eccMcpApproval: {},
  eccHookControls: {},
  frameworks: [],
};

vi.mock("../../../src/baseline-evidence/vendor.js", () => ({
  vendorBaselineLockSha256: () => emptySha256,
}));
vi.mock("../../../src/org-policy/catalog.js", () => ({
  policyAuthoringCatalog: () => structuredClone(tinyCatalog),
}));
vi.mock("../../../src/org-policy/adoption-recipe.js", () => ({ buildAdoptionRecipe: () => ({}) }));
vi.mock("../../../src/org-policy/packaged-collection-evidence-data.js", () => ({
  packagedScannerCollectionEvidenceInputV1: () => [],
}));
vi.mock("../../../src/org-policy/packaged-collection-evidence-v1.js", () => ({
  packagedScannerCollectionEvidenceV1: () => [],
  projectScannerCollectionEvidenceV1: () => ({}),
}));
vi.mock("../../../src/org-policy/packaged-public-baseline-v1.js", () => ({
  PUBLIC_BASELINE_PUBLISHER_V1: {},
  packagedPublicBaselineEvidenceV1: () => undefined,
  packagedPublicBaselineOverlayV1: () => ({}),
}));
vi.mock("../../../src/org-policy/packaged-public-baseline-data.js", () => ({
  PACKAGED_PUBLIC_BASELINE_BYTES_V1: null,
  PACKAGED_PUBLIC_BASELINE_SHA256_V1: null,
}));
vi.mock("../../../src/org-policy/workbench/core/catalog-qualification-data.js", () => ({
  catalogQualificationPackageInputV1: () => ({}),
}));
vi.mock("../../../src/org-policy/workbench/core/catalog-qualification-v1.js", () => ({
  preparePackagedCatalogQualificationV1: () => undefined,
  catalogQualificationPreparedBundleV1: () => undefined,
}));
vi.mock("../../../src/org-policy/workbench/core/catalog-qualification-policy-v1.js", () => ({
  catalogQualificationReleasePolicyMetadataV1: {},
}));
vi.mock("../../../src/org-policy/workbench/default-catalog-preassembly.js", () => ({
  defaultCatalogPreassemblyAdmissionV1: () => ({}),
  packagedDefaultCatalogPreassemblyCompanionV1: () => fixture.generated,
}));
vi.mock("../../../src/org-policy/workbench/catalog-bundle.js", () => ({
  verifyAuthoringCatalogBundleIntegrityV1: () => undefined,
}));
vi.mock("../../../src/org-policy/workbench/contracts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/org-policy/workbench/contracts.js")>()),
  AuthoringCatalogBundleV1Schema: { parse: <T>(value: T) => value },
}));
vi.mock("../../../src/org-policy/workbench/core/packaged-source-data.js", () => ({
  packagedWorkbenchSourcePublicationsV1: () => [],
}));
const apply = vi.hoisted(() => vi.fn((value) => structuredClone(value)));
vi.mock("../../../src/org-policy/workbench/core/source-data.js", () => ({
  applyWorkbenchSourceDataV1: apply,
}));
vi.mock("../../../src/org-policy/workbench/prepared-catalog.js", () => ({
  packagedPreparedWorkbenchCatalogV1: () => fixture.prepare(),
  prepareWorkbenchCatalog: (...args: unknown[]) => fixture.prepare(...args),
}));

const {
  admitDefaultStudioPreassemblyV1,
  buildDefaultStudioPackageBaseV1,
  createDefaultStudioPreassemblyV1,
  policyStudioModel,
} = await import("../../../src/org-policy/studio-model.js");

function canonical(value: unknown): string {
  return canonicalStrictJsonBytesV1(value).toString("utf8");
}

function reseal(
  input: Readonly<{ bytes: string }>,
  mutate: (payload: Record<string, unknown>) => void,
) {
  const envelope = JSON.parse(input.bytes) as { bytes: string };
  const payload = JSON.parse(envelope.bytes) as Record<string, unknown>;
  mutate(payload);
  const payloadBytes = canonical(payload);
  const bytes = canonical({
    bytes: payloadBytes,
    sha256: createHash("sha256").update(payloadBytes).digest("hex"),
    version: "default-studio-preassembly/v1",
  });
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

describe("default Studio preassembly", () => {
  it("does not capture host state, detaches admitted data, and applies live source verification", () => {
    const prepared = {
      catalog: structuredClone(tinyCatalog),
      bundle: { provenance: { bundleDigest: `sha256:${emptySha256}` }, qualifications: {} },
      bindings: {},
      sourceInputs: {},
    } as never;
    const base = buildDefaultStudioPackageBaseV1(prepared);
    expect(apply).not.toHaveBeenCalled();
    const studio = createDefaultStudioPreassemblyV1(base);
    const admitted = admitDefaultStudioPreassemblyV1(studio);
    expect(admitted).toEqual(base);
    if (admitted === undefined) throw new Error("expected admitted Studio base");
    admitted.prepared.bundle.provenance.bundleDigest = "sha256:mutated";
    expect(admitDefaultStudioPreassemblyV1(studio)?.prepared.bundle.provenance.bundleDigest).toBe(
      base.prepared.bundle.provenance.bundleDigest,
    );

    fixture.generated = { catalog: { bytes: "{}", sha256: emptySha256 }, studio };
    const liveDigest = `sha256:${"a".repeat(64)}`;
    apply.mockImplementation((value) => {
      const replaced = structuredClone(value) as {
        bundle: { provenance: { bundleDigest: string } };
      };
      replaced.bundle.provenance.bundleDigest = liveDigest;
      return replaced;
    });
    const model = policyStudioModel();
    expect(model.workbenchBundle.provenance.bundleDigest).toBe(liveDigest);
    expect(model.evidenceDelivery?.workbenchCatalogDigest).toBe(liveDigest);
    expect(apply).toHaveBeenCalledTimes(1);

    apply.mockClear();
    fixture.prepare.mockReturnValue(structuredClone(base.prepared));
    const custom = policyStudioModel(undefined, undefined, {
      initialPolicy: structuredClone(base.shell.defaultPolicy),
    });
    expect(custom.workbenchBundle.provenance.bundleDigest).toBe(liveDigest);
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);

    apply.mockClear();
    fixture.prepare.mockClear();
    const historical = structuredClone(base.shell.defaultPolicy) as Record<string, unknown>;
    historical.schemaVersion = 3;
    historical.minimumCoreVersion = "0.6.0";
    historical.authoringSelections = {
      selectionVersion: "workbench-selection/v1",
      roots: [],
      exclusions: [],
      drafts: [],
      requests: [
        {
          assetId: "fixture:historical",
          origin: { kind: "administrator" },
          sourceId: "source:historical",
          sourceRevisionId: "revision:historical",
          contentDigest: `sha256:${emptySha256}`,
        },
      ],
    };
    policyStudioModel(undefined, undefined, { initialPolicy: historical as never });
    expect(fixture.prepare).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        sourceDataPins: [
          {
            assetId: "fixture:historical",
            origin: { kind: "administrator" },
            sourceId: "source:historical",
            sourceRevisionId: "revision:historical",
            contentDigest: `sha256:${emptySha256}`,
          },
        ],
      }),
    );
    expect(apply).toHaveBeenCalledTimes(1);

    const stale = reseal(studio, (payload) => {
      (payload.admission as Record<string, unknown>).staticInputDigest = "sha256:0".padEnd(71, "0");
    });
    expect(admitDefaultStudioPreassemblyV1(stale)).toBeUndefined();

    const outputTampered = reseal(studio, (payload) => {
      const prepared = (payload.base as { prepared: { bindings: Record<string, unknown> } })
        .prepared;
      prepared.bindings.tampered = { kind: "fixture" };
    });
    expect(() => admitDefaultStudioPreassemblyV1(outputTampered)).toThrow(
      "Default Studio preassembly output integrity mismatch",
    );
  });
});
