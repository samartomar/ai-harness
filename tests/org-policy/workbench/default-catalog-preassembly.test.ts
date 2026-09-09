import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../../src/contract/strict-json-v1.js";
import type { PreparedWorkbenchCatalogV1 } from "../../../src/org-policy/workbench/prepared-catalog.js";

const emptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const tinyCatalog = { id: "tiny-catalog" };
const tinyBundle = { provenance: { bundleDigest: `sha256:${emptySha256}` } };

vi.mock("../../../src/baseline-evidence/vendor.js", () => ({
  readVendorBaselineLock: () => ({ sources: [] }),
  vendorBaselineLockSha256: () => emptySha256,
}));
vi.mock("../../../src/org-policy/catalog.js", () => ({
  policyAuthoringCatalog: () => structuredClone(tinyCatalog),
}));
vi.mock("../../../src/version.js", () => ({ VERSION: "test" }));
vi.mock("../../../src/org-policy/workbench/catalog-bundle.js", () => ({
  verifyAuthoringCatalogBundleIntegrityV1: () => undefined,
}));
vi.mock("../../../src/org-policy/workbench/compilers/built-in.js", () => ({
  compileBuiltInCatalogV1: () => ({ coreCapabilities: [] }),
}));
vi.mock("../../../src/org-policy/workbench/compilers/formats.js", () => ({
  compilerFormatRegistrationsV1: [],
}));
vi.mock("../../../src/org-policy/workbench/core/packaged-source-data-data.js", () => ({
  packagedWorkbenchSourceDataInputV1: () => [{ bytes: "", sha256: emptySha256 }],
}));
vi.mock("../../../src/org-policy/workbench/providers/registry.js", () => ({
  registeredCatalogProvidersV1: [
    {
      providerId: "tiny",
      providerVersion: "1",
      prepareBaseline: () => ({
        providerId: "tiny",
        providerVersion: "1",
        inputDigest: `sha256:${emptySha256}`,
        inputs: [{ source: "tiny" }],
      }),
    },
  ],
}));

const { admitDefaultCatalogPreassemblyV1, createDefaultCatalogPreassemblyV1 } = await import(
  "../../../src/org-policy/workbench/default-catalog-preassembly.js"
);

function canonical(value: unknown): string {
  return canonicalStrictJsonBytesV1(value).toString("utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function replacePayload(
  input: Readonly<{ bytes: string; sha256: string }>,
  mutate: (payload: Record<string, unknown>) => void,
) {
  const envelope = JSON.parse(input.bytes) as { bytes: string };
  const payload = JSON.parse(envelope.bytes) as Record<string, unknown>;
  mutate(payload);
  const payloadBytes = canonical(payload);
  const bytes = canonical({
    version: "default-catalog-preassembly/v1",
    bytes: payloadBytes,
    sha256: sha256(payloadBytes),
  });
  return { bytes, sha256: sha256(bytes) };
}

describe("default catalog preassembly admission", () => {
  it("fails closed for tampering, falls back for stale identities, and returns detached output", () => {
    const fresh = {
      catalog: structuredClone(tinyCatalog),
      bundle: structuredClone(tinyBundle),
      bindings: {},
      sourceInputs: {},
    } as unknown as PreparedWorkbenchCatalogV1;
    const input = createDefaultCatalogPreassemblyV1(fresh);
    const admitted = admitDefaultCatalogPreassemblyV1(input);
    expect(admitted).toEqual(fresh);
    if (admitted === undefined) throw new Error("expected fresh preassembly admission");

    admitted.bundle.provenance.bundleDigest = "sha256:mutated";
    expect(admitDefaultCatalogPreassemblyV1(input)?.bundle.provenance.bundleDigest).toBe(
      fresh.bundle.provenance.bundleDigest,
    );
    expect(() => admitDefaultCatalogPreassemblyV1({ ...input, bytes: `${input.bytes} ` })).toThrow(
      /seal mismatch/,
    );

    const stale = replacePayload(input, (payload) => {
      const admission = payload.admission as Record<string, unknown>;
      admission.catalogDigest =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    });
    expect(admitDefaultCatalogPreassemblyV1(stale)).toBeUndefined();

    const staleProvider = replacePayload(input, (payload) => {
      const admission = payload.admission as Record<string, unknown>;
      const providerAdmissions = admission.providerAdmissions as Array<Record<string, unknown>>;
      const first = providerAdmissions[0];
      if (first === undefined) throw new Error("expected tiny provider admission");
      first.providerVersion = "2";
    });
    expect(admitDefaultCatalogPreassemblyV1(staleProvider)).toBeUndefined();

    const malformedProvider = replacePayload(input, (payload) => {
      const admission = payload.admission as Record<string, unknown>;
      admission.providerAdmissions = [{}];
    });
    expect(() => admitDefaultCatalogPreassemblyV1(malformedProvider)).toThrow(
      /provider admission is malformed/,
    );

    const duplicateProvider = replacePayload(input, (payload) => {
      const admission = payload.admission as Record<string, unknown>;
      const providerAdmissions = admission.providerAdmissions as Array<Record<string, unknown>>;
      const first = providerAdmissions[0];
      if (first === undefined) throw new Error("expected tiny provider admission");
      providerAdmissions.push(structuredClone(first));
    });
    expect(() => admitDefaultCatalogPreassemblyV1(duplicateProvider)).toThrow(
      /provider admission is malformed/,
    );
  });
});
