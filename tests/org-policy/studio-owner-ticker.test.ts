import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
const superpowers = model.catalog.frameworks.find((framework) => framework.id === "superpowers");
if (ecc === undefined || superpowers === undefined)
  throw new Error("expected both pinned frameworks in the catalog");
const aihCapabilityPackages = model.catalog.aihSkills.length + model.catalog.aihAgents.length;
const aihMcpRows = new Set([
  ...model.catalog.mcp.map((entry) => entry.id),
  ...model.catalog.eccMcpInventory
    .filter((entry) => entry.owner === "aih")
    .map((entry) => entry.id),
]).size;
const aihRows = aihCapabilityPackages + aihMcpRows + model.catalog.hooks.length;
const governedSkills = ecc.assets.filter((asset) => asset.kind === "skill").length;
const visibleEccInventory =
  ecc.assets.length -
  governedSkills +
  model.catalog.eccSkills.length +
  model.catalog.externalMcp.length;

function studio(): Window {
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

function click(window: Window, selector: string): void {
  const node = window.document.querySelector(selector);
  if (node === null) throw new Error(`expected ${selector}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function visibleGroups(window: Window): string[] {
  return [...window.document.querySelectorAll(".grp[data-owner]")]
    .filter((group) => !(group as unknown as { hidden: boolean }).hidden)
    .map((group) => group.querySelector("h2")?.textContent ?? "");
}

describe("policy studio owner ticker", () => {
  it("shows selection progress instead of filling the meter with unselected inventory", () => {
    const window = studio();
    const progress = (surface: string) => {
      const group = window.document.getElementById(surface);
      if (group === null) throw new Error(`expected ${surface}`);
      return {
        count: group.querySelector(".ct")?.textContent,
        meter: group.querySelector(".meter"),
      };
    };

    expect(progress("surface-aih-skills").count).toBe("0 / 1");
    expect(progress("surface-aih-agents").count).toBe("0 / 2");
    const mcpGroup = [...window.document.querySelectorAll(".grp")].find(
      (group) => group.querySelector("h2")?.textContent === "AIH MCP servers",
    );
    // Every AIH MCP row is selectable now: the projector-backed controls plus the
    // gated AIH-owned declarations that accept requested intent.
    expect(mcpGroup?.querySelector(".ct")?.textContent).toBe(
      `0 / ${
        model.catalog.mcp.length +
        model.catalog.nonProjectableMcp.length +
        model.catalog.unavailableMcp.length
      }`,
    );
    expect(progress("surface-aih-skills").meter?.getAttribute("role")).toBe("progressbar");
    expect(progress("surface-aih-skills").meter?.getAttribute("aria-valuenow")).toBe("0");
    expect(progress("surface-aih-skills").meter?.getAttribute("aria-valuemax")).toBe("1");
    expect(progress("surface-aih-skills").meter?.querySelector("i")).toBeNull();

    click(window, '[data-aih-capability-package="package:skill-pack/docs-quality"]');

    expect(progress("surface-aih-skills").count).toBe("1 / 1");
    expect(progress("surface-aih-skills").meter?.getAttribute("aria-valuenow")).toBe("1");
    expect(progress("surface-aih-skills").meter?.querySelector("i")?.getAttribute("style")).toBe(
      "width:100%",
    );
  });

  it("counts every owner's rows", () => {
    const window = studio();
    const chips = [...window.document.querySelectorAll("#owner-ticker [data-owner-focus]")].map(
      (button) => [button.getAttribute("data-owner-focus"), button.textContent?.trim()],
    );
    expect(chips).toEqual([
      ["all", `All ${aihRows + visibleEccInventory + superpowers.assets.length}`],
      ["AIH", `AIH ${aihRows}`],
      ["ECC", `ECC ${visibleEccInventory}`],
      ["Superpowers", `Superpowers ${superpowers.assets.length}`],
      ["You", "Your sources 0"],
    ]);
  });

  // Focus is a view. It must never touch the authored policy, or a focused
  // surface and the document it produces could disagree.
  it("focuses one surface without changing the policy", () => {
    const window = studio();
    const preview = () =>
      (window.document.getElementById("config-preview") as unknown as { value: string }).value;
    const before = preview();
    click(window, '[data-owner-focus="AIH"]');
    expect(visibleGroups(window)).toEqual([
      "AIH Skills",
      "AIH Agents",
      "AIH MCP servers",
      "AIH-Governance & Telemetry Hooks",
      "Approval / evidence",
    ]);
    expect(preview(), "focus authored nothing").toBe(before);
    click(window, '[data-owner-focus="Superpowers"]');
    expect(visibleGroups(window)).toContain("Superpowers");
    expect(visibleGroups(window)).not.toContain("AIH MCP servers");
    click(window, '[data-owner-focus="ECC"]');
    expect(visibleGroups(window)).toContain("ECC-Guardrails & Safety Hooks");
    expect(visibleGroups(window)).not.toContain("Hook registrar");
    click(window, '[data-owner-focus="all"]');
    expect(visibleGroups(window).length).toBeGreaterThan(10);
  });

  it("declares only approved upcoming surfaces", () => {
    const window = studio();
    const soon = window.document.querySelector("#owner-ticker .soon")?.textContent ?? "";
    expect(soon).toBe("soon Voice");
  });
});
