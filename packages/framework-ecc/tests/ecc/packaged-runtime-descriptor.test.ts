import "../core-invocation.js";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalStrictJsonBytesV1 } from "@aihq/core/framework-host";
import { describe, expect, it } from "vitest";
import { packagedEccRuntimeDescriptorsV1 } from "../../../../src/org-policy/workbench/core/packaged-source-data.js";
import {
  assertHistoricalEccAdapterCompatibilityV1,
  currentEccRuntimeAdapterCompatibilityV1,
  type EccRuntimeAdapterCompatibilityV1,
  type EccRuntimeAdapterOutcomeV1,
} from "../../src/ecc/runtime-adapter-compatibility.js";
import { resolveHistoricalEccRuntimeDescriptorV1 } from "../../src/ecc/runtime-descriptor-resolver.js";

/** The one ECC runtime descriptor the Catalog carries: the current pin (D70: one current copy). */
const CURRENT_ECC_COMMIT = "5064474d4d762dc9640234a41617cccb79185cec";
/**
 * SYNTHETIC: not an ECC commit. The Catalog keeps no historical ECC descriptor,
 * so the historical-route property is proven on a descriptor derived from the
 * current one with only its pin and its sealed destinations changed.
 */
const SYNTHETIC_HISTORICAL_ECC_COMMIT = "5e1f00000000000000000000000000000000c0de";

function currentDescriptor() {
  const descriptor = packagedEccRuntimeDescriptorsV1().find(
    (candidate) => candidate.source.commit === CURRENT_ECC_COMMIT,
  );
  if (!descriptor) throw new Error("packaged current ECC descriptor is required");
  return descriptor;
}

/**
 * The destinations the v1 materialization contract sealed before Codex agents
 * became `.toml` roles: Codex agents and core commands as project Markdown, and
 * the audit scripts unowned. Every other outcome is the current adapter's.
 */
function v1SealedOutcome(outcome: EccRuntimeAdapterOutcomeV1): EccRuntimeAdapterOutcomeV1 {
  const { componentId, path, target } = outcome;
  const coreCommands =
    componentId === "baseline:commands" || componentId === "module:commands-core";
  if (target === "codex" && path.startsWith("agents/") && path.endsWith(".md"))
    return {
      componentId,
      path,
      target,
      state: "mapped",
      scope: "project",
      relative: `.codex/agents/${path.slice("agents/".length)}`,
    };
  if (target === "codex" && coreCommands && path.startsWith("commands/") && path.endsWith(".md"))
    return {
      componentId,
      path,
      target,
      state: "mapped",
      scope: "project",
      relative: `.codex/commands/${path.slice("commands/".length)}`,
    };
  if (
    target !== "kiro" &&
    coreCommands &&
    (path === "scripts/harness-audit.js" ||
      path === "scripts/skills-health.js" ||
      path.startsWith("scripts/lib/"))
  )
    return { componentId, path, target, state: "refused", reason: "unowned-destination" };
  return outcome;
}

function syntheticHistoricalDescriptor() {
  const descriptor = structuredClone(currentDescriptor());
  descriptor.source.commit = SYNTHETIC_HISTORICAL_ECC_COMMIT;
  const current = currentEccRuntimeAdapterCompatibilityV1(descriptor.components);
  const contract = {
    contractVersion: current.contractVersion,
    relationContract: "compiled-requires-members-and-riders/v1",
    targets: [...current.targets],
    outcomes: current.outcomes.map(v1SealedOutcome),
  };
  const sealed: EccRuntimeAdapterCompatibilityV1 = {
    contractVersion: contract.contractVersion,
    contractDigest: `sha256:${createHash("sha256").update(canonicalStrictJsonBytesV1(contract)).digest("hex")}`,
    targets: contract.targets,
    outcomes: contract.outcomes,
  };
  descriptor.adapterCompatibility = sealed as typeof descriptor.adapterCompatibility;
  return descriptor;
}

describe("packaged historical ECC runtime delivery", () => {
  it("seals the current ECC descriptor with this Core's current adapter", () => {
    const descriptor = currentDescriptor();
    expect(descriptor.adapterCompatibility).toEqual(
      currentEccRuntimeAdapterCompatibilityV1(descriptor.components),
    );
  });

  it("resolves unchanged historical routes while retaining their exact sealed destinations (synthetic historical descriptor)", () => {
    const descriptor = syntheticHistoricalDescriptor();
    const current = currentEccRuntimeAdapterCompatibilityV1(descriptor.components);
    const outcomeKey = (outcome: EccRuntimeAdapterOutcomeV1) =>
      `${outcome.componentId}\0${outcome.path}\0${outcome.target}`;
    const actualByKey = new Map(
      descriptor.adapterCompatibility.outcomes.map((outcome) => [outcomeKey(outcome), outcome]),
    );
    const mismatches = current.outcomes.filter(
      (outcome) => JSON.stringify(outcome) !== JSON.stringify(actualByKey.get(outcomeKey(outcome))),
    );
    // Today's adapter maps Codex agents elsewhere than the historical seal did...
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
    // ...yet the exact historical seal is still accepted, destinations unchanged.
    expect(() =>
      assertHistoricalEccAdapterCompatibilityV1(
        descriptor.adapterCompatibility as EccRuntimeAdapterCompatibilityV1,
        descriptor.components,
      ),
    ).not.toThrow();

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

  it("delivers the sealed descriptor bytes through the installed Catalog", async () => {
    const resolved = await resolveHistoricalEccRuntimeDescriptorV1(
      {
        governance: {
          externalSelections: [
            {
              framework: "ecc",
              items: [{ source: { repository: "affaan-m/ECC", commit: CURRENT_ECC_COMMIT } }],
            },
          ],
        },
      },
      // After the current descriptor's custody attestation (2026-09-25) and before its expiry.
      { now: "2026-10-01T00:00:00.000Z", dataRoot: join(tmpdir(), "aih-absent-workbench-data-v1") },
    );
    expect(resolved.descriptorSource).toBe("installed-catalog");
    expect(resolved.source).toMatchObject({
      repository: "affaan-m/ECC",
      commit: CURRENT_ECC_COMMIT,
      treeSha256: "2c516dd9d1f5d1e64c2a53bae23e4c09398b11b60a1e5e0963b6152fa73d6909",
    });
  });
});
