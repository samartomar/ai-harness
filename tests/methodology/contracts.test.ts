import { describe, expect, it } from "vitest";
import {
  createHostLoadSurfaceContract,
  hostLoadSurfaces,
} from "../../src/methodology/contracts/host.js";
import {
  resolveCompatibility,
  serializeCompatibilityKey,
} from "../../src/methodology/contracts/compatibility.js";
import type { ProviderQualificationAdapter } from "../../src/methodology/contracts/provider.js";

function compatibilityKey() {
  return {
    provider: {
      repository: "garrytan/gstack",
      resolvedCommit: "a".repeat(40),
      installerContractFingerprint: "b".repeat(64),
    },
    adapter: {
      id: "builtin:gstack",
      contractVersion: 1,
      implementationHash: "c".repeat(64),
    },
    host: {
      id: "codex",
      version: "0.144.1",
      build: "cbacbb97",
      loadSurfaceContractVersion: "codex-0.144.1-windows-x64-v1",
      loadSurfaceCoverage: "partial",
    },
    operatingSystem: { family: "windows", version: "10.0.26200", architecture: "x64" },
    isolationMode: "profile-home",
    runtimes: { npm: "11.8.0", node: "24.13.1" },
    policyVersion: "enterprise-core-v1",
  } as const;
}

describe("methodology contracts", () => {
  it("requires an explicit row for every host load surface", () => {
    const contract = createHostLoadSurfaceContract({
      id: "codex-0.144.1-windows-x64-v1",
      host: { id: "codex", version: "0.144.1", build: "cbacbb97" },
      surfaces: hostLoadSurfaces.map((surface) => ({
        surface,
        coverage: surface === "cache-and-session-persistence" ? "partial" : "complete",
        evidence: ["docs"],
        positiveProbe: "designed",
        negativeProbe: "designed",
      })),
    });

    expect(contract.coverage).toBe("partial");
    expect(() =>
      createHostLoadSurfaceContract({ ...contract, surfaces: contract.surfaces.slice(1) }),
    ).toThrow(/missing/i);
  });

  it("serializes the exact compatibility tuple deterministically", () => {
    const first = compatibilityKey();
    const second = { ...first, runtimes: { node: "24.13.1", npm: "11.8.0" } };

    expect(serializeCompatibilityKey(first)).toBe(serializeCompatibilityKey(second));
  });

  it("fails closed for an unknown compatibility tuple", () => {
    const key = compatibilityKey();

    expect(resolveCompatibility(key, [])).toEqual({
      status: "unknown",
      finding: "ADAPTER_COMPATIBILITY_UNKNOWN",
      safeRetry: "Add an exact reviewed compatibility tuple before qualification.",
      stopCondition: "Do not infer support from a similar provider, host, or adapter tuple.",
    });
    expect(resolveCompatibility(key, [key]).status).toBe("supported");
  });

  it("exposes only Phase A adapter operations", () => {
    const operations = [
      "describe",
      "discover",
      "resolveLocal",
      "evaluate",
      "fingerprint",
      "planProposed",
      "qualify",
    ] as const satisfies ReadonlyArray<keyof ProviderQualificationAdapter>;

    expect(operations).not.toContain("execute" as never);
    expect(operations).not.toContain("planInstall" as never);
    expect(operations).not.toContain("verifyLoaded" as never);
  });
});
