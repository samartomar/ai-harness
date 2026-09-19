/**
 * The new shell's additions screen (NEW-SHELL-PLAN.md S7): the ECC MCP
 * approval panel and the custom-hook note, with the legacy runtime's
 * messages (`sy`, `Py`, the approval remove handler) and textContent only.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { PolicyStudioModel } from "../../../src/org-policy/studio-model.js";
import { tinyStudioModel } from "../studio-test-fixture.js";
import { announcement, closeStudios, preview, studio } from "./shell-parity-harness.js";

afterEach(closeStudios);

const HOSTILE = '<img src=x onerror="globalThis.__pwned=1">';

function withApproval(): PolicyStudioModel {
  const model = tinyStudioModel();
  const catalog = model.catalog as unknown as {
    externalMcp: unknown[];
    eccMcpApproval: { sourceContentSha256: string };
  };
  catalog.externalMcp = [{ id: "jira", addability: "https-configurable" }];
  (model.initialPolicy.governance as unknown as Record<string, unknown>).eccMcpApprovals = [
    {
      id: "jira",
      sourceContentSha256: catalog.eccMcpApproval.sourceContentSha256,
      state: "approved",
      approvedBy: "owner@company.example",
      authenticationMode: HOSTILE,
      allowedDataClasses: ["issue-metadata"],
    },
  ];
  return model;
}

describe("new shell additions screen: ECC MCP approval and custom hooks", () => {
  it("lists pinned ECC MCP and recorded approvals as text, and removes an approval", () => {
    const { window } = studio(withApproval());
    const document = window.document;
    const panel = document.getElementById("ecc-mcp-sidebar") as unknown as { hidden: boolean };
    expect(panel.hidden).toBe(true);
    document
      .getElementById("open-ecc-mcp")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(panel.hidden).toBe(false);
    const options = [...document.querySelectorAll("#ecc-mcp-id option")].map(
      (option) => option.textContent,
    );
    expect(options).toEqual(["Choose pinned ECC MCP", "jira — https-configurable"]);
    const rows = document.getElementById("ecc-mcp-approval-rows");
    expect(rows?.textContent).toContain(`jira — approved; ${HOSTILE}.`);
    expect(rows?.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();

    rows
      ?.querySelector('[data-ecc-mcp-approval-remove="jira"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(announcement(window)).toBe("ECC MCP approval removed for jira.");
    const governance = (JSON.parse(preview(window)) as { governance: Record<string, unknown> })
      .governance;
    expect(governance.eccMcpApprovals ?? []).toEqual([]);
    expect(document.getElementById("ecc-mcp-approval-rows")?.textContent).toBe(
      "No ECC MCP approvals recorded.",
    );

    document
      .getElementById("ecc-mcp-close")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(panel.hidden).toBe(true);
  });

  it("preselects a pinned ECC MCP from an adoption route and ignores unknown ids", () => {
    const { window } = studio(withApproval());
    const document = window.document;
    const route = document.createElement("button");
    route.setAttribute("data-ecc-mcp-approval", "not-pinned");
    document.body.append(route);
    route.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(
      (document.getElementById("ecc-mcp-sidebar") as unknown as { hidden: boolean }).hidden,
    ).toBe(true);
    route.setAttribute("data-ecc-mcp-approval", "jira");
    route.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(
      (document.getElementById("ecc-mcp-sidebar") as unknown as { hidden: boolean }).hidden,
    ).toBe(false);
    expect((document.getElementById("ecc-mcp-id") as unknown as { value: string }).value).toBe(
      "jira",
    );
    expect(announcement(window)).toBe(
      "ECC MCP jira selected for approval authoring only; it is not installed or contacted.",
    );
  });

  it("opens and closes the custom-hook note", () => {
    const { window } = studio(tinyStudioModel());
    const document = window.document;
    const note = document.getElementById("wb-acme-hook-info") as unknown as { hidden: boolean };
    const trigger = document.getElementById("open-custom-hook-info");
    expect(note.hidden).toBe(true);
    trigger?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(note.hidden).toBe(false);
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    document
      .getElementById("wb-acme-hook-info-close")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(note.hidden).toBe(true);
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("new shell additions screen: legacy focus, escape and edit-state parity", () => {
  const press = (window: ReturnType<typeof studio>["window"], key: string) =>
    window.document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));

  it("leaves curation edit mode on Clear policy, so Save adds the item fresh", () => {
    const { window } = studio(tinyStudioModel());
    const document = window.document;
    const set = (id: string, entry: string) => {
      const field = document.getElementById(id) as unknown as { value: string } | null;
      if (field === null) throw new Error(`expected #${id}`);
      field.value = entry;
    };
    const fill = () => {
      set("curation-id", "review-agent");
      set("curation-owner", "framework.owner@acme.example");
      set("curation-repository", "acme/catalog");
      set("curation-commit", "a".repeat(40));
      set("curation-path", "agents/review.md");
      set("audit-record", "audit-2026-08");
      set("audit-digest", `sha256:${"b".repeat(64)}`);
    };
    const click = (node: { dispatchEvent(event: unknown): boolean } | null) =>
      node?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    fill();
    click(document.getElementById("add-curation"));
    click(document.querySelector('[data-workbench-action="edit"][data-workbench-kind="curation"]'));
    expect(document.getElementById("add-curation")?.textContent).toBe("Save framework curation");
    click(document.getElementById("clear-policy"));
    expect(document.getElementById("add-curation")?.textContent).toBe("Add framework curation");
    expect(
      (document.getElementById("cancel-curation-edit") as unknown as { hidden: boolean }).hidden,
    ).toBe(true);
    expect(
      (document.getElementById("curation-framework") as unknown as { disabled: boolean }).disabled,
    ).toBe(false);
    fill();
    click(document.getElementById("add-curation"));
    expect(announcement(window)).toBe(
      "External curation intent added; it is report-only and not enforced by AIH.",
    );
    const policy = JSON.parse(preview(window)) as {
      governance: { externalCuration: { items: { id: string }[] }[] };
    };
    expect(
      policy.governance.externalCuration.flatMap((group) => group.items.map((i) => i.id)),
    ).toEqual(["review-agent"]);
  });

  it("closes the ECC MCP panel on Escape from anywhere and returns focus to its opener", () => {
    const { window } = studio(withApproval());
    const document = window.document;
    const panel = document.getElementById("ecc-mcp-sidebar") as unknown as { hidden: boolean };
    document
      .getElementById("open-ecc-mcp")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(panel.hidden).toBe(false);
    (document.activeElement as unknown as { blur(): void } | null)?.blur();
    press(window, "Escape");
    expect(panel.hidden).toBe(true);
    expect(document.activeElement?.id).toBe("open-ecc-mcp");
  });

  it("closes the custom-hook note on Escape from anywhere and returns focus to its opener", () => {
    const { window } = studio(tinyStudioModel());
    const document = window.document;
    const note = document.getElementById("wb-acme-hook-info") as unknown as { hidden: boolean };
    document
      .getElementById("open-custom-hook-info")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(note.hidden).toBe(false);
    press(window, "Escape");
    expect(note.hidden).toBe(true);
    expect(document.activeElement?.id).toBe("open-custom-hook-info");
  });

  it("restores the legacy help tooltips on the curation and custom editors", () => {
    const { window } = studio(tinyStudioModel());
    const document = window.document;
    const tip = (editor: string) => {
      const trigger = document.querySelector(
        `#${editor} > summary + .tip-wrap [data-tooltip-button]`,
      );
      const help = document.getElementById(trigger?.getAttribute("data-tooltip-button") ?? "");
      return [trigger?.getAttribute("aria-label"), help?.getAttribute("role"), help?.textContent];
    };
    expect(tip("curation-editor")).toEqual([
      "About external curation",
      "tooltip",
      "AIH preserves audited curation intent for agents, skills and commands with a pin and an audit record. It never installs, projects or enforces them - ECC and Superpowers do.",
    ]);
    expect(tip("custom-editor")).toEqual([
      "About custom sources",
      "tooltip",
      "A custom MCP is recorded immediately as a fully pinned candidate and stays blocked until a completed scan binds to that exact pin.",
    ]);
  });
});
