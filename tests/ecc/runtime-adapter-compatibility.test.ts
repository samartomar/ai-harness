import { describe, expect, it } from "vitest";
import {
  assertHistoricalEccAdapterCompatibilityV1,
  currentEccRuntimeAdapterCompatibilityV1,
} from "../../src/ecc/runtime-adapter-compatibility.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const COMPONENTS = [
  {
    id: "skill:renamed",
    kind: "skill",
    files: [{ path: "skills/renamed/SKILL.md", digest: DIGEST }],
  },
  {
    id: "module:rules-core",
    kind: "module",
    files: [{ path: "rules/common/testing.md", digest: DIGEST }],
  },
] as const;

describe("historical ECC runtime adapter compatibility", () => {
  it("binds the proof to every sealed regular file and shipped target outcome", () => {
    const proof = currentEccRuntimeAdapterCompatibilityV1(COMPONENTS);
    expect(proof.outcomes).toHaveLength(COMPONENTS.length * 6);
    expect(() => assertHistoricalEccAdapterCompatibilityV1(proof, COMPONENTS)).not.toThrow();
  });

  it("refuses an unsupported historical kind or source layout before source acquisition", () => {
    expect(() =>
      currentEccRuntimeAdapterCompatibilityV1([
        {
          id: "profile:methodology",
          kind: "profile",
          files: [{ path: "profiles/methodology", digest: DIGEST }],
        },
      ]),
    ).toThrow(/unsupported historical ECC component kind/i);
    expect(() =>
      currentEccRuntimeAdapterCompatibilityV1([
        {
          id: "skill:renamed",
          kind: "skill",
          files: [{ path: "legacy/../renamed/SKILL.md", digest: DIGEST }],
        },
      ]),
    ).toThrow(/invalid historical ECC source file/i);
  });

  it("uses the canonical repository-relative path grammar for verified files", () => {
    for (const path of ["C:/outside/SKILL.md", "skills/x:stream", "skills/../x/SKILL.md"]) {
      expect(() =>
        currentEccRuntimeAdapterCompatibilityV1([
          { id: "skill:renamed", kind: "skill", files: [{ path, digest: DIGEST }] },
        ]),
      ).toThrow(/invalid historical ECC source file/i);
    }
    expect(() =>
      currentEccRuntimeAdapterCompatibilityV1([
        {
          id: "skill:renamed",
          kind: "skill",
          files: [{ path: "skills/a.b/SKILL.md", digest: DIGEST }],
        },
      ]),
    ).not.toThrow();
  });

  it("records the closed Kiro refusal for an explicitly supported Kiro layout", () => {
    const proof = currentEccRuntimeAdapterCompatibilityV1([
      {
        id: "agent:historical-kiro",
        kind: "agent",
        files: [{ path: ".kiro/agents/historical-kiro.json", digest: DIGEST }],
      },
    ]);
    expect(proof.outcomes).toContainEqual({
      componentId: "agent:historical-kiro",
      path: ".kiro/agents/historical-kiro.json",
      target: "kiro",
      state: "refused",
      reason: "historical-kiro-runtime-proof-unavailable",
    });
  });
  it("records every target refusal for a safe verified file without rejecting the descriptor", () => {
    const proof = currentEccRuntimeAdapterCompatibilityV1([
      {
        id: "skill:harness-audit",
        kind: "skill",
        files: [{ path: "scripts/harness-audit.js", digest: DIGEST }],
      },
    ]);
    expect(proof.outcomes).toHaveLength(6);
    expect(proof.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "claude",
          state: "refused",
          reason: "unowned-destination",
        }),
        expect.objectContaining({
          target: "kiro",
          state: "refused",
          reason: "historical-kiro-runtime-proof-unavailable",
        }),
      ]),
    );
  });
  it("seals verified runtime inventory as explicit refusals without making it materializable", () => {
    const proof = currentEccRuntimeAdapterCompatibilityV1([
      {
        id: "runtime:ecc-installer",
        kind: "runtime",
        files: [{ path: "scripts/install.sh", digest: DIGEST }],
      },
    ]);
    expect(proof.outcomes).toHaveLength(6);
    expect(proof.outcomes.every((outcome) => outcome.state === "refused")).toBe(true);
  });
  it("refuses a proof generated for a different non-probe regular file", () => {
    const proof = currentEccRuntimeAdapterCompatibilityV1(COMPONENTS);
    const changed = [
      { ...COMPONENTS[0], files: [{ path: "skills/changed/SKILL.md", digest: DIGEST }] },
    ];
    expect(() => assertHistoricalEccAdapterCompatibilityV1(proof, changed)).toThrow(
      /adapter compatibility/i,
    );
  });
});
