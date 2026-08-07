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
 * F3: "One framework per policy (ruling 7); the lifecycle inherits the
 * schema's exclusivity, never re-implements it."
 *
 * The schema's own rule lives at `src/org-policy/schema.ts` (the
 * `distinctSelection.length > 1` check inside `PolicyGovernanceSchema`'s
 * `superRefine`, exercised through `parseOrgPolicy`). This suite does not
 * touch that file or restate its logic. It pins three things about the
 * lifecycle side instead:
 *
 * 1. A policy selecting from two frameworks never survives long enough to
 *    reach the F2 resolver — `parseOrgPolicy` refuses it first, with the
 *    schema's own message. (If the schema rule is ever weakened or removed,
 *    this test fails too — it does not hold its own copy of the check.)
 * 2. A positive control: an ordinary single-framework policy runs the full
 *    chain — parse, resolve-effective, resolve-selection, materialize — and
 *    the component actually lands on disk. This is what proves test 1 isn't
 *    vacuously passing because the chain is broken end to end.
 * 3. The resolver's own code has no framework-comparison branch to remove:
 *    fed a two-framework input directly (the only way to observe this, since
 *    step 1 proves no real policy ever reaches it that way), it filters
 *    purely by evidence, and the engine beneath it — which never receives a
 *    framework label at all, see `EccEffectiveSelectionComponent` — has
 *    nothing to check either. That is the "never re-implements it" half made
 *    observable: there is no second gate anywhere below the schema to find.
 */

const COMMIT = "a".repeat(40);
const REPOSITORY = "affaan-m/ECC";
const ONE_FRAMEWORK_MESSAGE = /only one framework may be selected at a time.*ecc and superpowers/;

function governedPolicy(governance: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    minimumPosture: "team",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "2026-08-07.1",
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
    issuer: "@aihq/harness release",
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

describe("F3 — the lifecycle inherits the schema's one-framework-per-policy rule", () => {
  it("POSITIVE CONTROL: a single-framework policy resolves through the full chain and materializes", () => {
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

  it("refuses a policy selecting from two frameworks before the lifecycle resolver ever runs, with the schema's own message", () => {
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

  it("the resolver carries no framework-comparison logic of its own, and neither does the engine beneath it", () => {
    // The schema's superRefine is the only reason a caller never builds the
    // input used below from a real policy (proven by the test above). Built
    // directly here, bypassing parseOrgPolicy entirely, purely to show that
    // nothing at THIS layer would catch it either — so if this test ever
    // starts failing because someone added a framework check inside
    // resolveEccMaterializationSelection, that is a second implementation of
    // ruling 7 growing where F3 says none may exist.
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
    expect(result.included.map((component) => component.id).sort()).toEqual(
      [eccItem.id, spItem.id].sort(),
    );
    // EccEffectiveSelectionComponent (the `included` shape) carries no
    // `framework` field — by the time evidence has passed, the engine below
    // has no framework label left to check even if it wanted to.
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

      // Both land — the engine has no framework dimension to refuse on.
      expect(existsSync(join(root, ECC_PATH))).toBe(true);
      expect(existsSync(join(root, SP_PATH))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
