import { describe, expect, it } from "vitest";
import {
  defineBaselineCatalog,
  resolveCatalogComponents,
} from "../../src/baseline-evidence/catalog.js";

function catalog() {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: "c".repeat(40),
    components: [
      { id: "module:rules-core", paths: ["rules"] },
      { id: "skill:verification-loop", paths: ["skills/verification-loop"] },
      { id: "agent:code-reviewer", paths: ["agents/code-reviewer.md"] },
    ],
  });
}

describe("baseline component catalog", () => {
  it("resolves an explicit selection in stable catalog order", () => {
    expect(
      resolveCatalogComponents(catalog(), ["agent:code-reviewer", "module:rules-core"]).map(
        (component) => component.id,
      ),
    ).toEqual(["module:rules-core", "agent:code-reviewer"]);
  });

  it("rejects unknown and duplicate requested component IDs", () => {
    expect(() => resolveCatalogComponents(catalog(), ["skill:missing"])).toThrow(/unknown/i);
    expect(() =>
      resolveCatalogComponents(catalog(), ["module:rules-core", "module:rules-core"]),
    ).toThrow(/duplicate/i);
  });

  it("rejects duplicate definitions and unsafe paths at catalog construction", () => {
    expect(() =>
      defineBaselineCatalog({
        id: "ecc",
        owner: "affaan-m",
        repo: "ECC",
        pinnedSha: "c".repeat(40),
        components: [
          { id: "module:rules-core", paths: ["rules"] },
          { id: "module:rules-core", paths: ["rules-again"] },
        ],
      }),
    ).toThrow(/duplicate/i);

    expect(() =>
      defineBaselineCatalog({
        id: "ecc",
        owner: "affaan-m",
        repo: "ECC",
        pinnedSha: "c".repeat(40),
        components: [{ id: "runtime:ecc", paths: ["../installer"] }],
      }),
    ).toThrow();
  });
});
