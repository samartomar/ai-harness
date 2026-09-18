/**
 * The new shell's organization screen (NEW-SHELL-PLAN.md S6): deployment
 * setup, developer tools, adoption recipe, evidence and versions, and the
 * ECC hook controls, with the legacy runtime's messages and policy writes.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { PolicyStudioModel } from "../../../src/org-policy/studio-model.js";
import { tinyStudioModel } from "../studio-test-fixture.js";
import {
  announcement,
  click,
  closeStudios,
  preview,
  setValue,
  sha,
  studio,
} from "./shell-parity-harness.js";

afterEach(closeStudios);

/** The tiny fixture declares no hosts; the chips need two. */
function withHosts(model: PolicyStudioModel = tinyStudioModel()): PolicyStudioModel {
  (model.catalog as unknown as { hosts: unknown[] }).hosts = [
    { id: "claude", label: "Claude Code", policyTarget: true, mcpSupport: "managed" },
    { id: "codex", label: "Codex", policyTarget: true, mcpSupport: "managed" },
  ];
  return model;
}

function newShell(model: PolicyStudioModel = withHosts()) {
  return studio({ ...model, shell: "new" }).window;
}

function policy(window: ReturnType<typeof newShell>): Record<string, unknown> {
  return JSON.parse(preview(window)) as Record<string, unknown>;
}

describe("new shell organization screen", () => {
  it("mounts deployment setup, developer tools and ECC hooks in the organization screen", () => {
    const document = newShell().document;
    const screen = document.querySelector('[data-wb-screen-panel="org"] [data-wb-org]');
    expect(screen).not.toBeNull();
    expect(document.querySelector('[data-wb-pending-screen="org"]')).toBeNull();
    for (const id of [
      "policy-settings",
      "posture",
      "supported-cli-hosts",
      "supported-cli-count",
      "managed-mcp-projection",
      "deployment-readiness",
      "developer-tool-selection",
      "developer-tool-rows",
      "adoption-recipe",
      "surface-ecc-hooks",
      "ecc-hook-controls",
    ])
      expect(screen?.querySelector(`#${id}`), id).not.toBeNull();
    expect(document.getElementById("deployment-readiness")?.textContent).toBe(
      "No Core controls selected. Choose controls after setting the hosts and posture you intend to use.",
    );
    expect(document.querySelectorAll("[data-sanctioned-cli]").length).toBeGreaterThan(0);
    expect(document.getElementById("supported-cli-count")?.textContent).toBe("0 selected");
    expect(document.querySelectorAll("[data-developer-tool-id]")).toHaveLength(7);
  });

  it("refuses Enterprise without an allowed CLI, then records posture and the allow-list", () => {
    const window = newShell();
    const before = preview(window);
    setValue(window, "posture", "enterprise");
    expect(announcement(window)).toBe(
      "Enterprise posture was not applied. Select at least one Allowed CLI first, or choose the Enterprise preset to explicitly sanction every supported CLI and compose Core.",
    );
    expect(preview(window)).toBe(before);
    expect((window.document.getElementById("posture") as unknown as { value: string }).value).toBe(
      "vibe",
    );
    window.document
      .querySelector('[data-sanctioned-cli="claude"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(announcement(window)).toContain("Supported CLI allow-list updated: claude.");
    expect(window.document.getElementById("supported-cli-count")?.textContent).toBe("1 selected");
    expect((policy(window).governance as { supportedClis?: string[] }).supportedClis).toEqual([
      "claude",
    ]);
    setValue(window, "posture", "enterprise");
    expect(announcement(window)).toBe("Posture changed without modifying selections.");
    expect(policy(window).minimumPosture).toBe("enterprise");
  });

  it("toggles managed MCP projection with the legacy messages", () => {
    const window = newShell();
    const toggle = window.document.getElementById("managed-mcp-projection") as unknown as {
      checked: boolean;
      dispatchEvent(event: unknown): boolean;
    };
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(announcement(window)).toBe(
      "Managed MCP projection enabled for selected Core MCP controls. It is saved only when those controls are present.",
    );
    toggle.checked = false;
    toggle.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(announcement(window)).toBe(
      "Managed MCP projection disabled. No server was contacted or changed.",
    );
  });

  it("writes evidence and versions rows as text, never as markup", () => {
    const model = tinyStudioModel();
    model.evidenceDelivery = {
      coreVersion: "0.5.0",
      workbenchCatalogDigest: sha("c"),
      vendorLockDigest: sha("d"),
      scannerLibraryVersion: "0.3.0",
      expectedScannerPublisher: {
        repository: "fixture/scan",
        workflow: "fixture/scan/.github/workflows/publish.yml",
        ref: "refs/heads/main",
        commit: "a".repeat(40),
      },
      publicBaseline: {
        publisher: "fixture/core<script>",
        workflow: "fixture/core/.github/workflows/vendor.yml",
        artifactDigest: sha("b"),
        verifiedAt: "2026-09-06T00:00:00Z",
        validUntil: "2026-09-07T00:00:00Z",
      },
    };
    const document = newShell(withHosts(model)).document;
    const evidence = document.getElementById("evidence-delivery");
    expect(evidence?.tagName).toBe("DETAILS");
    expect(evidence?.querySelector("summary")?.textContent).toBe("Evidence & versions");
    expect(evidence?.textContent).toContain("Evidence & versions · Core 0.5.0");
    expect(evidence?.textContent).toContain(`This Workbench catalog${sha("c")}`);
    expect(evidence?.textContent).toContain("Verification during Core release preparation");
    expect(evidence?.textContent).toContain("fixture/core<script>");
    expect(evidence?.querySelector("script")).toBeNull();
    expect(evidence?.textContent).toContain("A scan does not grant organization approval.");
    expect(document.getElementById("evidence-delivery-close")?.getAttribute("aria-label")).toBe(
      "Close evidence and versions",
    );
  });

  it("opens the adoption recipe from its toggle and closes it", () => {
    const window = newShell();
    const panel = window.document.getElementById("adoption-recipe-panel") as unknown as {
      hidden: boolean;
    };
    expect(panel.hidden).toBe(true);
    click(window, "adoption-recipe-toggle");
    expect(panel.hidden).toBe(false);
    expect(
      window.document.getElementById("adoption-recipe-toggle")?.getAttribute("aria-expanded"),
    ).toBe("true");
    click(window, "adoption-recipe-close");
    expect(panel.hidden).toBe(true);
  });
});
