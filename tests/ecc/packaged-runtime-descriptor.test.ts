import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertHistoricalEccAdapterCompatibilityV1,
  currentEccRuntimeAdapterCompatibilityV1,
  type EccRuntimeAdapterOutcomeV1,
} from "../../src/ecc/runtime-adapter-compatibility.js";
import { resolveHistoricalEccRuntimeDescriptorV1 } from "../../src/ecc/runtime-descriptor-resolver.js";
import { packagedEccRuntimeDescriptorsV1 } from "../../src/org-policy/workbench/core/packaged-source-data.js";

const INITIAL_ECC_COMMIT = "5064474d4d762dc9640234a41617cccb79185cec";

describe("packaged historical ECC runtime delivery", () => {
  it("resolves unchanged historical routes while retaining their exact sealed destinations", async () => {
    const descriptor = packagedEccRuntimeDescriptorsV1().find(
      (candidate) => candidate.source.commit === INITIAL_ECC_COMMIT,
    );
    if (!descriptor) throw new Error("packaged initial ECC descriptor is required");
    const current = currentEccRuntimeAdapterCompatibilityV1(descriptor.components);
    const outcomeKey = (outcome: EccRuntimeAdapterOutcomeV1) =>
      `${outcome.componentId}\0${outcome.path}\0${outcome.target}`;
    const actualByKey = new Map(
      descriptor.adapterCompatibility.outcomes.map((outcome) => [outcomeKey(outcome), outcome]),
    );
    const mismatches = current.outcomes.filter(
      (outcome) => JSON.stringify(outcome) !== JSON.stringify(actualByKey.get(outcomeKey(outcome))),
    );
    expect(mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          componentId: expect.stringMatching(/^agent:/),
          target: "codex",
          state: "mapped",
          relative: expect.stringMatching(/^\.codex\/agents\/.*\.toml$/),
        }),
      ]),
    );
    // With the Catalog this checkout installs, the same sealed bytes arrive through it.
    const resolved = await resolveHistoricalEccRuntimeDescriptorV1(
      {
        governance: {
          externalSelections: [
            {
              framework: "ecc",
              items: [
                {
                  source: {
                    repository: "affaan-m/ECC",
                    commit: INITIAL_ECC_COMMIT,
                  },
                },
              ],
            },
          ],
        },
      },
      { now: "2026-09-13T19:45:00.000Z", dataRoot: join(tmpdir(), "aih-absent-workbench-data-v1") },
    );
    expect(resolved.descriptorSource).toBe("installed-catalog");
    expect(resolved.source).toMatchObject({
      repository: "affaan-m/ECC",
      commit: INITIAL_ECC_COMMIT,
      treeSha256: "2c516dd9d1f5d1e64c2a53bae23e4c09398b11b60a1e5e0963b6152fa73d6909",
    });

    const tampered = structuredClone(descriptor.adapterCompatibility);
    tampered.outcomes[0] = {
      ...tampered.outcomes[0]!,
      reason: "tampered",
    } as EccRuntimeAdapterOutcomeV1;
    expect(() =>
      // Exact legacy compatibility is accepted; arbitrary near-matches are not.
      assertHistoricalEccAdapterCompatibilityV1(tampered, descriptor.components),
    ).toThrow();
  });
});
