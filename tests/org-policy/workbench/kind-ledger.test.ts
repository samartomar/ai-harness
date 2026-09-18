import { describe, expect, it } from "vitest";
import {
  buildKindLedgerViewModel,
  KIND_LEDGER_KINDS,
  renderKindLedger,
} from "../../../src/org-policy/workbench/ui/kind-ledger.js";

function assetsOf(kinds: readonly string[]): Array<{ id: string; kind: string }> {
  return kinds.map((kind, index) => ({ id: `${kind}:${index}`, kind }));
}

describe("kind ledger view-model (P2b)", () => {
  it("counts total and selected per kind from a fixture model", () => {
    const assets = assetsOf([
      "skill",
      "skill",
      "agent",
      "mcp",
      "hook",
      "command",
      "lang", // a kind not in the ledger's fixed set — must not appear
    ]);
    const selectedAssetIds = new Set(["skill:0", "mcp:3"]);
    const model = buildKindLedgerViewModel(assets, selectedAssetIds);

    expect(model.entries.map((entry) => entry.kind)).toEqual(KIND_LEDGER_KINDS);

    const byKind = Object.fromEntries(model.entries.map((entry) => [entry.kind, entry]));
    expect(byKind.skill).toMatchObject({ total: 2, selected: 1 });
    expect(byKind.agent).toMatchObject({ total: 1, selected: 0 });
    expect(byKind.mcp).toMatchObject({ total: 1, selected: 1 });
    expect(byKind.hook).toMatchObject({ total: 1, selected: 0 });
    expect(byKind.command).toMatchObject({ total: 1, selected: 0 });
  });

  it("renders every ledger kind with a real product count of 0 for an empty model", () => {
    const model = buildKindLedgerViewModel([], new Set());
    expect(model.entries).toHaveLength(KIND_LEDGER_KINDS.length);
    for (const entry of model.entries) {
      expect(entry.total).toBe(0);
      expect(entry.selected).toBe(0);
    }
  });

  it("updates selected counts when selection state changes", () => {
    const assets = assetsOf(["skill", "skill", "agent"]);
    const before = buildKindLedgerViewModel(assets, new Set());
    const after = buildKindLedgerViewModel(assets, new Set(["skill:0", "skill:1", "agent:2"]));

    const beforeSkill = before.entries.find((entry) => entry.kind === "skill");
    const afterSkill = after.entries.find((entry) => entry.kind === "skill");
    expect(beforeSkill?.selected).toBe(0);
    expect(afterSkill?.selected).toBe(2);

    const afterAgent = after.entries.find((entry) => entry.kind === "agent");
    expect(afterAgent?.selected).toBe(1);
  });

  it("never renders token/context cost numbers", () => {
    const model = buildKindLedgerViewModel(assetsOf(["skill"]), new Set());
    const html = renderKindLedger(model);
    expect(html).not.toMatch(/token/i);
    expect(html).not.toMatch(/context (window|budget|cost)/i);
  });

  it("renders a labelled bar tile per kind with counts", () => {
    const model = buildKindLedgerViewModel(
      assetsOf(["skill", "skill", "mcp"]),
      new Set(["skill:0"]),
    );
    const html = renderKindLedger(model);
    for (const kind of KIND_LEDGER_KINDS) {
      expect(html).toContain(`data-kind-ledger-tile="${kind}"`);
    }
    expect(html).toContain("1/2");
  });
  it("keeps tile labels in neutral text and colours only the icon and bar (light-mode contrast)", () => {
    const html = renderKindLedger(buildKindLedgerViewModel(assetsOf(["skill"]), []));
    expect(html).toContain('data-kind-ledger-tile="skill"');
    expect(html).toContain('font-semibold text-on-surface-variant">');
    const classes = [...html.matchAll(/class="([^"]*)"/g)].map((match) => match[1]).join(" ");
    expect(classes).not.toMatch(/(?:bg|border|text)-[a-z-]+\/\d+/);
  });
});
