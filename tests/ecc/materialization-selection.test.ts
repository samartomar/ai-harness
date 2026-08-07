import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  BaselineAuthorization,
  BaselineHeldComponent,
} from "../../src/baseline-evidence/verify.js";
import {
  applyEccMaterialization,
  type EccMaterializationComponentInput,
  type EccMaterializationFileInput,
} from "../../src/ecc/materialization.js";
import {
  type EccSelectionEvidence,
  resolveEccMaterializationSelection,
} from "../../src/ecc/materialization-selection.js";
import type { EffectiveOrgPolicy } from "../../src/org-policy/effective.js";

interface SelectionItemFixture {
  kind: string;
  id: string;
  source: { repository: string; commit: string; path: string };
}

const COMMIT = "a".repeat(40);
const REPOSITORY = "affaan-m/ECC";

function selectionItem(kind: string, suffix: string, path?: string): SelectionItemFixture {
  return {
    kind,
    id: `${kind}:${suffix}`,
    source: { repository: REPOSITORY, commit: COMMIT, path: path ?? `${kind}s/${suffix}` },
  };
}

function policyWith(
  items: readonly SelectionItemFixture[],
  framework: "ecc" | "superpowers" = "ecc",
): Pick<EffectiveOrgPolicy, "externalSelections"> {
  return {
    externalSelections: [{ framework, items: [...items], status: "requested-evidence-needed" }],
  };
}

function authorization(
  componentId: string,
  overrides: Partial<BaselineAuthorization> = {},
): BaselineAuthorization {
  return {
    componentId,
    source: REPOSITORY,
    pinnedSha: COMMIT,
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/harness release",
    evidenceSha256: "c".repeat(64),
    ...overrides,
  };
}

function held(
  componentId: string,
  routeCode: BaselineHeldComponent["routeCode"],
  codes: string[],
  detail: string,
): BaselineHeldComponent {
  return { componentId, routeCode, codes, details: [detail] };
}

describe("resolveEccMaterializationSelection", () => {
  it("includes a component whose evidence passed, carrying its authorization tuple and provenance unchanged", () => {
    const item = selectionItem("skill", "tdd-workflow");
    const auth = authorization(item.id);

    const result = resolveEccMaterializationSelection(policyWith([item]), {
      authorizations: [auth],
      held: [],
    });

    expect(result.excluded).toEqual([]);
    expect(result.included).toEqual([
      {
        id: item.id,
        authorization: auth,
        provenance: {
          repository: item.source.repository,
          commit: item.source.commit,
          componentPath: item.source.path,
        },
      },
    ]);
  });

  it("excludes a vet-blocked component with its findings, and never includes it", () => {
    const item = selectionItem("agent", "code-reviewer");
    const heldEntry = held(
      item.id,
      "baseline.evidence-blocked",
      ["malicious-code", "secrets"],
      "agent:code-reviewer is blocked by signed evidence (malicious-code, secrets)",
    );

    const result = resolveEccMaterializationSelection(policyWith([item]), {
      authorizations: [],
      held: [heldEntry],
    });

    expect(result.included).toEqual([]);
    expect(result.excluded).toEqual([
      {
        id: item.id,
        kind: "agent",
        framework: "ecc",
        reason: "vet-blocked",
        findingCodes: ["malicious-code", "secrets"],
        detail: "agent:code-reviewer is blocked by signed evidence (malicious-code, secrets)",
      },
    ]);
  });

  it("excludes a component with no evidence at the pin, with a reason distinct from vet-blocked", () => {
    const heldMissing = selectionItem("skill", "verification-loop");
    const neverVetted = selectionItem("skill", "never-vetted");
    const heldEntry = held(
      heldMissing.id,
      "baseline.evidence-missing",
      ["baseline.evidence-missing"],
      "affaan-m/ECC@aaaaaaaaaaaa component skill:verification-loop is not covered by vendor or org evidence",
    );

    const result = resolveEccMaterializationSelection(policyWith([heldMissing, neverVetted]), {
      authorizations: [],
      held: [heldEntry],
    });

    expect(result.included).toEqual([]);
    expect(result.excluded).toEqual([
      {
        id: heldMissing.id,
        kind: "skill",
        framework: "ecc",
        reason: "no-evidence",
        findingCodes: ["baseline.evidence-missing"],
        detail: heldEntry.details.join("; "),
      },
      {
        id: neverVetted.id,
        kind: "skill",
        framework: "ecc",
        reason: "no-evidence",
        findingCodes: [],
        detail: `no evidence recorded for ${neverVetted.id} at ${REPOSITORY}@${COMMIT.slice(0, 12)}`,
      },
    ]);
    expect(result.excluded.every((entry) => entry.reason !== "vet-blocked")).toBe(true);
  });

  it("includes accepted-with-conditions evidence like a plain pass, preserving the acceptance record", () => {
    const item = selectionItem("skill", "accepted-example");
    const auth = authorization(item.id, {
      effective: "accepted-with-conditions",
      acceptance: {
        decisionId: "decision-1",
        recordSha256: "d".repeat(64),
        acceptedFindingCodes: ["unpinned-source"],
      },
    });

    const result = resolveEccMaterializationSelection(policyWith([item]), {
      authorizations: [auth],
      held: [],
    });

    expect(result.excluded).toEqual([]);
    expect(result.included).toEqual([
      {
        id: item.id,
        authorization: auth,
        provenance: {
          repository: item.source.repository,
          commit: item.source.commit,
          componentPath: item.source.path,
        },
      },
    ]);
    expect(result.included[0]?.authorization.effective).toBe("accepted-with-conditions");
  });

  it("fails closed when evidence is self-contradictory, never defaulting to passed", () => {
    const item = selectionItem("skill", "contradictory");
    const auth = authorization(item.id);
    const heldEntry = held(
      item.id,
      "baseline.evidence-blocked",
      ["secrets"],
      "skill:contradictory is blocked by signed evidence (secrets)",
    );

    const result = resolveEccMaterializationSelection(policyWith([item]), {
      authorizations: [auth],
      held: [heldEntry],
    });

    expect(result.included).toEqual([]);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.reason).toBe("malformed-evidence");
    expect(result.excluded[0]?.findingCodes).toEqual(["secrets"]);
  });

  it("fails closed on a selection source path the materialization engine cannot accept", () => {
    const item: SelectionItemFixture = {
      kind: "skill",
      id: "skill:bad-path",
      source: { repository: REPOSITORY, commit: COMMIT, path: "skills/weird:name" },
    };
    const auth = authorization(item.id);

    const result = resolveEccMaterializationSelection(policyWith([item]), {
      authorizations: [auth],
      held: [],
    });

    expect(result.included).toEqual([]);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.reason).toBe("malformed-selection");
  });

  it("fails closed when a selection's kind does not match its component id", () => {
    const item: SelectionItemFixture = {
      kind: "skill",
      id: "agent:code-reviewer",
      source: { repository: REPOSITORY, commit: COMMIT, path: "agents/code-reviewer" },
    };
    const auth = authorization(item.id);

    const result = resolveEccMaterializationSelection(policyWith([item]), {
      authorizations: [auth],
      held: [],
    });

    expect(result.included).toEqual([]);
    expect(result.excluded[0]?.reason).toBe("malformed-selection");
  });

  it("returns nothing for a policy with no external selections", () => {
    const result = resolveEccMaterializationSelection(
      { externalSelections: [] },
      {
        authorizations: [],
        held: [],
      },
    );
    expect(result).toEqual({ included: [], excluded: [] });
  });
});

describe("resolveEccMaterializationSelection driven against the real materialization engine", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aih-ecc-materialization-selection-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("never materializes a vet-blocked or no-evidence component, even though both are present in the selection", () => {
    const passItem = selectionItem("skill", "tdd-workflow");
    const blockedItem = selectionItem("agent", "code-reviewer");
    const missingItem = selectionItem("skill", "verification-loop");

    const evidence: EccSelectionEvidence = {
      authorizations: [authorization(passItem.id)],
      held: [
        held(
          blockedItem.id,
          "baseline.evidence-blocked",
          ["malicious-code"],
          "agent:code-reviewer is blocked by signed evidence (malicious-code)",
        ),
        held(
          missingItem.id,
          "baseline.evidence-missing",
          ["baseline.evidence-missing"],
          "skill:verification-loop is not covered by vendor or org evidence",
        ),
      ],
    };

    const result = resolveEccMaterializationSelection(
      policyWith([passItem, blockedItem, missingItem]),
      evidence,
    );

    // Proving the filter in isolation first: exactly the passed component
    // reaches `included`; the other two are reported, not dropped.
    expect(result.included.map((component) => component.id)).toEqual([passItem.id]);
    expect(result.excluded.map((entry) => ({ id: entry.id, reason: entry.reason }))).toEqual([
      { id: blockedItem.id, reason: "vet-blocked" },
      { id: missingItem.id, reason: "no-evidence" },
    ]);

    // Not enough on its own — drive the real engine with exactly what the
    // resolver produced, and prove the excluded components' bytes never land.
    const PASS_PATH = ".claude/skills/tdd-workflow/SKILL.md";
    const BLOCKED_PATH = ".claude/agents/code-reviewer.md";
    const MISSING_PATH = ".claude/skills/verification-loop/SKILL.md";
    const filesById = new Map<string, EccMaterializationFileInput[]>([
      [passItem.id, [{ path: PASS_PATH, kind: "copy-file", contents: "# tdd-workflow\n" }]],
      [blockedItem.id, [{ path: BLOCKED_PATH, kind: "copy-file", contents: "# code-reviewer\n" }]],
      [
        missingItem.id,
        [{ path: MISSING_PATH, kind: "copy-file", contents: "# verification-loop\n" }],
      ],
    ]);
    const components: EccMaterializationComponentInput[] = result.included.map((component) => ({
      ...component,
      files: filesById.get(component.id) ?? [],
    }));

    applyEccMaterialization({ root, components });

    expect(existsSync(join(root, PASS_PATH))).toBe(true);
    expect(existsSync(join(root, BLOCKED_PATH))).toBe(false);
    expect(existsSync(join(root, MISSING_PATH))).toBe(false);
  });
});
