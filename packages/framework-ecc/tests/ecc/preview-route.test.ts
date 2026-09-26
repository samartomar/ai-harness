import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyGovernedEccOperation,
  eccAdapterDestinationV1,
  eccManifestOperationAllowedByConsent,
  eccPreviewAdapterDestinationV1,
  filterEccManifestPlan,
  filterEccPreviewManifestPlan,
} from "../../src/ecc/materialize.js";

/**
 * D82, plugin copy. The preview route's classification is part of the plugin's
 * `materialize.ts` because the two packages ship the same install boundary; this
 * file pins the plugin copy to the same answers as Core's copy and keeps the
 * governed/reconciliation behaviour of this package unchanged.
 */

const PROJECT_ROOT = "/workspace/project";
const HOME_DIR = "/home/aih";
const CLAUDE_ROOTS = {
  projectRoot: PROJECT_ROOT,
  homeDir: HOME_DIR,
  target: "claude",
  targetRoot: `${HOME_DIR}/.claude`,
};

function selection(componentId: string) {
  return {
    scope: "scoped" as const,
    components: [componentId as `${string}:${string}`],
    mcps: [],
    recommendations: [],
  };
}

function operation(
  source: string,
  destination: string,
  moduleId = "commands-core",
  kind = "copy-file",
) {
  return { kind, moduleId, sourceRelativePath: source, destinationPath: destination };
}

function planWith(...operations: ReturnType<typeof operation>[]) {
  return {
    operations: operations.map((entry) => ({ ...entry })),
    statePreview: { operations: operations.map((entry) => ({ ...entry })) },
  };
}

describe("the plugin preview route describes the pinned installer's own scaffold", () => {
  it("keeps the exact operation the governed route refuses", () => {
    const plan = planWith(
      operation("scripts/harness-audit.js", `${HOME_DIR}/.claude/scripts/harness-audit.js`),
    );
    filterEccPreviewManifestPlan(plan, selection("baseline:commands"), { roots: CLAUDE_ROOTS });
    expect(plan.operations).toEqual([
      expect.objectContaining({
        sourceRelativePath: "scripts/harness-audit.js",
        destinationPath: `${HOME_DIR}/.claude/scripts/harness-audit.js`,
      }),
    ]);
  });

  it("still refuses that operation on every governed/reconciliation boundary", () => {
    expect(() =>
      classifyGovernedEccOperation(
        operation("scripts/harness-audit.js", `${HOME_DIR}/.claude/scripts/harness-audit.js`),
        CLAUDE_ROOTS,
      ),
    ).toThrow(/unclassifiable governed ECC content operation/);
    expect(() =>
      filterEccManifestPlan(
        planWith(
          operation("scripts/harness-audit.js", `${HOME_DIR}/.claude/scripts/harness-audit.js`),
        ),
        selection("baseline:commands"),
        { governance: true, roots: CLAUDE_ROOTS },
      ),
    ).toThrow(/unclassifiable governed ECC content operation/);
    // Reconciliation classifies an installed operation with no roots at all
    // (reconcile.ts:294), which is the same ownership refusal.
    expect(() =>
      eccManifestOperationAllowedByConsent(
        operation("scripts/harness-audit.js", `${HOME_DIR}/.claude/scripts/harness-audit.js`),
        selection("baseline:commands"),
      ),
    ).toThrow(/unclassifiable governed ECC content operation/);
  });

  it("still refuses a scaffold destination the pinned adapter would not produce", () => {
    for (const [source, destination] of [
      ["scripts/harness-audit.js", `${HOME_DIR}/.claude/scripts/other.js`],
      ["scripts/harness-audit.js", `${PROJECT_ROOT}/scripts/harness-audit.js`],
      ["rules/README.md", `${HOME_DIR}/.claude/rules/README.md`],
    ] as const) {
      expect(() =>
        filterEccPreviewManifestPlan(
          planWith(operation(source, destination, "rules-core")),
          selection("baseline:rules"),
          { roots: CLAUDE_ROOTS },
        ),
      ).toThrow(/unclassifiable ECC install preview destination/);
    }
  });

  it("still refuses a destination outside the roots and a kind the source cannot explain", () => {
    expect(() =>
      filterEccPreviewManifestPlan(
        planWith(operation("scripts/harness-audit.js", "/tmp/elsewhere/harness-audit.js")),
        selection("baseline:commands"),
        { roots: CLAUDE_ROOTS },
      ),
    ).toThrow(/ECC destination escapes authorized project\/home roots/);
    expect(() =>
      filterEccPreviewManifestPlan(
        planWith(
          operation(
            "scripts/harness-audit.js",
            `${HOME_DIR}/.claude/scripts/harness-audit.js`,
            "commands-core",
            "delete-file",
          ),
        ),
        selection("baseline:commands"),
        { roots: CLAUDE_ROOTS },
      ),
    ).toThrow(/unsupported ECC manifest operation kind: delete-file/);
  });

  it("models the pinned adapters' remaps, the native root and the settings hook merge", () => {
    expect(eccPreviewAdapterDestinationV1("rules/README.md", "claude")).toEqual({
      state: "relative",
      relative: "rules/ecc/README.md",
    });
    expect(eccPreviewAdapterDestinationV1(".claude-plugin/plugin.json", "claude")).toEqual({
      state: "relative",
      relative: "plugin.json",
    });
    expect(eccPreviewAdapterDestinationV1(".cursor/rules/common-agents.md", "cursor")).toEqual({
      state: "relative",
      relative: "rules/common-agents.mdc",
    });
    expect(eccPreviewAdapterDestinationV1(".cursor/rules/common/README.md", "cursor")).toEqual({
      state: "unwritten",
    });
    // The shared scaffold default stays the identity under the verified root.
    expect(eccAdapterDestinationV1("scripts/harness-audit.js", "gemini")).toEqual({
      state: "identity",
    });

    const settings = operation(
      "hooks/hooks.json",
      `${HOME_DIR}/.claude/settings.json`,
      "hooks-runtime",
      "update-claude-settings",
    );
    const kept = planWith(settings);
    filterEccPreviewManifestPlan(kept, selection("baseline:hooks"), { roots: CLAUDE_ROOTS });
    expect(kept.operations).toHaveLength(1);
    const dropped = planWith(settings);
    filterEccPreviewManifestPlan(dropped, selection("baseline:rules"), { roots: CLAUDE_ROOTS });
    expect(dropped.operations).toEqual([]);
  });
});

/**
 * The preview block is the SAME source in both packages: Core's copy and the
 * plugin's copy are the same module shipped twice, so a row added to one copy
 * only would describe the pinned installer differently at the two boundaries.
 * Nothing can import both at once, so the pin is a source read.
 */
describe("the two materialize.ts copies stay identical on the preview route", () => {
  const previewBlock = (path: string): string => {
    const source = readFileSync(join(import.meta.dirname, path), "utf8");
    const start = source.indexOf("export type EccPreviewOperationClass");
    if (start === -1) throw new Error(`missing preview route block in ${path}`);
    return source.slice(start);
  };

  it("keeps the preview route block byte-identical in Core and the plugin", () => {
    expect(previewBlock("../../src/ecc/materialize.ts")).toBe(
      previewBlock("../../../../src/ecc/materialize.ts"),
    );
  });
});
