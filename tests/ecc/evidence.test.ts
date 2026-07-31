import { describe, expect, it } from "vitest";
import type { BaselineAuthorization } from "../../src/baseline-evidence/verify.js";
import type { EccComponentSelection } from "../../src/ecc/components.js";
import {
  authorizedEccSelection,
  eccEvidenceComponentIds,
  eccEvidenceComponentIdsForSelection,
  eccProfileModuleIds,
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
      authorization("baseline:agents"),
      authorization("baseline:platform"),
      authorization("module:platform-configs"),
      authorization("skill:tdd-workflow"),
      authorization("agent:typescript-reviewer"),
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

  it("refuses a partially authorized full request", () => {
    const requested = scopedSelection();
    requested.scope = "full";

    expect(() =>
      authorizedEccSelection(requested, [authorization("baseline:rules")], ["claude"]),
    ).toThrow(/refusing partial ECC Full install/);
  });

  it("preserves a fully authorized full request", () => {
    const requested = scopedSelection();
    requested.scope = "full";
    const receipts = eccEvidenceComponentIdsForSelection("claude", requested).map(authorization);

    const authorized = authorizedEccSelection(requested, receipts, ["claude"]);

    expect(authorized).toEqual(requested);
  });

  it("covers the complete existing core profile plus installer runtime", () => {
    expect(eccProfileModuleIds("core")).toEqual([
      "rules-core",
      "agents-core",
      "commands-core",
      "hooks-runtime",
      "platform-configs",
      "skill-unified-memory",
      "workflow-quality",
    ]);
    expect(eccEvidenceComponentIds("core", "claude", [])).toEqual([
      "runtime:ecc-installer",
      "module:rules-core",
      "module:agents-core",
      "module:commands-core",
      "module:hooks-runtime",
      "module:platform-configs",
      "module:skill-unified-memory",
      "module:workflow-quality",
    ]);
  });

  it("binds the product Core selector to the same exact upstream module closure", () => {
    const selection: EccComponentSelection = {
      scope: "scoped",
      components: [],
      mcps: [],
      recommendations: [],
      moduleIds: eccProfileModuleIds("core"),
    };
    expect(eccEvidenceComponentIdsForSelection("claude", selection)).toEqual(
      eccEvidenceComponentIds("core", "claude", []),
    );
    expect(() =>
      authorizedEccSelection(
        selection,
        eccEvidenceComponentIds("core", "claude", [])
          .filter((id) => id !== "module:hooks-runtime")
          .map(authorization),
        ["claude"],
      ),
    ).toThrow(/refusing partial ECC Core install.*module:hooks-runtime/);
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
      "module:skill-unified-memory",
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

  it("covers all 25 modules selected by the pinned full profile for Claude", () => {
    const full = eccEvidenceComponentIds("full", "claude", []);
    expect(full[0]).toBe("runtime:ecc-installer");
    expect(full.filter((id) => id.startsWith("module:"))).toHaveLength(25);
  });

  it("rejects a profile absent from the pinned profile snapshot", () => {
    expect(() => eccEvidenceComponentIds("unknown", "claude", [])).toThrow(/profile/i);
  });

  it("requests precise scoped evidence and omits modules unsupported by the target", () => {
    expect(eccEvidenceComponentIdsForSelection("codex", scopedSelection())).toEqual([
      "runtime:ecc-installer",
      "baseline:agents",
      "baseline:platform",
      "skill:tdd-workflow",
      "agent:code-reviewer",
      "lang:typescript",
      "agent:typescript-reviewer",
      "module:platform-configs",
    ]);
    expect(eccEvidenceComponentIdsForSelection("claude", scopedSelection())).toEqual([
      "runtime:ecc-installer",
      "baseline:rules",
      "baseline:agents",
      "baseline:platform",
      "baseline:commands",
      "skill:tdd-workflow",
      "agent:code-reviewer",
      "lang:typescript",
      "agent:typescript-reviewer",
      "module:platform-configs",
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
      "lang:swift",
    ]);
  });

  it("requires exact logical receipts for installed records", () => {
    const records = installedEccComponentRegistrations("codex", scopedSelection(), [
      authorization("baseline:agents"),
      authorization("baseline:platform"),
      authorization("module:platform-configs"),
      authorization("skill:tdd-workflow"),
      authorization("agent:code-reviewer"),
      authorization("lang:typescript"),
      authorization("agent:typescript-reviewer"),
    ]);

    expect(records.map((record) => [record.id, record.authorization.componentId])).toEqual([
      ["baseline:agents", "baseline:agents"],
      ["baseline:platform", "baseline:platform"],
      ["skill:tdd-workflow", "skill:tdd-workflow"],
      ["agent:code-reviewer", "agent:code-reviewer"],
      ["lang:typescript", "lang:typescript"],
      ["agent:typescript-reviewer", "agent:typescript-reviewer"],
      ["mcp:sequential-thinking", "module:platform-configs"],
    ]);
  });

  it("retains additive logical receipts alongside exact Core module receipts", () => {
    const selection: EccComponentSelection = {
      scope: "scoped",
      components: ["lang:swift", "skill:security-review"],
      mcps: [],
      recommendations: [],
      moduleIds: eccProfileModuleIds("core"),
    };
    const receipts = eccEvidenceComponentIdsForSelection("codex", selection).map(authorization);

    const records = installedEccComponentRegistrations("codex", selection, receipts);

    expect(records.map((record) => record.id)).toEqual(
      expect.arrayContaining([
        "module:agents-core",
        "module:platform-configs",
        "module:skill-unified-memory",
        "lang:swift",
        "skill:security-review",
      ]),
    );
  });

  it("retains live logical receipts alongside an atomic Full module authorization", () => {
    const selection: EccComponentSelection = {
      scope: "full",
      components: ["skill:security-review"],
      mcps: [],
      recommendations: [],
    };
    const receipts = eccEvidenceComponentIdsForSelection("codex", selection).map(authorization);

    const records = installedEccComponentRegistrations("codex", selection, receipts);

    expect(records.map((record) => record.id)).toEqual(
      expect.arrayContaining(["module:security", "skill:security-review"]),
    );
    expect(
      records.find((record) => record.id === "skill:security-review")?.authorization.componentId,
    ).toBe("module:security");
  });

  it("uses exact leaf evidence instead of its containing module", () => {
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

  it("fails closed when an exact logical receipt is missing", () => {
    expect(() =>
      installedEccComponentRegistrations("codex", scopedSelection(), [
        authorization("module:security"),
      ]),
    ).toThrow(/missing ECC evidence authorization for baseline:agents/);
  });
});
