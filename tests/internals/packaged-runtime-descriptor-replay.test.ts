import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
} from "../../src/contract/strict-json-v1.js";
import { currentEccRuntimeAdapterCompatibilityV1 } from "../../src/ecc/runtime-adapter-compatibility.js";
import {
  EccRuntimeAdapterCompatibilityV1Schema,
  type EccRuntimeDescriptorSealV1,
  type EccRuntimeDescriptorV1,
  inspectEccRuntimeDescriptorSealV1,
} from "../../src/ecc/runtime-descriptor.js";
import { assertPackagedEccRuntimeDescriptorReplayV1 } from "../../src/internals/verify-packaged-workbench-source-data.js";
import { packagedWorkbenchSourceDataRecordsV1 } from "../../src/org-policy/workbench/core/packaged-source-data.js";

function seal(descriptor: EccRuntimeDescriptorV1): EccRuntimeDescriptorSealV1 {
  const bytes = canonicalStrictJsonBytesV1(descriptor);
  return {
    bytesBase64: bytes.toString("base64"),
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function historicalPair() {
  const packaged = packagedWorkbenchSourceDataRecordsV1().find(
    (record) => record.runtimeDescriptor !== undefined,
  )?.runtimeDescriptor;
  if (!packaged) throw new Error("packaged historical ECC descriptor is required");
  const original = inspectEccRuntimeDescriptorSealV1(packaged);
  const current = structuredClone(original);
  current.adapterCompatibility = EccRuntimeAdapterCompatibilityV1Schema.parse(
    currentEccRuntimeAdapterCompatibilityV1(current.components),
  );
  return { packaged, original, current };
}

describe("packaged ECC runtime descriptor replay", () => {
  it("accepts the exact historical adapter against a freshly rederived current descriptor", () => {
    const { packaged, original, current } = historicalPair();
    expect(current.adapterCompatibility).not.toEqual(original.adapterCompatibility);
    expect(() => assertPackagedEccRuntimeDescriptorReplayV1(packaged, seal(current))).not.toThrow();
  });

  it("accepts exact current descriptor bytes", () => {
    const { current } = historicalPair();
    const currentSeal = seal(current);
    expect(() =>
      assertPackagedEccRuntimeDescriptorReplayV1(currentSeal, currentSeal),
    ).not.toThrow();
  });

  it("requires the freshly prepared adapter to be the current projection", () => {
    const { packaged, original, current } = historicalPair();
    current.adapterCompatibility = structuredClone(original.adapterCompatibility);
    expect(() => inspectEccRuntimeDescriptorSealV1(seal(current))).not.toThrow();
    expect(() => assertPackagedEccRuntimeDescriptorReplayV1(packaged, seal(current))).toThrow(
      /Fresh runtime adapter differs from current verified components/,
    );
  });

  it("rejects a validly resealed adapter digest or outcome tamper", () => {
    const { original, current } = historicalPair();
    const badDigest = structuredClone(original);
    badDigest.adapterCompatibility.contractDigest = `sha256:${"0".repeat(64)}`;
    expect(() => inspectEccRuntimeDescriptorSealV1(seal(badDigest))).not.toThrow();
    expect(() =>
      assertPackagedEccRuntimeDescriptorReplayV1(seal(badDigest), seal(current)),
    ).toThrow(/historical ECC runtime adapter compatibility/);

    const badOutcome = structuredClone(original);
    const mapped = badOutcome.adapterCompatibility.outcomes.findIndex(
      (outcome) => outcome.state === "mapped",
    );
    if (mapped < 0) throw new Error("mapped historical adapter outcome is required");
    const outcome = badOutcome.adapterCompatibility.outcomes[mapped];
    if (outcome?.state !== "mapped") throw new Error("mapped adapter outcome is required");
    badOutcome.adapterCompatibility.outcomes[mapped] = {
      ...outcome,
      relative: "tampered/file.md",
    };
    badOutcome.adapterCompatibility.contractDigest = `sha256:${canonicalStrictJsonSha256V1({
      contractVersion: badOutcome.adapterCompatibility.contractVersion,
      relationContract: "compiled-requires-members-and-riders/v1",
      targets: badOutcome.adapterCompatibility.targets,
      outcomes: badOutcome.adapterCompatibility.outcomes,
    })}`;
    expect(() => inspectEccRuntimeDescriptorSealV1(seal(badOutcome))).not.toThrow();
    expect(() =>
      assertPackagedEccRuntimeDescriptorReplayV1(seal(badOutcome), seal(current)),
    ).toThrow(/historical ECC runtime adapter compatibility/);
  });

  it("rejects an exact historical adapter for different fresh components", () => {
    const { packaged, current } = historicalPair();
    const different = structuredClone(current);
    const component = different.components[0];
    if (component?.primaryPath !== "agents/a11y-architect.md")
      throw new Error("historical component fixture changed");
    const path = "agents/a11y-architect-other.md";
    component.primaryPath = path;
    component.paths[0] = path;
    const file = component.files[0];
    if (!file) throw new Error("historical component file fixture changed");
    file.path = path;
    different.adapterCompatibility = EccRuntimeAdapterCompatibilityV1Schema.parse(
      currentEccRuntimeAdapterCompatibilityV1(different.components),
    );
    expect(() => inspectEccRuntimeDescriptorSealV1(seal(different))).not.toThrow();
    expect(() => assertPackagedEccRuntimeDescriptorReplayV1(packaged, seal(different))).toThrow(
      /historical ECC runtime adapter compatibility/,
    );
  });

  it("rejects an unrelated fresh descriptor field mismatch", () => {
    const { packaged, current } = historicalPair();
    current.compilerInputDigest = `sha256:${"0".repeat(64)}`;
    expect(() => inspectEccRuntimeDescriptorSealV1(seal(current))).not.toThrow();
    expect(() => assertPackagedEccRuntimeDescriptorReplayV1(packaged, seal(current))).toThrow(
      /Packaged runtime descriptor differs/,
    );
  });

  it("rejects a missing freshly prepared witness", () => {
    const { packaged } = historicalPair();
    expect(() => assertPackagedEccRuntimeDescriptorReplayV1(packaged, undefined)).toThrow();
  });
});
