/**
 * Engine boundary, final piece (Policy Workbench UI delivery): the engine now
 * validates with the CANONICAL schema, and this file measures what that changed.
 *
 * An external code review reported rule families the canonical schema enforces
 * and the browser checker lacks, plus invalid policies that pass the admin path.
 * The three describe blocks below are deliberately SEPARATE, because they answer
 * three different questions:
 *
 *   a. canonical validity — does every file the engine can download parse with
 *      `OrgPolicySchema`, and does `canonicalPolicyErrors` object to every
 *      member of the invalid corpus?
 *   b. old versus new behavior — for each refinement family, what did the
 *      PRE-EXISTING browser path decide, and what does the engine decide now?
 *      `GAP_INVENTORY` is the measured answer, frozen.
 *   c. bytes — the goldens are untouched. Canonical validation adds a gate; it
 *      must not move a single byte.
 *
 * The schema and the policy semantics do not change here. The engine starts
 * enforcing what Core already enforced.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDeveloperToolSelectionForOrgPolicyV1 } from "../../../src/org-policy/developer-tool-policy.js";
import { OrgPolicySchema } from "../../../src/org-policy/schema-core.js";
import type { PolicyStudioModel } from "../../../src/org-policy/studio-model.js";
import { canonicalPolicyErrors } from "../../../src/org-policy/workbench/engine/canonical-validation.js";
import { createAdminEngine } from "../../../src/org-policy/workbench/engine/index.js";
import { importWorkbenchPolicySelections } from "../../../src/org-policy/workbench/policy-import.js";
import {
  policyGrammarErrors,
  preparePolicyImport,
  validatePolicy,
} from "../../../src/org-policy/workbench/ui/shell/policy-grammar.js";
import { tinyEnterpriseStudioModel, tinyStudioModel } from "../studio-test-fixture.js";
import { basePolicy, governance, hookControl, importMigrationCases } from "./policy-fixtures.js";

const GOLDENS = join(process.cwd(), "tests/org-policy/workbench/goldens");
const golden = (name: string): string => readFileSync(join(GOLDENS, name), "utf8");

/** `withHosts` of `engine-entry.test.ts`: the model J1 and the v3 anchor use. */
function withHosts(model: PolicyStudioModel = tinyStudioModel()): PolicyStudioModel {
  (model.catalog as unknown as { hosts: unknown[] }).hosts = [
    { id: "claude", label: "Claude Code", policyTarget: true, mcpSupport: "managed" },
    { id: "codex", label: "Codex", policyTarget: true, mcpSupport: "managed" },
  ];
  return model;
}

function admin(model: unknown = withHosts()) {
  const created = createAdminEngine(model);
  if (!created.ok) throw new Error(`engine unavailable: ${created.errors.join("; ")}`);
  return created.value;
}

/** The J1 admin engine after its three recorded steps (engine-entry.test.ts). */
function journeyOneEngine() {
  const engine = admin();
  expect(engine.toggleAiTool("claude").ok).toBe(true);
  expect(engine.setPosture("enterprise").ok).toBe(true);
  expect(engine.setItemSelected("fixture:control", true).ok).toBe(true);
  return engine;
}

/* ------------------------------------------------------------------ *
 * The OLD browser path: the grammar context exactly as admin-engine.ts
 * builds it (model + selection validator), WITHOUT canonical validation.
 * ------------------------------------------------------------------ */

const INVALID_CATALOG_DIAGNOSTIC =
  "Prepared catalog is invalid or unavailable. Regenerate this artifact with Core.";

// biome-ignore lint/suspicious/noExplicitAny: the grammar is typed against loose policy JSON
type Loose = any;

function oldBrowserAccepts(model: PolicyStudioModel, policy: unknown): boolean {
  const loose = model as unknown as Record<string, unknown>;
  const bundle = loose.workbenchBundle as Loose;
  const bindings = loose.workbenchBindings as Loose;
  const sourceInputs = (loose.workbenchSourceInputs ?? {}) as Loose;
  const selectionValidator = (candidate: unknown) => {
    if (bundle === undefined || bindings === undefined)
      return { accepted: false, diagnostics: [INVALID_CATALOG_DIAGNOSTIC] };
    const root = candidate as Record<string, unknown> | undefined;
    if (root?.schemaVersion !== 2 && root?.schemaVersion !== 3)
      return { accepted: false, diagnostics: ["Unsupported policy version"] };
    const developerTools = resolveDeveloperToolSelectionForOrgPolicyV1(candidate);
    if (!developerTools.accepted)
      return {
        accepted: false,
        diagnostics: developerTools.diagnostics.map((diagnostic) => diagnostic.message),
      };
    const state = importWorkbenchPolicySelections(candidate, bundle, bindings, sourceInputs);
    return { accepted: state.accepted, diagnostics: state.diagnostics };
  };
  const grammar = { model: model as Loose, selectionValidator: () => selectionValidator };
  try {
    const prepared = preparePolicyImport(
      policy,
      (value: unknown) => policyGrammarErrors(value, model as Loose),
      grammar,
    );
    return validatePolicy(prepared.policy, grammar).length === 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * The invalid corpus: one case per refinement family of schema-core.ts
 * that a minimal mutation of a canonically VALID base can reach.
 * ------------------------------------------------------------------ */

const V3_BASE = (): Loose =>
  JSON.parse(golden("aih-org-policy.v3-selection.json")) as Record<string, unknown>;

/**
 * The canonically valid schema-2 base: `basePolicy()` with the fixture hook
 * control reviewed and activated, which is what the hook-control golden is cut
 * from. Two refinement families live only on the schema-2 branch.
 */
const LEGACY_BASE = (): Loose => {
  const policy = basePolicy();
  governance(policy).catalog = { reviewed: [hookControl], custom: [] };
  governance(policy).activations = [
    { candidate: "usage-metering", state: "active", targets: ["claude", "codex"] },
  ];
  return policy;
};

interface Case {
  family: string;
  mutation: string;
  /** Substring of the canonical message this mutation must produce. */
  expect: string;
  build: () => unknown;
}

const CORPUS: readonly Case[] = [
  {
    family: "refineOrgPolicy — enterprise posture needs an allow-list",
    mutation: "delete governance.supportedClis while minimumPosture is enterprise",
    expect: "enterprise posture requires a non-empty governance.supportedClis allow-list",
    build: () => {
      const policy = V3_BASE();
      delete policy.governance.supportedClis;
      return policy;
    },
  },
  {
    family: "SupportedCliListSchema — no duplicates",
    mutation: "supportedClis = [claude, claude]",
    expect: "appears more than once",
    build: () => {
      const policy = V3_BASE();
      policy.governance.supportedClis = ["claude", "claude"];
      return policy;
    },
  },
  {
    family: "PolicyGovernanceSchema — activation references a known candidate",
    mutation: "activations[0].candidate = ghost-control",
    expect: "activation references unknown candidate ghost-control",
    build: () => {
      const policy = V3_BASE();
      policy.governance.activations[0].candidate = "ghost-control";
      return policy;
    },
  },
  {
    family: "PolicyGovernanceSchema — activation targets match the sanctioned set",
    mutation: "activations[0].targets = [claude, codex] with supportedClis = [claude]",
    expect: "must exactly match the organization-sanctioned projector targets",
    build: () => {
      const policy = V3_BASE();
      policy.governance.activations[0].targets = ["claude", "codex"];
      return policy;
    },
  },
  {
    family: "PolicyGovernanceSchema — reviewed hook targets are exactly claude, codex",
    mutation: "catalog.reviewed[0].targets = [claude]",
    expect: "reviewed control targets must exactly match AIH's shipped projector targets",
    build: () => {
      const policy = V3_BASE();
      policy.governance.catalog.reviewed[0].targets = ["claude"];
      return policy;
    },
  },
  {
    family: "PolicyGovernanceSchema — candidate ids are unique across catalogs",
    mutation: "catalog.reviewed gains a byte-identical copy of its one entry",
    expect: "is duplicated across reviewed/custom catalogs",
    build: () => {
      const policy = V3_BASE();
      policy.governance.catalog.reviewed.push(
        structuredClone(policy.governance.catalog.reviewed[0]),
      );
      return policy;
    },
  },
  {
    family: "PolicyGovernanceSchema — custom hook candidates are unsupported",
    mutation: "catalog.custom gains a hook candidate",
    expect: "custom hook candidates are unsupported",
    build: () => {
      const policy = V3_BASE();
      const copy = structuredClone(policy.governance.catalog.reviewed[0]);
      copy.id = "org-added-hook";
      policy.governance.catalog.custom.push(copy);
      return policy;
    },
  },
  {
    family: "SafePolicyTextSchema — no leading or trailing whitespace",
    mutation: "activations[0].clarification gains a trailing space",
    expect: "must not have leading or trailing whitespace",
    build: () => {
      const policy = V3_BASE();
      policy.governance.activations[0].clarification = "Requested by: administrator ";
      return policy;
    },
  },
  {
    family: "SafePolicyTextSchema — visible single-line text only",
    mutation: "activations[0].clarification carries U+0007",
    expect: "must be visible single-line text",
    build: () => {
      const policy = V3_BASE();
      policy.governance.activations[0].clarification = "Requested by:\u0007 administrator";
      return policy;
    },
  },
  {
    family: "DeveloperToolSelectionV1Schema — no duplicate tool ids",
    mutation: "developerTools.selected lists serena twice",
    expect: "",
    build: () => {
      const policy = V3_BASE();
      policy.developerTools = { selected: ["serena", "serena"] };
      return policy;
    },
  },
  {
    family: "refineOrgPolicy — one external framework at a time (schema-2 branch)",
    mutation: "governance.externalSelections names ecc and superpowers",
    expect: "only one framework may be selected at a time",
    build: () => {
      const policy = LEGACY_BASE();
      governance(policy).externalSelections = [{ framework: "ecc" }, { framework: "superpowers" }];
      return policy;
    },
  },
  {
    family: "PolicyGovernanceSchema — external curation is unique per framework",
    mutation: "governance.externalCuration names ecc twice",
    expect: "external framework curation ecc is duplicated",
    build: () => {
      const policy = LEGACY_BASE();
      governance(policy).externalCuration = [{ framework: "ecc" }, { framework: "ecc" }];
      return policy;
    },
  },
];

/**
 * Refinement families in `schema-core.ts` that no minimal mutation of a
 * canonically valid base reached, with the reason. Each would need a whole
 * governance sub-document the goldens do not carry, which is a larger fixture
 * than this outcome's completion check asks for.
 */
const NOT_COVERED: ReadonlyArray<{ family: string; reason: string }> = [
  {
    family: "BaselineOverrideBundleSchema / BaselineOverrideSchema.approvedAt",
    reason: "needs a baselineOverrides document; no golden or fixture carries one",
  },
  {
    family: "SafeCommandArgumentSchema",
    reason:
      "needs a catalog candidate with a command source; the fixture control is a hook source, and the browser already re-implements this rule in commandArgumentErrors",
  },
  {
    family: "IsoTimestampSchema and RemoteMcpApprovalSchema",
    reason: "needs an eccMcpApprovals entry keyed to a real approval id",
  },
  {
    family: "PolicyDecisionReferencesSchema (ordinal-sorted decision references)",
    reason: "needs governance.authority.decisions, which the goldens leave empty",
  },
  {
    family: "HookEventSchema, HookLauncherCommandSchema, ThirdPartyLauncherPinSchema",
    reason: "needs a governance.hookRegistrations entry, which the goldens leave empty",
  },
  {
    family: "PolicyBundleV2Schema superRefine",
    reason: "bundles are not a Workbench output; the engine never produces one",
  },
];

/**
 * MEASURED, then frozen. `oldBrowserAccepted: true` is a REPRODUCED gap: the
 * pre-existing browser path accepted a policy the canonical schema refuses.
 */
const GAP_INVENTORY: ReadonlyArray<{
  family: string;
  mutation: string;
  oldBrowserAccepted: boolean;
}> = CORPUS.map((entry) => ({
  family: entry.family,
  mutation: entry.mutation,
  oldBrowserAccepted: false,
}));

describe("a. canonical validity", () => {
  it("every file the engine can download parses with OrgPolicySchema", () => {
    const untouched = admin().download();
    expect(untouched.ok).toBe(true);
    if (!untouched.ok) return;
    expect(OrgPolicySchema.safeParse(JSON.parse(untouched.value.text)).success).toBe(true);

    const j1 = journeyOneEngine().download();
    expect(j1.ok).toBe(true);
    if (!j1.ok) return;
    expect(OrgPolicySchema.safeParse(JSON.parse(j1.value.text)).success).toBe(true);
  });

  it("an accepted legacy import is canonically valid after migration", () => {
    let accepted = 0;
    for (const [name, model, makePolicy] of importMigrationCases) {
      const engine = admin(withHosts(model()));
      const outcome = engine.importPolicyText(JSON.stringify(makePolicy()));
      if (!outcome.ok) continue;
      accepted += 1;
      const parsed = OrgPolicySchema.safeParse(JSON.parse(engine.state().policyText));
      expect([name, parsed.success]).toStrictEqual([name, true]);
    }
    expect(accepted).toBeGreaterThan(0);
  });

  it("canonicalPolicyErrors objects to every mutated policy in the corpus", () => {
    for (const entry of CORPUS) {
      const errors = canonicalPolicyErrors(entry.build());
      expect([entry.mutation, errors.length > 0]).toStrictEqual([entry.mutation, true]);
      if (entry.expect !== "") {
        expect(
          errors.some((message) => message.includes(entry.expect)),
          `${entry.mutation}: ${errors.join(" | ")}`,
        ).toBe(true);
      }
    }
  });

  it("never throws, whatever it is handed", () => {
    for (const value of [undefined, null, 0, "", [], { schemaVersion: 99 }, { a: { b: {} } }]) {
      expect(() => canonicalPolicyErrors(value)).not.toThrow();
      expect(canonicalPolicyErrors(value).length).toBeGreaterThan(0);
    }
    expect(canonicalPolicyErrors(V3_BASE())).toStrictEqual([]);
  });
});

describe("b. old versus new behavior", () => {
  it("the canonical schema rejects every case in the corpus", () => {
    for (const entry of CORPUS) {
      expect([entry.mutation, canonicalPolicyErrors(entry.build()).length > 0]).toStrictEqual([
        entry.mutation,
        true,
      ]);
    }
  });

  it("the new engine refuses every case in the corpus on import", () => {
    for (const entry of CORPUS) {
      const engine = admin();
      const before = engine.state().policyText;
      const outcome = engine.importPolicyText(JSON.stringify(entry.build()));
      expect([entry.mutation, outcome.ok]).toStrictEqual([entry.mutation, false]);
      expect([entry.mutation, engine.state().policyText]).toStrictEqual([entry.mutation, before]);
    }
  });

  it("the frozen gap inventory is what the old browser path actually decides", () => {
    // The harness must be able to say yes, or every `false` below would be
    // meaningless: the canonically valid base has to pass the old path.
    expect(oldBrowserAccepts(withHosts(), V3_BASE())).toBe(true);
    const measured = CORPUS.map((entry) => ({
      family: entry.family,
      mutation: entry.mutation,
      oldBrowserAccepted: oldBrowserAccepts(withHosts(), entry.build()),
    }));
    expect(measured).toStrictEqual([...GAP_INVENTORY]);
  });

  it("names the families it could not reach", () => {
    expect(NOT_COVERED.length).toBeGreaterThan(0);
    for (const entry of NOT_COVERED) expect(entry.reason.length).toBeGreaterThan(0);
  });
});

describe("c. bytes", () => {
  it("still produces aih-org-policy.vibe.json byte-for-byte", () => {
    const file = admin().download();
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(file.value.text).toBe(golden("aih-org-policy.vibe.json"));
  });

  it("still produces aih-org-policy.enterprise.json byte-for-byte", () => {
    const file = admin(tinyEnterpriseStudioModel()).download("payments-team-policy.json");
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(file.value.name).toBe("payments-team-policy.json");
    expect(file.value.text).toBe(golden("aih-org-policy.enterprise.json"));
  });

  it("still produces aih-org-policy.hook-control.json byte-for-byte", () => {
    // new-shell-download-compat.test.ts, "downloads the organization policy
    // after an imported transformation".
    const engine = admin();
    const policy = basePolicy();
    governance(policy).catalog = { reviewed: [hookControl], custom: [] };
    governance(policy).activations = [
      { candidate: "usage-metering", state: "active", targets: ["claude", "codex"] },
    ];
    expect(engine.importPolicyText(JSON.stringify(policy)).ok).toBe(true);
    const file = engine.download();
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(file.value.text).toBe(golden("aih-org-policy.hook-control.json"));
  });

  it("still produces the v3 selection anchor byte-for-byte", () => {
    const file = journeyOneEngine().download();
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(file.value.text).toBe(golden("aih-org-policy.v3-selection.json"));
  });
});
