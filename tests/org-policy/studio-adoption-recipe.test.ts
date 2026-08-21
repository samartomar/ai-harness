import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import {
  buildAdoptionRecipe,
  type AdoptionRecipeSources,
} from "../../src/org-policy/adoption-recipe.js";
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
    expect(new Set(recipe.roles.map((role) => role.questionClass)).size).toBe(
      recipe.roles.length,
    );
    expect(recipe.roles.map((role) => role.route.kind)).toEqual([
      "aih-ecc-profile-lifecycle",
      "aih-ecc-profile-lifecycle",
      "workbench-row",
      "workbench-row",
      "ecc-mcp-approval",
    ]);
    expect(recipe.roles.find((role) => role.id === "token-savior")?.usage).toEqual({
      kind: "none-captured",
    });
    expect(
      recipe.roles.filter((role) => role.usage.kind === "mcp-server-event").map((role) => role.id),
    ).toEqual(["code-review-graph", "codebase-memory-mcp"]);
  });

  it("fails closed when the selected profile or real core catalog drifts", () => {
    const missingSerena = sources();
    missingSerena.eccMcpSelected = missingSerena.eccMcpSelected.filter((id) => id !== "serena");
    expect(() => buildAdoptionRecipe(missingSerena)).toThrow(/serena/i);

    const unknownCore = sources();
    delete unknownCore.coreMcpCatalog["code-review-graph"];
    expect(() => buildAdoptionRecipe(unknownCore)).toThrow(/code-review-graph/i);
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
    expect(
      (window.document.getElementById("config-preview") as unknown as { value: string }).value,
    ).toBe(JSON.stringify(model.initialPolicy, null, 2));
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
