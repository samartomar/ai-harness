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
    const { window } = studio({ ...withApproval(), shell: "new" });
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
    const { window } = studio({ ...withApproval(), shell: "new" });
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
    const { window } = studio({ ...tinyStudioModel(), shell: "new" });
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
