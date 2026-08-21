import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
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
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

function studio(model = policyStudioModel()): Window {
  const window = new Window({ url: "http://localhost/" });
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
  return structuredClone(policyStudioModel().adoptionRecipe.sources);
}

describe("policy studio adoption recipe", () => {
  it("assigns exactly one bounded owner and route to every adoption question", () => {
    const recipe = policyStudioModel().adoptionRecipe;
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
    expect(() => buildAdoptionRecipe(serenaOverlap)).toThrow(/serena tool find_symbol/i);

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
    ["read_file", "file"],
    ["run_shell_command", "shell"],
    ["search_memory", "memory"],
    ["switch_project", "project"],
    ["set_mode", "mode"],
  ])("fails closed when Serena gains a reviewed-overlap %s tool", (tool, toolClass) => {
    const drifted = sources();
    drifted.serenaAllowedTools.push(tool);
    expect(() => buildAdoptionRecipe(drifted)).toThrow(new RegExp(`Serena.*${toolClass}`, "i"));
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
    const model = structuredClone(policyStudioModel());
    const role = model.adoptionRecipe.roles[0];
    if (role === undefined) throw new Error("expected Token Savior recipe role");
    role.guidance = '<img src=x onerror="globalThis.__unsafe=true"> hostile';
    const window = studio(model);
    const panel = window.document.getElementById("adoption-recipe");
    if (panel === null) throw new Error("expected adoption recipe panel");

    expect(panel.querySelectorAll(".row")).toHaveLength(0);
    expect(panel.querySelectorAll("button,input,select,textarea")).toHaveLength(0);
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
    expect(
      (window.document.getElementById("config-preview") as unknown as { value: string }).value,
    ).toBe(`${JSON.stringify(model.initialPolicy, null, 2)}\n`);
    const eccAssets = model.catalog.frameworks.find((framework) => framework.id === "ecc")?.assets;
    const superpowersAssets = model.catalog.frameworks.find(
      (framework) => framework.id === "superpowers",
    )?.assets;
    if (eccAssets === undefined || superpowersAssets === undefined) {
      throw new Error("expected pinned framework assets");
    }
    const aihCount = model.catalog.mcp.length + model.catalog.hooks.length;
    expect(
      [...window.document.querySelectorAll("#owner-ticker [data-owner-focus]")].map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual([
      `All ${aihCount + eccAssets.length + superpowersAssets.length}`,
      `AIH ${aihCount}`,
      `ECC ${eccAssets.length}`,
      `Superpowers ${superpowersAssets.length}`,
      "Your sources 0",
    ]);
  });
});
