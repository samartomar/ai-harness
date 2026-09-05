import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BaselineAuthorization } from "../../src/baseline-evidence/verify.js";
import {
  applyEccMaterialization,
  type EccMaterializationComponentInput,
} from "../../src/ecc/materialization.js";
import {
  type EccSelectionEvidence,
  resolveEccMaterializationSelection,
} from "../../src/ecc/materialization-selection.js";
import {
  type EffectiveOrgPolicy,
  resolveEffectiveOrgPolicy,
} from "../../src/org-policy/effective.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";

/**
 * F3 V2 compatibility preserves the old one-framework parsing rule. Schema
 * V3 permits portable source identity across owners, so the ECC materializer
 * has a separate, supported routing responsibility: it consumes only ECC
 * external selections and never treats other frameworks as ECC components.
 *
 * This suite keeps both facts visible:
 *
 * 1. Historical V2 mixed-framework policies still fail in the schema before
 *    effective resolution or materialization.
 * 2. A V2 ECC-only policy still traverses parse, effective resolution,
 *    selection, and materialization to an on-disk component.
 * 3. A mixed selection supplied directly to the scoped resolver yields only
 *    the ECC item. Superpowers input is ignored by this ECC pipeline and is
 *    never materialized into its destination.
 */

const COMMIT = "a".repeat(40);
const REPOSITORY = "affaan-m/ECC";
const ONE_FRAMEWORK_MESSAGE = /only one framework may be selected at a time.*ecc and superpowers/;

function governedPolicy(governance: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "2026-08-07.1",
      supportedClis: ["claude"],
      catalog: { reviewed: [], custom: [] },
      ...governance,
    },
  };
}

function selectionItem(kind: string, suffix: string) {
  return {
    kind,
    id: `${kind}:${suffix}`,
    source: { repository: REPOSITORY, commit: COMMIT, path: `${kind}s/${suffix}` },
  };
}

function authorization(componentId: string): BaselineAuthorization {
  return {
    componentId,
    source: REPOSITORY,
    pinnedSha: COMMIT,
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/core release",
    evidenceSha256: "c".repeat(64),
  };
}

/**
 * The real lifecycle entry sequence a caller wires: parse the authored
 * policy, resolve it into an EffectiveOrgPolicy, then resolve the
 * evidence-passed selection F1's materialization engine consumes. Used so
 * the refusal test and the positive-control test exercise the identical
 * path — the only difference between them is the input.
 */
function resolveLifecycleSelection(
  rawPolicy: Record<string, unknown>,
  evidence: EccSelectionEvidence,
) {
  const policy = parseOrgPolicy(rawPolicy);
  const effective: EffectiveOrgPolicy = resolveEffectiveOrgPolicy(policy);
  return resolveEccMaterializationSelection(effective, evidence);
}

describe("F3 — V2 compatibility and ECC-scoped materialization routing", () => {
  it("V2 compatibility: an ECC-only policy resolves through the full chain and materializes", () => {
    const item = selectionItem("skill", "tdd-workflow");

    const result = resolveLifecycleSelection(
      governedPolicy({ externalSelections: [{ framework: "ecc", items: [item] }] }),
      { authorizations: [authorization(item.id)], held: [] },
    );

    expect(result.excluded).toEqual([]);
    expect(result.included.map((component) => component.id)).toEqual([item.id]);

    const root = mkdtempSync(join(tmpdir(), "aih-ecc-framework-exclusivity-"));
    try {
      const PATH = ".claude/skills/tdd-workflow/SKILL.md";
      const components: EccMaterializationComponentInput[] = result.included.map((component) => ({
        ...component,
        files: [{ path: PATH, kind: "copy-file" as const, contents: "# tdd-workflow\n" }],
      }));

      applyEccMaterialization({ root, components });

      expect(existsSync(join(root, PATH))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("V2 compatibility: refuses a policy selecting from two frameworks before the lifecycle resolver runs", () => {
    const rawPolicy = governedPolicy({
      externalSelections: [
        { framework: "ecc", items: [] },
        { framework: "superpowers", items: [] },
      ],
    });

    expect(() => parseOrgPolicy(rawPolicy)).toThrowError(ONE_FRAMEWORK_MESSAGE);

    // Same call, driven through the full lifecycle chain: it throws at the
    // identical step, for the identical reason, before resolveEffectiveOrgPolicy
    // or resolveEccMaterializationSelection ever execute. F2/F1 see nothing.
    expect(() =>
      resolveLifecycleSelection(rawPolicy, { authorizations: [], held: [] }),
    ).toThrowError(ONE_FRAMEWORK_MESSAGE);
  });

  it("routes only ECC selections into the ECC materializer and ignores Superpowers", () => {
    // V3 permits source identity across owners. This resolver is intentionally
    // an ECC-only route, so a direct mixed input proves its routing boundary
    // without treating source ownership as a methodology conflict.
    const eccItem = selectionItem("skill", "tdd-workflow");
    const spItem = selectionItem("skill", "brainstorming");
    const evidence: EccSelectionEvidence = {
      authorizations: [authorization(eccItem.id), authorization(spItem.id)],
      held: [],
    };

    const result = resolveEccMaterializationSelection(
      {
        externalSelections: [
          { framework: "ecc", items: [eccItem], status: "requested-evidence-needed" },
          { framework: "superpowers", items: [spItem], status: "requested-evidence-needed" },
        ],
      },
      evidence,
    );

    expect(result.excluded).toEqual([]);
    expect(result.included.map((component) => component.id)).toEqual([eccItem.id]);
    // Included components are already ECC-scoped; the materializer receives
    // no Superpowers component to write.
    expect(Object.keys(result.included[0] ?? {}).sort()).toEqual(
      ["authorization", "id", "provenance"].sort(),
    );

    const root = mkdtempSync(join(tmpdir(), "aih-ecc-framework-exclusivity-engine-"));
    try {
      const ECC_PATH = ".claude/skills/tdd-workflow/SKILL.md";
      const SP_PATH = ".claude/skills/brainstorming/SKILL.md";
      const filesById = new Map([
        [eccItem.id, ECC_PATH],
        [spItem.id, SP_PATH],
      ]);
      const components: EccMaterializationComponentInput[] = result.included.map((component) => ({
        ...component,
        files: [
          {
            path: filesById.get(component.id) ?? "",
            kind: "copy-file" as const,
            contents: `# ${component.id}\n`,
          },
        ],
      }));

      applyEccMaterialization({ root, components });

      expect(existsSync(join(root, ECC_PATH))).toBe(true);
      expect(existsSync(join(root, SP_PATH))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
