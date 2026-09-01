import { Window } from "happy-dom";
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
  window.eval(scripts.join("\n"));
  return window;
}

function open(window: Window, row: string): string {
  const button = window.document.querySelector(`[data-row="${row}"] button.more`);
  if (button === null) throw new Error(`expected details for ${row}`);
  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return window.document.getElementById("drawer-detail")?.textContent ?? "";
}

describe("policy studio drawer explainability", () => {
  it("separates component overview, readiness, and collapsed security evidence", () => {
    const window = studio();
    const detail = open(window, "ecc / baseline: baseline:platform");
    const drawer = window.document.getElementById("drawer-detail");
    const status = drawer?.querySelector(".component-status");
    const security = drawer?.querySelector("details.security-audit");
    expect(detail).toContain("Component overview");
    expect(status?.textContent).toContain("Requires Human Review");
    expect((security as unknown as { open: boolean } | null)?.open).toBe(false);
    expect(security?.querySelector("summary")?.textContent).toContain("Security & Audit");
    expect(security?.textContent).toContain("Automated lifecycle script");
    expect(security?.textContent).toContain("External network connection");
    expect(security?.textContent).toContain("https://api.browser-use.com/mcp");
    expect(security?.textContent).toContain("trust.permission-risk");
    expect(security?.textContent).toContain("trust.external-egress");
    expect(security?.textContent).toContain("aih evidence vet-baseline");
    expect(security?.querySelector(".cap")?.textContent).toBe("AIH administrator command");
    const command = security?.querySelector(".cmdline code")?.textContent ?? "";
    expect(command).toMatch(/^aih /);
    expect(command).toMatch(/ --apply$/);
    expect(security?.querySelector("[data-copy]")?.getAttribute("data-copy")).toBe(command);
    expect(detail).not.toContain("End-user summary:");
    expect(drawer?.querySelector(":scope > .scanner-findings")).toBeNull();
    const css = window.document.querySelector("style")?.textContent ?? "";
    expect(css).toMatch(/\.cmdline code\{[^}]*overflow-x:auto[^}]*white-space:pre/);
    expect(css).toMatch(
      /\.security-body\{[^}]*grid-template-columns:minmax\(0,1fr\)[^}]*min-width:0/,
    );
    expect(css).toMatch(/\.cmdline\{[^}]*max-width:100%[^}]*overflow:hidden/);
    expect(css).toMatch(/\.kv\{[^}]*grid-template-columns:minmax\(0,1fr\)[^}]*min-width:0/);
    expect(css).toMatch(/\.kv div\{[^}]*min-width:0[^}]*max-width:100%/);
    expect(css).toMatch(/\.kv b\{[^}]*overflow-wrap:anywhere[^}]*word-break:break-word/);
    window.close();
  });

  it("shows source-authored agent purpose, scope, and allowed tools", () => {
    const window = studio();
    const detail = open(window, "ecc / agent: agent:code-reviewer");
    expect(detail).toContain("Expert code review specialist");
    expect(detail).toContain("Read, Grep, Glob, Bash");
    expect(detail).toContain("Usage context");
    expect(detail).toContain("agents/code-reviewer.md");
    expect(detail).not.toContain("An ECC agent definition");
    const agentCommand = window.document.querySelector(
      "#drawer-detail details.security-audit .cmdline code",
    )?.textContent;
    expect(agentCommand).toMatch(/^aih evidence vet-baseline .* --apply$/);
    window.close();
  });

  it("shows source-authored skill and MCP descriptions", () => {
    const window = studio();
    expect(open(window, "ecc / skill: skill:browser-qa")).toContain(
      "automate visual testing and UI interaction verification",
    );
    const mcp = open(window, "ECC MCP: jira");
    expect(mcp).toContain("Jira issue tracking");
    expect(mcp).toContain("Usage context");
    expect(mcp).toContain("Requires Human Review");
    expect(mcp).toContain("Credential variables");
    window.close();
  });
});
