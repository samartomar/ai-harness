import { describe, expect, it } from "vitest";
import {
  currentEccRuntimeAdapterCompatibilityV1,
  type EccRuntimeAdapterOutcomeV1,
} from "../../src/ecc/runtime-adapter-compatibility.js";
import { resolveHistoricalEccRuntimeDescriptorV1 } from "../../src/ecc/runtime-descriptor-resolver.js";
import { packagedEccRuntimeDescriptorsV1 } from "../../src/org-policy/workbench/core/packaged-source-data.js";

const INITIAL_ECC_COMMIT = "5064474d4d762dc9640234a41617cccb79185cec";

describe("packaged historical ECC runtime delivery", () => {
  it("resolves the unchanged initial Workbench export source", () => {
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
    expect(mismatches.slice(0, 20)).toEqual([]);

    const resolved = resolveHistoricalEccRuntimeDescriptorV1(
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
      { now: "2026-09-13T19:45:00.000Z" },
    );

    expect(resolved.source).toMatchObject({
      repository: "affaan-m/ECC",
      commit: INITIAL_ECC_COMMIT,
      treeSha256: "2c516dd9d1f5d1e64c2a53bae23e4c09398b11b60a1e5e0963b6152fa73d6909",
    });
  });
});
