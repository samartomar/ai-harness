import { type Element, Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

function studio(): Window {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(policyStudioModel());
  window.document.write(html);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  return window;
}

function click(window: Window, node: Element | null, label: string): void {
  if (node === null) throw new Error(`expected ${label}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function setValue(window: Window, id: string, value: string): void {
  const field = window.document.getElementById(id) as unknown as { value: string } | null;
  if (field === null) throw new Error(`expected #${id}`);
  field.value = value;
}

function inputValue(window: Window, id: string, value: string): void {
  setValue(window, id, value);
  window.document
    .getElementById(id)
    ?.dispatchEvent(new window.Event("input", { bubbles: true, cancelable: true }));
}

describe("policy studio Bring Your Own paths", () => {
  it("separates organization-owned intake from framework curation in the left navigation", () => {
    const window = studio();
    const actions = window.document.getElementById("byo-actions");

    expect(actions?.querySelectorAll(".pop-row")).toHaveLength(2);
    expect(actions?.textContent).toContain("Organization artifacts");
    expect(actions?.textContent).not.toContain("Add organization MCP");
    expect(actions?.textContent).not.toContain("Add organization Skill");
    expect(actions?.textContent).not.toContain("Add organization Agent");
    expect(actions?.textContent).not.toContain("Record external");
    expect(actions?.textContent).toContain("Why custom Hooks are unavailable");
    expect(actions?.textContent).not.toContain("undefined");

    click(window, window.document.getElementById("open-artifacts"), "organization artifacts");
    expect(
      (window.document.getElementById("authoring-sidebar") as unknown as { hidden: boolean })
        .hidden,
    ).toBe(true);
    expect((window.document.body as unknown as { dataset: { view: string } }).dataset.view).toBe(
      "artifacts",
    );
    expect(window.document.getElementById("artifact-intake-review")?.textContent).toContain(
      "shared workspace",
    );

    expect(window.document.getElementById("curation-purpose")?.textContent).toContain(
      "ECC or Superpowers",
    );
    expect(window.document.getElementById("curation-purpose")?.textContent).toContain(
      "not an organization-owned source",
    );
    expect(
      window.document.getElementById("curation-owner")?.closest("label")?.textContent,
    ).toContain("Accountable owner email");

    click(window, window.document.getElementById("open-custom-hook-info"), "custom Hook support");
    expect(
      (window.document.getElementById("drawer") as unknown as { hidden: boolean }).hidden,
    ).toBe(false);
    expect(window.document.getElementById("drawer-detail")?.textContent).toContain(
      "Custom hooks are not supported.",
    );
    expect(window.document.getElementById("drawer-detail")?.textContent).toContain(
      "Only AIH-owned governance and telemetry identities are authorable here.",
    );

    window.close();
  });

  it("guides npm and GitHub discovery without treating directories or READMEs as evidence", () => {
    const window = studio();
    click(window, window.document.getElementById("open-artifacts"), "organization artifacts");

    const workspace = window.document.getElementById("artifact-intake-review");
    expect(workspace?.textContent).toContain("Marketplace and directory links help discovery only");
    const mcpSearchLinks = [...(workspace?.querySelectorAll("a") ?? [])].map((link) =>
      link.getAttribute("href"),
    );
    expect(mcpSearchLinks).toContain("https://mcpmarket.com/");
    expect(mcpSearchLinks).toContain("https://www.skills.sh/");
    expect(mcpSearchLinks).toContain("https://www.npmjs.com/search");
    expect(mcpSearchLinks).toContain("https://github.com/search");

    inputValue(window, "artifact-npm-package", "bad;package");
    inputValue(window, "artifact-npm-version", "0.0.42");
    expect(window.document.getElementById("artifact-source-guide")?.textContent).not.toContain(
      "bad;package",
    );
    expect(window.document.getElementById("artifact-source-guide")?.textContent).not.toContain(
      "npm view",
    );

    inputValue(window, "artifact-npm-package", "@firecrawl");
    inputValue(window, "artifact-npm-version", "4.37.0");
    const incompleteScopeGuide =
      window.document.getElementById("artifact-source-guide")?.textContent ?? "";
    expect(incompleteScopeGuide).toContain("publisher scope alone");
    expect(incompleteScopeGuide).toContain("@scope/package");
    expect(incompleteScopeGuide).not.toContain("npm view");

    inputValue(window, "artifact-npm-package", "firecrawl-mcp");
    inputValue(window, "artifact-npm-version", "3.24.0");
    const unscopedMcpGuide =
      window.document.getElementById("artifact-source-guide")?.textContent ?? "";
    expect(unscopedMcpGuide).toContain(
      'npm view "firecrawl-mcp@3.24.0" name version repository bin dist.tarball dist.integrity --json',
    );
    expect(unscopedMcpGuide).toContain("computes the downloaded tarball SHA-256");

    inputValue(window, "artifact-npm-package", "@playwright/mcp");
    inputValue(window, "artifact-npm-version", "0.0.42");
    const mcpGuide = window.document.getElementById("artifact-source-guide")?.textContent ?? "";
    expect(mcpGuide).toContain(
      'npm view "@playwright/mcp@0.0.42" name version repository bin dist.tarball dist.integrity --json',
    );
    expect(mcpGuide).toContain("observed SHA-512 itself");

    const policy = JSON.parse(
      (window.document.getElementById("config-preview") as unknown as { value: string }).value,
    );
    expect(policy.governance.catalog.custom).toEqual([]);

    setValue(window, "artifact-source-type", "github");
    window.document
      .getElementById("artifact-source-type")
      ?.dispatchEvent(new window.Event("change", { bubbles: true, cancelable: true }));
    inputValue(window, "artifact-github-repository", "microsoft/playwright-cli");
    inputValue(window, "artifact-github-commit", "a".repeat(40));
    inputValue(window, "artifact-source-path", "skills/playwright-cli/SKILL.md");
    const githubGuide = window.document.getElementById("artifact-source-guide")?.textContent ?? "";
    expect(githubGuide).toContain(
      `fetches microsoft/playwright-cli at exact commit ${"a".repeat(40)} once`,
    );
    expect(githubGuide).toContain("does not install or approve");

    window.close();
  });

  it("binds accountable owner email to pending MCP and framework-curation records", () => {
    const window = studio();
    for (const [id, value] of [
      ["custom-id", "acme-mcp"],
      ["custom-owner", "not-an-email"],
      ["custom-package", "@acme/mcp"],
      ["custom-version", "1.2.3"],
      ["custom-integrity", `sha256:${"a".repeat(64)}`],
      ["custom-evidence", "scan-acme-mcp"],
    ] as const)
      setValue(window, id, value);
    window.document
      .getElementById("custom-form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(window.document.getElementById("custom-owner")?.getAttribute("aria-invalid")).toBe(
      "true",
    );

    setValue(window, "custom-owner", "mcp.owner@acme.example");
    window.document
      .getElementById("custom-form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

    for (const [id, value] of [
      ["curation-kind", "skill"],
      ["curation-id", "ecc-review-skill"],
      ["curation-owner", "framework.owner@acme.example"],
      ["curation-repository", "acme/ecc-catalog"],
      ["curation-commit", "b".repeat(40)],
      ["curation-path", "skills/review/SKILL.md"],
      ["audit-record", "audit-ecc-review"],
      ["audit-digest", `sha256:${"c".repeat(64)}`],
    ] as const)
      setValue(window, id, value);
    click(window, window.document.getElementById("add-curation"), "framework curation add");

    const policy = JSON.parse(
      (window.document.getElementById("config-preview") as unknown as { value: string }).value,
    );
    expect(policy.governance.catalog.custom[0].accountableOwner).toBe("mcp.owner@acme.example");
    expect(policy.governance.externalCuration[0].items[0].accountableOwner).toBe(
      "framework.owner@acme.example",
    );
    window.close();
  });
});
