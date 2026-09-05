import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  ECC_MCP_DISABLED,
  ECC_MCP_SELECTED,
  SERENA_ALLOWED_TOOLS,
} from "../../src/ecc-profile/mcp-profile.js";
import {
  type AdoptionRecipeSources,
  buildAdoptionRecipe,
} from "../../src/org-policy/adoption-recipe.js";
import { ECC_MCP_CATALOG_IDS } from "../../src/org-policy/ecc-mcp-catalog.js";
import { OrgPolicySchema } from "../../src/org-policy/schema.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";
import { projectWorkbenchPolicy } from "../../src/org-policy/workbench/compile-policy.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../src/org-policy/workbench/selection-engine.js";
import { tinyStudioModel } from "./studio-test-fixture.js";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function studio(model = tinyStudioModel()): Window {
  const window = new Window({ url: "http://localhost/" });
  windows.push(window);
  const html = policyStudioHtml(model);
  window.document.write(html);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  return window;
}
function sources(): AdoptionRecipeSources {
  return structuredClone(buildAdoptionRecipe().sources);
}

describe("policy studio adoption recipe", () => {
  it("assigns exactly one bounded owner and route to every adoption question", () => {
    const recipe = buildAdoptionRecipe();
    expect(recipe.roles.map((role) => role.id)).toEqual([
      "token-savior",
      "serena",
      "code-review-graph",
      "codebase-memory-mcp",
      "token-optimizer",
    ]);
    expect(new Set(recipe.roles.map((role) => role.questionClass)).size).toBe(recipe.roles.length);
    expect(recipe.roles.map((role) => role.route)).toEqual([
      { kind: "aih-ecc-profile-lifecycle", command: "aih ecc --lifecycle install" },
      { kind: "aih-ecc-profile-lifecycle", command: "aih ecc --lifecycle install" },
      { kind: "workbench-row", candidate: "code-review-graph" },
      { kind: "workbench-row", candidate: "codebase-memory-mcp" },
      { kind: "ecc-mcp-approval", id: "token-optimizer", addability: "manual-stdio" },
    ]);
    expect(
      recipe.roles.map((role) => ({
        id: role.id,
        prerequisites: role.prerequisites,
        conflicts: role.conflicts,
      })),
    ).toEqual([
      {
        id: "token-savior",
        prerequisites: ["ECC profile lifecycle is installed"],
        conflicts: ["The current ECC profile disables token-savior; it is not an MCP route"],
      },
      {
        id: "serena",
        prerequisites: [
          "ECC profile lifecycle is installed",
          "Reviewed Serena symbol/refactor tools",
        ],
        conflicts: [
          "Memory, file, shell, project, and mode tools remain outside the reviewed route",
        ],
      },
      {
        id: "code-review-graph",
        prerequisites: ["Existing AIH core catalog Workbench row"],
        conflicts: ["One broad impact/reviewer query owner; no sibling route"],
      },
      {
        id: "codebase-memory-mcp",
        prerequisites: ["Existing AIH core catalog Workbench row"],
        conflicts: ["Durable architectural memory stays on this existing row; no sibling route"],
      },
      {
        id: "token-optimizer",
        prerequisites: ["Explicit on-demand overhead audit", "ECC MCP approval"],
        conflicts: ["manual-stdio only; no HTTPS Add route"],
      },
    ]);
    expect(recipe.roles.find((role) => role.id === "token-savior")?.usage).toEqual({
      kind: "none-captured",
    });
    expect(
      recipe.roles.flatMap((role) =>
        role.usage.kind === "mcp-server-event" ? [[role.id, role.usage.serverId]] : [],
      ),
    ).toEqual([
      ["serena", "serena"],
      ["code-review-graph", "code-review-graph"],
      ["codebase-memory-mcp", "codebase-memory-mcp"],
      ["token-optimizer", "token-optimizer"],
    ]);
    expect(recipe.sources.eccMcpSelected).toEqual(ECC_MCP_SELECTED);
    expect(recipe.sources.eccMcpDisabled).toEqual(ECC_MCP_DISABLED);
    expect(recipe.sources.serenaAllowedTools).toEqual(SERENA_ALLOWED_TOOLS);
    expect(recipe.sources.eccMcpCatalogIds).toEqual(ECC_MCP_CATALOG_IDS);
  });
  it("projects every compact fixture action through the product policy grammar", () => {
    const model = tinyStudioModel();
    const actions = [
      { type: "select-root" as const, assetId: "fixture:control" },
      { type: "select-root" as const, assetId: "fixture:external" },
      { type: "record-request" as const, assetId: "fixture:request" },
    ];
    for (const action of actions) {
      const reduced = reduceWorkbenchAction(model.workbenchBundle, createWorkbenchState(), {
        ...action,
        origin: { kind: "administrator" },
      });
      expect(reduced.accepted).toBe(true);
      const compiled = projectWorkbenchPolicy(
        model.initialPolicy,
        reduced.state,
        model.workbenchBundle,
        model.workbenchBindings,
        "author",
        model.workbenchSourceInputs,
      );
      expect(compiled.accepted).toBe(true);
      expect(OrgPolicySchema.parse(compiled.policy)).toBeDefined();
      const policy = compiled.policy as {
        authoringSelections: { requests: Array<{ assetId: string }> };
        governance: {
          activations: Array<{ candidate: string; targets: string[] }>;
          catalog: { reviewed: Array<{ id: string }> };
          externalSelections: Array<{ framework: string; items: Array<{ id: string }> }>;
        };
      };
      if (action.assetId === "fixture:control") {
        expect(policy.governance.catalog.reviewed).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "usage-metering" })]),
        );
        expect(policy.governance.activations).toEqual([
          expect.objectContaining({ candidate: "usage-metering", targets: ["claude", "codex"] }),
        ]);
      } else if (action.assetId === "fixture:external") {
        expect(policy.governance.externalSelections).toEqual([
          expect.objectContaining({
            framework: "ecc",
            items: [expect.objectContaining({ id: "fixture:external" })],
          }),
        ]);
      } else {
        expect(policy.governance.catalog.reviewed).toEqual([]);
        expect(policy.governance.activations).toEqual([]);
        expect(policy.governance.externalSelections).toEqual([]);
        expect(policy.authoringSelections.requests).toEqual([
          expect.objectContaining({ assetId: "fixture:request" }),
        ]);
      }
    }
  });
  it("fails closed when the selected profile or real core catalog drifts", () => {
    const missingSerena = sources();
    missingSerena.eccMcpSelected = missingSerena.eccMcpSelected.filter((id) => id !== "serena");
    expect(() => buildAdoptionRecipe(missingSerena)).toThrow(/serena/i);
    const unknownCore = sources();
    unknownCore.coreMcpIds = unknownCore.coreMcpIds.filter((id) => id !== "code-review-graph");
    expect(() => buildAdoptionRecipe(unknownCore)).toThrow(/code-review-graph/i);
  });
  it("fails closed when Token Savior, Serena, or Token Optimizer no longer has its reviewed source", () => {
    const tokenSaviorEnabled = sources();
    tokenSaviorEnabled.eccMcpDisabled = tokenSaviorEnabled.eccMcpDisabled.filter(
      (id) => id !== "token-savior",
    );
    expect(() => buildAdoptionRecipe(tokenSaviorEnabled)).toThrow(/token savior/i);
    const serenaOverlap = sources();
    serenaOverlap.serenaAllowedTools = serenaOverlap.serenaAllowedTools.filter(
      (tool) => tool !== "find_symbol",
    );
    expect(() => buildAdoptionRecipe(serenaOverlap)).toThrow(/reviewed Serena tool set changed/i);
    const optimizerWrongRoute = sources();
    const optimizer = optimizerWrongRoute.eccMcpCatalog.find(
      (entry) => entry.id === "token-optimizer",
    );
    if (optimizer === undefined) throw new Error("expected Token Optimizer catalog entry");
    optimizer.addability = "https-configurable";
    expect(() => buildAdoptionRecipe(optimizerWrongRoute)).toThrow(
      /token-optimizer.*manual-stdio/i,
    );
  });
  it.each([
    "delete_lines",
    "insert_at_line",
    "replace_lines",
    "search_for_pattern",
    "remove_project",
    "query_project",
    "list_queryable_projects",
    "find_symbol_implementation",
  ])("fails closed when Serena gains an unreviewed %s tool", (tool) => {
    const drifted = sources();
    drifted.serenaAllowedTools.push(tool);
    expect(() => buildAdoptionRecipe(drifted)).toThrow(/reviewed Serena tool set changed/i);
  });
  it("fails closed when the reviewed Serena tool sequence is duplicated or reordered", () => {
    const duplicate = sources();
    duplicate.serenaAllowedTools.push("find_symbol");
    expect(() => buildAdoptionRecipe(duplicate)).toThrow(/reviewed Serena tool set changed/i);
    const reordered = sources();
    [reordered.serenaAllowedTools[3], reordered.serenaAllowedTools[4]] = [
      reordered.serenaAllowedTools[4] ?? "",
      reordered.serenaAllowedTools[3] ?? "",
    ];
    expect(() => buildAdoptionRecipe(reordered)).toThrow(/reviewed Serena tool set changed/i);
  });
  it("fails closed when routed profile identities overlap selected and disabled sources", () => {
    const tokenSaviorSelected = sources();
    tokenSaviorSelected.eccMcpSelected.push("token-savior");
    expect(() => buildAdoptionRecipe(tokenSaviorSelected)).toThrow(
      /token savior.*selected.*disabled/i,
    );
    const serenaDisabled = sources();
    serenaDisabled.eccMcpDisabled.push("serena");
    expect(() => buildAdoptionRecipe(serenaDisabled)).toThrow(/serena.*selected.*disabled/i);
  });
  it("renders a separate escaped, inert panel without altering authored policy or ticker counts", () => {
    const model = tinyStudioModel();
    model.adoptionRecipe = buildAdoptionRecipe();
    const role = model.adoptionRecipe.roles[0];
    if (role === undefined) throw new Error("expected Token Savior recipe role");
    role.guidance = '<img src=x onerror="globalThis.__unsafe=true"> hostile';
    const window = studio(model);
    const panel = window.document.getElementById("adoption-recipe");
    if (panel === null) throw new Error("expected adoption recipe panel");
    expect(panel.querySelectorAll(".row")).toHaveLength(0);
    expect(panel.querySelectorAll("input,select,textarea")).toHaveLength(0);
    expect(panel.querySelectorAll("button")).toHaveLength(0);
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.textContent).toContain('<img src=x onerror="globalThis.__unsafe=true"> hostile');
    expect((window as unknown as { __unsafe?: boolean }).__unsafe).toBeUndefined();
    for (const recipeRole of model.adoptionRecipe.roles) {
      const rendered = panel.querySelector(`[data-adoption-role="${recipeRole.id}"]`);
      if (rendered === null) throw new Error(`expected ${recipeRole.id} adoption role`);
      expect(rendered.textContent).toContain("Prerequisites:");
      expect(rendered.textContent).toContain(recipeRole.prerequisites.join("; "));
      expect(rendered.textContent).toContain("Overlap / conflict:");
      expect(rendered.textContent).toContain(recipeRole.conflicts.join("; "));
      expect(rendered.textContent).toContain("Next action:");
      expect(rendered.textContent).toContain("Usage / coverage:");
    }
    expect(panel.textContent).toContain("Token Savior");
    expect(panel.textContent).toContain("Usage / coverage: none captured");
    expect(panel.textContent).toContain("code-review-graph");
    expect(panel.textContent).toContain("One broad impact/reviewer query owner");
    expect(panel.textContent).toContain("codebase-memory-mcp");
    expect(panel.textContent).toContain("Durable architectural memory");
    expect(panel.textContent).toContain("Token Optimizer");
    expect(panel.textContent).toContain("Explicit on-demand overhead audit");
  });
});
