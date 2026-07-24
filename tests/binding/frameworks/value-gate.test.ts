import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoMachineLocalPath,
  buildFrameworkCard,
  type FrameworkCardBuildInput,
  type FrameworkValueCard,
  FrameworkValueCardSchema,
  parseFrameworkCard,
  renderFrameworkCard,
} from "../../../src/binding/card.js";
import { measureCostGateVariant } from "../../../src/binding/frameworks/cost-gate.js";
import {
  buildFrameworkValueRecord,
  type CharacteristicWorkflowResult,
  DEFAULT_VALUE_THRESHOLDS,
  type FrameworkSurfaceMeasurement,
  measureFrameworkSurfaces,
} from "../../../src/binding/frameworks/value-gate.js";
import { ClaudeHostWriteError } from "../../../src/binding/hosts/claude/surfaces.js";
import type { BindingSource } from "../../../src/binding/schema.js";

// -- fixtures ---------------------------------------------------------------

type Counts = FrameworkSurfaceMeasurement["counts"];

function counts(overrides: Partial<Counts> = {}): Counts {
  return { skills: 0, agents: 0, commands: 0, rules: 0, hooks: 0, mcpServers: 0, ...overrides };
}

/** A framework surface measurement with the given non-zero counts (rest zero). */
function surfaces(
  overrides: Partial<Counts> = {},
  managedBlock: 0 | 1 = 0,
): FrameworkSurfaceMeasurement {
  return { counts: counts(overrides), managedBlock, evidence: "aih static tree measurement" };
}

const BASELINE_CLEAN = surfaces();
const WORKFLOW_OK: CharacteristicWorkflowResult = {
  name: "ecc-review",
  succeeded: true,
  baselineAbsent: true,
  evidence: "check-11 transcript ecc-review",
};
const COST_OK = { tokens: 80129, verdict: "within-budget" as const };
const IDENTITY = { framework: "ecc" as const, mode: "lean" as const };

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "aih-value-gate-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Materialize a tree of `{ relPath: contents }` under a fresh dir and return its absolute path. */
function tree(name: string, files: Record<string, string>): string {
  const dir = join(scratch, name);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return dir;
}

// -- 1. measureFrameworkSurfaces reuses the shipped estimate primitive ------

describe("measureFrameworkSurfaces", () => {
  it("returns an all-zero measurement for no tree paths (no I/O, managedBlock 0)", () => {
    const measurement = measureFrameworkSurfaces([]);
    expect(measurement).toEqual({
      counts: { skills: 0, agents: 0, commands: 0, rules: 0, hooks: 0, mcpServers: 0 },
      managedBlock: 0,
      evidence: "aih static tree measurement",
    });
  });

  it("sums estimateContextCostFromTree per path and equals the cost-gate variant counts on the same roots", () => {
    const rulesRoot = tree("rules-component", {
      "rules/core.md": "# core rule\n",
      "rules/nested/sub.md": "# nested rule\n",
    });
    const agentRoot = tree("agent-component", { "agents/planner.md": "# planner agent\n" });
    const skillRoot = tree("skill-component", { "skills/tdd/SKILL.md": "# tdd skill\n" });
    const roots = [rulesRoot, agentRoot, skillRoot];

    const measured = measureFrameworkSurfaces(roots);
    // Reuse proven, not forked: the value gate's surface counts are byte-for-byte
    // the cost gate's counts over the identical roots.
    const costVariant = measureCostGateVariant("lean", roots);

    expect(measured.counts).toEqual(costVariant.counts);
    expect(measured.counts).toEqual({
      skills: 1,
      agents: 1,
      commands: 0,
      rules: 2,
      hooks: 0,
      mcpServers: 0,
    });
    expect(measured.managedBlock).toBe(0);
  });

  it("fails closed (ClaudeHostWriteError) on a missing tree path — inherited from the reused estimate", () => {
    expect(() => measureFrameworkSurfaces([join(scratch, "does-not-exist")])).toThrow(
      ClaudeHostWriteError,
    );
  });
});

// -- 2. the verdict matrix --------------------------------------------------

describe("buildFrameworkValueRecord — verdict matrix", () => {
  it("DELIVERS_VALUE when Δtotal >= min, workflow succeeded + baseline-absent, cost present", () => {
    const record = buildFrameworkValueRecord(
      IDENTITY,
      BASELINE_CLEAN,
      surfaces({ agents: 5, rules: 122 }),
      COST_OK,
      WORKFLOW_OK,
    );
    expect(record.verdict).toBe("DELIVERS_VALUE");
    expect(record.deltas).toEqual({ invocable: 5, governance: 122, total: 127 });
    expect(record.dimensionsDelivered).toEqual([
      "capability(+5)",
      "governance(+122)",
      "workflow:ecc-review",
    ]);
    expect(record.framework).toBe("ecc");
    expect(record.mode).toBe("lean");
    expect(record.costTokens).toBe(80129);
    expect(record.costVerdict).toBe("within-budget");
  });

  it("INSUFFICIENT_VALUE when Δtotal = 0 (pure cost, no surface delta)", () => {
    const record = buildFrameworkValueRecord(
      IDENTITY,
      BASELINE_CLEAN,
      surfaces(),
      COST_OK,
      WORKFLOW_OK,
    );
    expect(record.verdict).toBe("INSUFFICIENT_VALUE");
    expect(record.deltas).toEqual({ invocable: 0, governance: 0, total: 0 });
  });

  it("INSUFFICIENT_VALUE when the characteristic workflow did not succeed", () => {
    const record = buildFrameworkValueRecord(
      IDENTITY,
      BASELINE_CLEAN,
      surfaces({ agents: 5, rules: 122 }),
      COST_OK,
      { ...WORKFLOW_OK, succeeded: false },
    );
    expect(record.verdict).toBe("INSUFFICIENT_VALUE");
    // capability/governance still honestly delivered; the workflow dimension is not.
    expect(record.dimensionsDelivered).toEqual(["capability(+5)", "governance(+122)"]);
  });

  it("INSUFFICIENT_VALUE when the workflow surface is present in the baseline (baselineAbsent=false)", () => {
    const record = buildFrameworkValueRecord(
      IDENTITY,
      BASELINE_CLEAN,
      surfaces({ agents: 5, rules: 122 }),
      COST_OK,
      { ...WORKFLOW_OK, baselineAbsent: false },
    );
    expect(record.verdict).toBe("INSUFFICIENT_VALUE");
    expect(record.dimensionsDelivered).not.toContain("workflow:ecc-review");
  });

  it("INCOMPLETE_MEASUREMENT when the baseline is absent", () => {
    const record = buildFrameworkValueRecord(
      IDENTITY,
      undefined,
      surfaces({ agents: 5, rules: 122 }),
      COST_OK,
      WORKFLOW_OK,
    );
    expect(record.verdict).toBe("INCOMPLETE_MEASUREMENT");
    expect(record.baseline).toBeUndefined();
    // A missing dimension is never fabricated as a zero delta.
    expect(record.deltas).toBeUndefined();
  });

  it("INCOMPLETE_MEASUREMENT when the framework surface measurement is absent", () => {
    const record = buildFrameworkValueRecord(
      IDENTITY,
      BASELINE_CLEAN,
      undefined,
      COST_OK,
      WORKFLOW_OK,
    );
    expect(record.verdict).toBe("INCOMPLETE_MEASUREMENT");
    expect(record.framework_).toBeUndefined();
    expect(record.deltas).toBeUndefined();
  });

  it("INCOMPLETE_MEASUREMENT when the cost measurement is absent", () => {
    const record = buildFrameworkValueRecord(
      IDENTITY,
      BASELINE_CLEAN,
      surfaces({ agents: 5, rules: 122 }),
      undefined,
      WORKFLOW_OK,
    );
    expect(record.verdict).toBe("INCOMPLETE_MEASUREMENT");
    // surfaces WERE measured, so the honest delta survives even when incomplete.
    expect(record.deltas).toEqual({ invocable: 5, governance: 122, total: 127 });
    expect(record.costTokens).toBeUndefined();
  });

  it("INCOMPLETE_MEASUREMENT when the workflow result is undefined (require=true default)", () => {
    const record = buildFrameworkValueRecord(
      IDENTITY,
      BASELINE_CLEAN,
      surfaces({ agents: 5, rules: 122 }),
      COST_OK,
      undefined,
    );
    expect(record.verdict).toBe("INCOMPLETE_MEASUREMENT");
    expect(record.characteristicWorkflow).toBeUndefined();
  });
});

// -- 2b. Superpowers-style record (no lean/full mode) -----------------------

describe("Superpowers-style record (no lean/full mode)", () => {
  it("omits the mode key and DELIVERS on surfaces + workflow (Q5 measured-at-acceptance)", () => {
    const record = buildFrameworkValueRecord(
      { framework: "superpowers" },
      BASELINE_CLEAN,
      surfaces({ skills: 14, hooks: 1 }),
      { tokens: 42000, verdict: "no-budget-set" },
      {
        name: "superpowers-brainstorm-plan",
        succeeded: true,
        baselineAbsent: true,
        evidence: "check-11 superpowers-brainstorm-plan",
      },
    );
    expect(record.verdict).toBe("DELIVERS_VALUE");
    expect(record.mode).toBeUndefined();
    expect("mode" in record).toBe(false);
    expect(record.deltas).toEqual({ invocable: 14, governance: 1, total: 15 });
    expect(record.dimensionsDelivered).toEqual([
      "capability(+14)",
      "governance(+1)",
      "workflow:superpowers-brainstorm-plan",
    ]);
  });
});

// -- 3. non-gameable: counts never override the decisive workflow signal ----

describe("non-gameable surface counts", () => {
  it("500 skill stubs with a failed workflow are INSUFFICIENT_VALUE (V3)", () => {
    const record = buildFrameworkValueRecord(
      IDENTITY,
      BASELINE_CLEAN,
      surfaces({ skills: 500 }),
      COST_OK,
      { ...WORKFLOW_OK, succeeded: false },
    );
    expect(record.verdict).toBe("INSUFFICIENT_VALUE");
    expect(record.deltas?.total).toBe(500);
  });
});

// -- 4. fail-closed on the mandatory workflow signal ------------------------

describe("fail-closed", () => {
  it("workflow undefined + requireCharacteristicWorkflow=true is INCOMPLETE, never DELIVERS", () => {
    const record = buildFrameworkValueRecord(
      IDENTITY,
      BASELINE_CLEAN,
      surfaces({ skills: 999, agents: 999, rules: 999 }),
      COST_OK,
      undefined,
    );
    expect(record.verdict).toBe("INCOMPLETE_MEASUREMENT");
  });

  it("workflow undefined + requireCharacteristicWorkflow=false is INSUFFICIENT (measure-only dry run), not INCOMPLETE", () => {
    const record = buildFrameworkValueRecord(
      IDENTITY,
      BASELINE_CLEAN,
      surfaces({ agents: 5, rules: 122 }),
      COST_OK,
      undefined,
      { ...DEFAULT_VALUE_THRESHOLDS, requireCharacteristicWorkflow: false },
    );
    expect(record.verdict).toBe("INSUFFICIENT_VALUE");
  });
});

// -- 5. dirty baseline shrinks the delta -> INSUFFICIENT (Q8 negatives) -----

describe("dirty baseline", () => {
  it("a contaminated Project C shrinks Δ below the floor -> INSUFFICIENT, never inflated to clean", () => {
    const framework = surfaces({ agents: 6 });
    const clean = buildFrameworkValueRecord(
      IDENTITY,
      BASELINE_CLEAN,
      framework,
      COST_OK,
      WORKFLOW_OK,
    );
    expect(clean.verdict).toBe("DELIVERS_VALUE");
    expect(clean.deltas?.total).toBe(6);

    // Same framework, but C already carries those 6 agents (contaminated husk).
    const dirty = buildFrameworkValueRecord(
      IDENTITY,
      surfaces({ agents: 6 }),
      framework,
      COST_OK,
      WORKFLOW_OK,
    );
    expect(dirty.verdict).toBe("INSUFFICIENT_VALUE");
    expect(dirty.deltas?.total).toBe(0);
  });

  it("allows a negative surface delta (never clamps a dirty baseline to look clean)", () => {
    const record = buildFrameworkValueRecord(
      IDENTITY,
      surfaces({ agents: 4 }),
      surfaces({ agents: 1 }),
      COST_OK,
      WORKFLOW_OK,
    );
    expect(record.deltas?.invocable).toBe(-3);
    expect(record.verdict).toBe("INSUFFICIENT_VALUE");
  });
});

// -- 6. threshold override + determinism ------------------------------------

describe("thresholds + determinism", () => {
  it("honors a raised minSurfaceDelta override", () => {
    const framework = surfaces({ agents: 5 });
    const passesDefault = buildFrameworkValueRecord(
      IDENTITY,
      BASELINE_CLEAN,
      framework,
      COST_OK,
      WORKFLOW_OK,
    );
    expect(passesDefault.verdict).toBe("DELIVERS_VALUE");

    const failsRaised = buildFrameworkValueRecord(
      IDENTITY,
      BASELINE_CLEAN,
      framework,
      COST_OK,
      WORKFLOW_OK,
      { ...DEFAULT_VALUE_THRESHOLDS, minSurfaceDelta: 10 },
    );
    expect(failsRaised.verdict).toBe("INSUFFICIENT_VALUE");
    expect(failsRaised.thresholds.minSurfaceDelta).toBe(10);
  });

  it("produces a byte-identical record across two builds from the same inputs", () => {
    const a = buildFrameworkValueRecord(
      IDENTITY,
      BASELINE_CLEAN,
      surfaces({ agents: 5, rules: 122 }),
      COST_OK,
      WORKFLOW_OK,
    );
    const b = buildFrameworkValueRecord(
      IDENTITY,
      BASELINE_CLEAN,
      surfaces({ agents: 5, rules: 122 }),
      COST_OK,
      WORKFLOW_OK,
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Fully JSON-serializable — no undefined-key leakage across a round trip.
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
});

// -- 7. ECC real-number fixtures (5-cost-gate.json vectors) ------------------

describe("ECC real-number fixtures", () => {
  it("ECC Lean (agents 5, rules 122) -> DELIVERS_VALUE with Δcap 5 / Δgov 122", () => {
    const record = buildFrameworkValueRecord(
      { framework: "ecc", mode: "lean" },
      BASELINE_CLEAN,
      surfaces({ agents: 5, rules: 122 }),
      { tokens: 80129, verdict: "within-budget" },
      WORKFLOW_OK,
    );
    expect(record.verdict).toBe("DELIVERS_VALUE");
    expect(record.deltas).toEqual({ invocable: 5, governance: 122, total: 127 });
  });

  it("ECC Full (skills 278, agents 67, commands 94, rules 122, hooks 29, mcp 1) -> DELIVERS_VALUE with Δcap 439 / Δgov 151", () => {
    const record = buildFrameworkValueRecord(
      { framework: "ecc", mode: "full" },
      BASELINE_CLEAN,
      surfaces({ skills: 278, agents: 67, commands: 94, rules: 122, hooks: 29, mcpServers: 1 }),
      { tokens: 904517, verdict: "over-budget" },
      WORKFLOW_OK,
    );
    expect(record.verdict).toBe("DELIVERS_VALUE");
    expect(record.deltas).toEqual({ invocable: 439, governance: 151, total: 590 });
    // The value gate does NOT launder the 9.05x cost debit — it is disclosed as-is.
    expect(record.costTokens).toBe(904517);
    expect(record.costVerdict).toBe("over-budget");
  });
});

// -- 8. the card valueGate fragment -----------------------------------------

const GIT_SOURCE: BindingSource = {
  kind: "git",
  repository: "samartomar/ECC",
  commitSha: "c".repeat(40),
  treeDigest: "a".repeat(64),
};

const VALUE_FRAGMENT: FrameworkValueCard = {
  verdict: "DELIVERS_VALUE",
  invocableSurfaceDelta: 5,
  governanceSurfaceDelta: 122,
  contextCostTokens: 80129,
  characteristicWorkflow: { name: "ecc-review", succeeded: true, baselineAbsent: true },
  dimensionsDelivered: ["capability(+5)", "governance(+122)", "workflow:ecc-review"],
  minSurfaceDelta: 1,
  baselineRef: "5-cost-gate.json:baseline",
};

function cardInput(valueGate: FrameworkValueCard): FrameworkCardBuildInput {
  return {
    framework: "ecc",
    scope: "project",
    targetLabel: "STRICT_PROJECT_BINDING_VERIFIED",
    source: GIT_SOURCE,
    installMechanism: "upstream-local-installer",
    valueGate,
  };
}

describe("FrameworkCard valueGate fragment", () => {
  it("round-trips the valueGate fragment through parse -> serialize -> parse", () => {
    const card = buildFrameworkCard(cardInput(VALUE_FRAGMENT));
    const round = parseFrameworkCard(JSON.parse(JSON.stringify(card)));
    expect(round).toEqual(card);
    expect(round.valueGate).toEqual(VALUE_FRAGMENT);
  });

  it("passes assertNoMachineLocalPath (baselineRef + workflow name are path-free)", () => {
    const card = buildFrameworkCard(cardInput(VALUE_FRAGMENT));
    expect(() => assertNoMachineLocalPath(card)).not.toThrow();
  });

  it("allows negative surface deltas on the fragment (Q8: z.number().int(), not NonNeg)", () => {
    const negative: FrameworkValueCard = {
      ...VALUE_FRAGMENT,
      verdict: "INSUFFICIENT_VALUE",
      invocableSurfaceDelta: -3,
      governanceSurfaceDelta: -1,
      dimensionsDelivered: [],
    };
    const parsed = FrameworkValueCardSchema.parse(negative);
    expect(parsed.invocableSurfaceDelta).toBe(-3);
    const card = buildFrameworkCard(cardInput(negative));
    expect(parseFrameworkCard(JSON.parse(JSON.stringify(card))).valueGate).toEqual(negative);
  });

  it("rejects an unknown key (strict fragment)", () => {
    expect(() => FrameworkValueCardSchema.parse({ ...VALUE_FRAGMENT, quality: 9 })).toThrow();
  });

  it("renderFrameworkCard emits an honest value line (Q6 wording, no score/best)", () => {
    const card = buildFrameworkCard(cardInput(VALUE_FRAGMENT));
    const rendered = renderFrameworkCard(card);
    const joined = rendered.join("\n");
    expect(joined).toContain("value gate: DELIVERS_VALUE");
    // Q6: name the DELIVERED workflow SURFACE; never "no review possible without ECC".
    expect(joined).toContain("delivers the ecc-review workflow surface, absent in no-framework");
    expect(joined).not.toMatch(/no review/i);
    expect(joined).not.toMatch(/\bbest\b/i);
    expect(joined).not.toMatch(/\bscore\b/i);
  });
});
