import { describe, expect, it } from "vitest";
import type { BaselineAuthorization } from "../../src/baseline-evidence/verify.js";
import type { EccComponentSelection } from "../../src/ecc/components.js";
import {
  authorizedEccSelection,
  eccEvidenceComponentIds,
  eccEvidenceComponentIdsForSelection,
  installedEccComponentRegistrations,
} from "../../src/ecc/evidence.js";

function authorization(componentId: string): BaselineAuthorization {
  return {
    componentId,
    source: "affaan-m/ECC",
    pinnedSha: "a".repeat(40),
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/harness release",
    evidenceSha256: "c".repeat(64),
  };
}

function scopedSelection(): EccComponentSelection {
  return {
    scope: "scoped",
    components: [
      "baseline:rules",
      "baseline:agents",
      "baseline:platform",
      "baseline:commands",
      "skill:tdd-workflow",
      "agent:code-reviewer",
      "lang:typescript",
      "agent:typescript-reviewer",
    ],
    mcps: ["mcp:sequential-thinking"],
    recommendations: [],
  };
}

describe("ECC evidence component selection", () => {
  it("filters the requested surface to components covered by authorization receipts", () => {
    const authorized = authorizedEccSelection(scopedSelection(), [
      authorization("module:agents-core"),
      authorization("module:platform-configs"),
      authorization("skill:tdd-workflow"),
    ]);

    expect(authorized).toEqual({
      scope: "scoped",
      components: [
        "baseline:agents",
        "baseline:platform",
        "skill:tdd-workflow",
        "agent:typescript-reviewer",
      ],
      mcps: ["mcp:sequential-thinking"],
      recommendations: [],
    });
  });

  it("downgrades a partially authorized full request to a filtered scoped selection", () => {
    const requested = scopedSelection();
    requested.scope = "full";

    const authorized = authorizedEccSelection(requested, [authorization("module:rules-core")]);

    expect(authorized.scope).toBe("scoped");
    expect(authorized.components).toEqual(["baseline:rules"]);
    expect(authorized.mcps).toEqual([]);
  });

  it("preserves a fully authorized full request", () => {
    const requested = scopedSelection();
    requested.scope = "full";
    const receipts = eccEvidenceComponentIdsForSelection("claude", requested).map(authorization);

    const authorized = authorizedEccSelection(requested, receipts, ["claude"]);

    expect(authorized).toEqual(requested);
  });

  it("covers the complete existing core profile plus installer runtime", () => {
    expect(eccEvidenceComponentIds("core", "claude", [])).toEqual([
      "runtime:ecc-installer",
      "module:rules-core",
      "module:agents-core",
      "module:commands-core",
      "module:hooks-runtime",
      "module:platform-configs",
      "module:workflow-quality",
    ]);
  });

  it("adds the framework-language module for current stack pack aliases", () => {
    expect(eccEvidenceComponentIds("core", "claude", ["typescript", "web"])).toEqual([
      "runtime:ecc-installer",
      "module:rules-core",
      "module:agents-core",
      "module:commands-core",
      "module:hooks-runtime",
      "module:platform-configs",
      "module:framework-language",
      "module:workflow-quality",
    ]);
  });

  it("filters modules the selected upstream target cannot install", () => {
    const antigravity = eccEvidenceComponentIds("full", "antigravity", []);
    expect(antigravity).toContain("module:rules-core");
    expect(antigravity).toContain("module:agents-core");
    expect(antigravity).not.toContain("module:hooks-runtime");
    expect(antigravity).not.toContain("module:media-generation");
    expect(antigravity).not.toContain("module:orchestration");
  });

  it("covers all 23 modules selected by the pinned full profile for Claude", () => {
    const full = eccEvidenceComponentIds("full", "claude", []);
    expect(full[0]).toBe("runtime:ecc-installer");
    expect(full.filter((id) => id.startsWith("module:"))).toHaveLength(23);
  });

  it("rejects a profile absent from the pinned profile snapshot", () => {
    expect(() => eccEvidenceComponentIds("unknown", "claude", [])).toThrow(/profile/i);
  });

  it("requests precise scoped evidence and omits modules unsupported by the target", () => {
    expect(eccEvidenceComponentIdsForSelection("codex", scopedSelection())).toEqual([
      "runtime:ecc-installer",
      "module:agents-core",
      "module:platform-configs",
      "skill:tdd-workflow",
      "agent:code-reviewer",
      "module:framework-language",
    ]);
    expect(eccEvidenceComponentIdsForSelection("claude", scopedSelection())).toEqual([
      "runtime:ecc-installer",
      "module:rules-core",
      "module:agents-core",
      "module:platform-configs",
      "module:commands-core",
      "skill:tdd-workflow",
      "agent:code-reviewer",
      "module:framework-language",
    ]);
  });

  it("maps declared Swift to the signed swift-apple module", () => {
    const selection: EccComponentSelection = {
      scope: "scoped",
      components: ["lang:swift"],
      mcps: [],
      recommendations: [],
    };
    expect(eccEvidenceComponentIdsForSelection("codex", selection)).toEqual([
      "runtime:ecc-installer",
      "module:swift-apple",
    ]);
  });

  it("projects exact leaf and containing-module receipts into installed records", () => {
    const records = installedEccComponentRegistrations("codex", scopedSelection(), [
      authorization("module:agents-core"),
      authorization("module:platform-configs"),
      authorization("module:workflow-quality"),
      authorization("module:framework-language"),
    ]);

    expect(records.map((record) => [record.id, record.authorization.componentId])).toEqual([
      ["baseline:agents", "module:agents-core"],
      ["baseline:platform", "module:platform-configs"],
      ["skill:tdd-workflow", "module:workflow-quality"],
      ["agent:code-reviewer", "module:agents-core"],
      ["lang:typescript", "module:framework-language"],
      ["agent:typescript-reviewer", "module:agents-core"],
      ["mcp:sequential-thinking", "module:platform-configs"],
    ]);
  });

  it("prefers exact leaf evidence over its containing module", () => {
    const selection: EccComponentSelection = {
      scope: "scoped",
      components: ["skill:tdd-workflow"],
      mcps: [],
      recommendations: [],
    };
    const [record] = installedEccComponentRegistrations("codex", selection, [
      authorization("module:workflow-quality"),
      authorization("skill:tdd-workflow"),
    ]);
    expect(record?.authorization.componentId).toBe("skill:tdd-workflow");
  });

  it("fails closed when no exact or containing-module receipt covers a component", () => {
    expect(() =>
      installedEccComponentRegistrations("codex", scopedSelection(), [
        authorization("module:security"),
      ]),
    ).toThrow(/missing ECC evidence authorization for baseline:agents/);
  });
});
