import { type Element, Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { ECC_DECLARABLE_COMPONENT_IDS } from "../../src/ecc/components.js";
import { mcpServers } from "../../src/mcp/servers.js";
import { policyAuthoringCatalog } from "../../src/org-policy/catalog.js";
import {
  eccExternalMcpCatalog,
  eccMcpCatalogInventory,
} from "../../src/org-policy/ecc-mcp-catalog.js";
import {
  ECC_SKILL_CATALOG_PROVENANCE,
  eccSkillCatalogInventory,
} from "../../src/org-policy/ecc-skill-catalog.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

/** The three kinds `governance.externalCuration` accepts (schema.ts). */
const CURATION_KINDS = ["agent", "skill", "command"];

function allAssets() {
  return policyAuthoringCatalog().frameworks.flatMap((framework) => framework.assets);
}

function countByKind(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function loadStudio(window: Window, html: string): void {
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0 || scripts.some((script) => script === undefined)) {
    throw new Error("expected generated workbench script");
  }
  window.eval(scripts.join("\n"));
}

function click(window: Window, selector: string): void {
  const node = window.document.querySelector(selector);
  if (node === null) throw new Error(`expected ${selector}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

describe("policy authoring catalog inventory", () => {
  it("classifies the exact first-party Core packs as one AIH Skill and two AIH Agents", () => {
    expect(policyStudioModel().catalog.aihSkills).toEqual([
      {
        id: "package:skill-pack/docs-quality",
        pack: "docs-quality",
        description: expect.stringContaining("BetterDoc"),
        skills: ["aih-betterdoc"],
        sources: [
          {
            skill: "aih-betterdoc",
            path: "packs/docs-quality/aih-betterdoc",
            manifestIdentity: "local",
          },
        ],
      },
    ]);
    expect(policyStudioModel().catalog.aihAgents).toEqual([
      {
        id: "package:skill-pack/governance-quality",
        pack: "governance-quality",
        description: expect.stringContaining("Governance Doctor"),
        skills: ["aih-gov-doctor"],
        sources: [
          {
            skill: "aih-gov-doctor",
            path: "packs/governance-quality/aih-gov-doctor",
            manifestIdentity: "local",
          },
        ],
      },
      {
        id: "package:skill-pack/review-quality",
        pack: "review-quality",
        description: expect.stringContaining("isolated BUGBOUNTY agent workflow"),
        skills: ["aih-bugbounty"],
        sources: [
          {
            skill: "aih-bugbounty",
            path: "packs/review-quality/aih-bugbounty",
            manifestIdentity: "local",
          },
        ],
      },
    ]);
  });

  it("shows AIH Skills and Agents as real capability-package selections and round-trips them", () => {
    const window = new Window({ url: "http://localhost/" });
    const html = policyStudioHtml(policyStudioModel());
    window.document.write(html);
    loadStudio(window, html);

    const group = window.document.getElementById("surface-aih-skills");
    const agents = window.document.getElementById("surface-aih-agents");
    expect(group?.textContent).toContain("AIH Skills");
    expect(agents?.textContent).toContain("AIH Agents");
    expect(group?.querySelector(".rid")?.textContent?.trim()).toBe("aih-betterdoc");
    expect(group?.textContent).not.toContain("aih-bugbounty");
    expect(
      [...(agents?.querySelectorAll(".rid") ?? [])].map((row) => row.textContent?.trim()),
    ).toEqual(["aih-gov-doctor", "aih-bugbounty"]);
    expect(agents?.textContent).not.toContain("aih-betterdoc");
    expect(group?.querySelector(".rid")?.getAttribute("aria-label")).toBe("aih-betterdoc");
    expect(agents?.querySelector(".rid")?.getAttribute("aria-label")).toBe("aih-gov-doctor");
    expect(group?.querySelector(".more")?.getAttribute("aria-label")).toBe(
      "Details for aih-betterdoc",
    );
    expect(group?.querySelector(".concept-icon")?.getAttribute("data-concept")).toBe("skill");
    expect(agents?.querySelector(".concept-icon")?.getAttribute("data-concept")).toBe("agent");
    expect(group?.querySelector(".concept-icon svg")?.classList.contains("lucide-blocks")).toBe(
      true,
    );
    expect(agents?.querySelector(".concept-icon svg")?.classList.contains("lucide-bot")).toBe(true);
    expect(group?.querySelector(".row .concept-icon")).toBeNull();
    expect(agents?.querySelector(".row .concept-icon")).toBeNull();
    expect(group?.textContent).not.toContain("Enter your approved skill catalog");
    expect(group?.querySelector("input")).toBeNull();
    expect(agents?.querySelector("input")).toBeNull();
    expect(window.document.querySelectorAll("[data-aih-capability-package]")).toHaveLength(3);
    expect(window.document.querySelector('[data-sidebar-jump="aih-skills"]')).toBeNull();
    expect(policyStudioModel().catalog.aihCapabilityCatalog).toEqual({
      provider: "github",
      repository: "samartomar/aih-catalog",
    });

    const first = window.document.querySelector(
      '[data-aih-capability-package="package:skill-pack/docs-quality"]',
    );
    if (first === null) throw new Error("expected first-party AIH skill pack control");
    first.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    const authored = JSON.parse(
      (window.document.getElementById("config-preview") as unknown as { value: string }).value,
    ) as {
      capabilityPackages?: { catalog: { repository: string }; roots: string[] };
    };
    expect(authored.capabilityPackages).toEqual({
      catalog: { provider: "github", repository: "samartomar/aih-catalog" },
      roots: ["package:skill-pack/docs-quality"],
    });

    const selectedFirst = window.document.querySelector(
      '[data-aih-capability-package="package:skill-pack/docs-quality"]',
    );
    if (selectedFirst === null) throw new Error("expected selected first-party AIH skill pack");
    selectedFirst.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const cleared = JSON.parse(
      (window.document.getElementById("config-preview") as unknown as { value: string }).value,
    ) as { capabilityPackages?: unknown };
    expect(cleared).not.toHaveProperty("capabilityPackages");
  });

  it("shows truthful packaged proof and execution boundaries for every first-party AIH capability", () => {
    const window = new Window({ url: "http://localhost/" });
    const html = policyStudioHtml(policyStudioModel());
    window.document.write(html);
    loadStudio(window, html);

    const expected = [
      {
        skill: "aih-betterdoc",
        kind: "Skill",
        root: "package:skill-pack/docs-quality",
        source: "packs/docs-quality/aih-betterdoc",
      },
      {
        skill: "aih-gov-doctor",
        kind: "Agent",
        root: "package:skill-pack/governance-quality",
        source: "packs/governance-quality/aih-gov-doctor",
      },
      {
        skill: "aih-bugbounty",
        kind: "Agent",
        root: "package:skill-pack/review-quality",
        source: "packs/review-quality/aih-bugbounty",
      },
    ];

    for (const item of expected) {
      click(window, `[data-detail="${item.skill}"]`);
      const drawer = window.document.getElementById("drawer-detail");
      expect(drawer?.querySelector("h2")?.textContent).toBe(item.skill);
      expect(drawer?.textContent).toContain("@aihq/core@0.4.3");
      expect(drawer?.textContent).toContain(item.root);
      expect(drawer?.textContent).toContain(item.source);
      expect(drawer?.textContent).toContain("Manifest identitylocal");
      expect(drawer?.textContent).toContain(item.kind);
      if (item.kind === "Agent") {
        expect(drawer?.textContent).toContain("Isolated worker required");
        expect(drawer?.textContent).toContain("does not launch the worker");
      }
      expect(drawer?.querySelector("[data-proof-status]")?.textContent).toContain(
        "Qualification proof is still pending",
      );
      expect(drawer?.textContent).not.toContain("undefined");
    }
  });

  it("carries the source-locked ECC external MCP inventory outside AIH controls", () => {
    const model = policyStudioModel();
    expect(model.catalog.eccMcpInventory).toEqual(eccMcpCatalogInventory);
    expect(model.catalog.eccMcpInventory).toHaveLength(35);
    expect(model.catalog.externalMcp).toEqual(eccExternalMcpCatalog);
    expect(model.catalog.externalMcp).toHaveLength(31);
    expect(
      model.catalog.externalMcp.every(
        (entry) => !("control" in entry) && !("server" in entry) && entry.owner === "ecc",
      ),
    ).toBe(true);
  });

  it("renders every source-locked ECC skill and external MCP availability row", () => {
    const window = new Window({ url: "http://localhost/" });
    const model = policyStudioModel();
    const html = policyStudioHtml(model);
    window.document.write(html);
    loadStudio(window, html);

    expect(
      window.document.getElementById("ecc-skill-rows")?.closest("section")?.querySelector("h2")
        ?.textContent,
    ).toBe("ECC skills");
    expect(ECC_SKILL_CATALOG_PROVENANCE.commit).toBe("5caf398a91599029a176ca6d806409b00d1052c4");
    expect(eccSkillCatalogInventory).toHaveLength(286);
    expect(eccSkillCatalogInventory.map((skill) => skill.id)).toEqual(
      eccSkillCatalogInventory.map((skill) => skill.id).sort(),
    );
    expect(model.catalog.eccSkills).toEqual(eccSkillCatalogInventory);
    expect(
      [...window.document.querySelectorAll("[data-ecc-skill-availability]")].map((row) =>
        row.getAttribute("data-ecc-skill-availability"),
      ),
    ).toEqual(eccSkillCatalogInventory.map((skill) => skill.id));
    expect(
      [...window.document.querySelectorAll("[data-ecc-mcp-availability]")]
        .map((row) => row.getAttribute("data-ecc-mcp-availability"))
        .sort(),
    ).toEqual(eccMcpCatalogInventory.map((entry) => entry.id).sort());

    expect(eccSkillCatalogInventory.every((item) => item.governable)).toBe(true);
    expect(ECC_DECLARABLE_COMPONENT_IDS).not.toContain("skill:accessibility");
    for (const mcp of eccMcpCatalogInventory.filter((item) => item.owner === "aih")) {
      const row = window.document.querySelector(`[data-ecc-mcp-availability="${mcp.id}"]`);
      const hasAihControl = model.catalog.mcp.some((control) => control.id === mcp.id);
      expect(row?.getAttribute("data-state")).toBe(hasAihControl ? "pending" : "availability");
      expect(row?.querySelector(`[data-reviewed="${mcp.id}"]`) !== null).toBe(hasAihControl);
      expect(row?.querySelector("[data-ecc-mcp-approval]")).toBeNull();
    }
  });

  it("keeps every ECC Skill under center-panel authority", () => {
    const window = new Window({ url: "http://localhost/" });
    const model = policyStudioModel();
    const html = policyStudioHtml(model);
    window.document.write(html);
    loadStudio(window, html);

    const rows = [
      ...window.document.querySelectorAll("#ecc-skill-rows [data-ecc-skill-availability]"),
    ];
    expect(rows).toHaveLength(eccSkillCatalogInventory.length);
    for (const skill of eccSkillCatalogInventory) {
      const control = window.document.querySelector(
        `[data-ecc-skill-availability="${skill.id}"] [data-framework-select="ecc|skill|skill:${skill.id}"]`,
      );
      expect(control, `${skill.id} has a center selection control`).not.toBeNull();
      expect(control?.hasAttribute("disabled"), `${skill.id} is enabled`).toBe(false);
      expect(control?.getAttribute("aria-disabled"), `${skill.id} is not aria-disabled`).not.toBe(
        "true",
      );
    }

    const accessibility =
      '[data-ecc-skill-availability="accessibility"] [data-framework-select="ecc|skill|skill:accessibility"]';
    click(window, accessibility);
    let policy = JSON.parse(
      (window.document.getElementById("config-preview") as unknown as { value: string }).value,
    ) as {
      governance?: {
        externalSelections?: Array<{ roots?: string[]; items: Array<{ id: string }> }>;
      };
    };
    expect(policy.governance?.externalSelections?.[0]?.roots).toContain("skill:accessibility");
    expect(policy.governance?.externalSelections?.[0]?.items.map((item) => item.id)).toContain(
      "skill:accessibility",
    );

    click(window, accessibility);
    policy = JSON.parse(
      (window.document.getElementById("config-preview") as unknown as { value: string }).value,
    );
    expect(policy.governance?.externalSelections ?? []).toHaveLength(0);
  });

  it("binds every selectable ECC Skill to the authoritative lifecycle catalog", () => {
    const baselineSkillIds = baselineCatalogById("ecc")
      .components.filter((component) => component.id.startsWith("skill:"))
      .map((component) => component.id)
      .sort();

    expect(baselineSkillIds).toEqual(
      eccSkillCatalogInventory.map((skill) => `skill:${skill.id}`).sort(),
    );
  });

  it("places selectable ECC MCP declarations inside the ECC MCP catalog", () => {
    const window = new Window({ url: "http://localhost/" });
    const model = policyStudioModel();
    const html = policyStudioHtml(model);
    window.document.write(html);
    loadStudio(window, html);

    const catalog = window.document.getElementById("surface-ecc-mcp-catalog");
    const declarations =
      model.catalog.frameworks
        .find((framework) => framework.id === "ecc")
        ?.assets.filter((asset) => asset.kind === "mcp") ?? [];

    expect(catalog).not.toBeNull();
    expect(catalog?.textContent).toContain("Selectable ECC MCP declarations");
    expect(catalog?.textContent).toContain("Approval catalog entries");
    expect(catalog?.querySelectorAll("[data-ecc-mcp-availability]")).toHaveLength(
      model.catalog.eccMcpInventory.filter((entry) => entry.owner === "ecc").length,
    );
    expect(catalog?.querySelectorAll('[data-framework-select^="ecc|mcp|"]')).toHaveLength(
      declarations.length,
    );
    expect(
      window.document.querySelectorAll("#framework-rows [data-framework-select^='ecc|mcp|']"),
    ).toHaveLength(0);
    expect(
      [...window.document.querySelectorAll("section.grp > .grphead h2")].filter(
        (heading) => heading.textContent === "ECC MCP declarations",
      ),
    ).toHaveLength(0);

    const first = declarations[0];
    if (first === undefined) throw new Error("expected a selectable ECC MCP declaration");
    click(window, `[data-framework-select="ecc|mcp|${first.id}"]`);
    const authored = JSON.parse(
      (window.document.getElementById("config-preview") as unknown as { value: string }).value,
    ) as { governance?: { externalSelections?: Array<{ framework: string; items: unknown[] }> } };
    expect(authored.governance?.externalSelections).toEqual([
      {
        framework: "ecc",
        items: [expect.objectContaining({ kind: "mcp", id: first.id })],
        roots: [first.id],
      },
    ]);
  });

  it("coalesces AIH controls and AIH-owned ECC declarations by MCP identity", () => {
    const window = new Window({ url: "http://localhost/" });
    const model = policyStudioModel();
    const html = policyStudioHtml(model);
    window.document.write(html);
    loadStudio(window, html);

    const servers = window.document.getElementById("surface-aih-mcp-servers");
    const declarations = model.catalog.eccMcpInventory.filter((entry) => entry.owner === "aih");
    const shared = declarations.filter((declaration) =>
      model.catalog.mcp.some((control) => control.id === declaration.id),
    );
    const availabilityOnly = declarations.filter(
      (declaration) => !model.catalog.mcp.some((control) => control.id === declaration.id),
    );
    const uniqueIds = new Set([
      ...model.catalog.mcp.map((control) => control.id),
      ...declarations.map((declaration) => declaration.id),
    ]);

    expect(servers).not.toBeNull();
    expect(servers?.textContent).toContain("Unique MCP identities");
    expect(servers?.textContent).not.toContain("ECC declarations assigned to AIH");
    expect(servers?.querySelectorAll("#mcp-rows > .row")).toHaveLength(uniqueIds.size);
    expect(servers?.querySelectorAll("#mcp-rows [data-reviewed]")).toHaveLength(
      model.catalog.mcp.length,
    );
    expect(servers?.querySelectorAll("#mcp-rows [data-ecc-mcp-availability]")).toHaveLength(
      declarations.length,
    );

    for (const declaration of shared) {
      const row = servers?.querySelector(
        `#mcp-rows > [data-ecc-mcp-availability="${declaration.id}"]`,
      );
      expect(row?.querySelector(`[data-reviewed="${declaration.id}"]`)).not.toBeNull();
      expect(row?.textContent).toContain("Also declared by ECC");
    }
    for (const declaration of availabilityOnly) {
      const row = servers?.querySelector(
        `#mcp-rows > [data-ecc-mcp-availability="${declaration.id}"]`,
      );
      expect(row?.getAttribute("data-state")).toBe("availability");
      expect(row?.textContent).toContain("Runtime availability only");
      expect(
        row?.querySelector("[data-reviewed], [data-framework-select], [data-ecc-mcp-approval]"),
      ).toBeNull();
    }

    const firstShared = shared[0];
    if (firstShared === undefined) throw new Error("expected a shared AIH/ECC MCP identity");
    click(window, `[data-detail="${firstShared.id}"]`);
    const drawer = window.document.getElementById("drawer-detail");
    expect(drawer?.textContent).toContain("Also declared by ECC");
    expect(drawer?.textContent).toContain(model.catalog.eccMcpProvenance.repository);
    expect(drawer?.textContent).toContain(model.catalog.eccMcpProvenance.commit);

    click(window, "#seek");
    const query = window.document.getElementById("spot-q") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    } | null;
    if (query === null) throw new Error("expected search input");
    query.value = firstShared.id;
    query.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(window.document.querySelectorAll(`#hits [data-hit="${firstShared.id}"]`)).toHaveLength(
      1,
    );
    expect(
      window.document.querySelectorAll(`#hits [data-hit="ECC MCP: ${firstShared.id}"]`),
    ).toHaveLength(0);
    expect(
      [...window.document.querySelectorAll("section.grp > .grphead h2")].filter(
        (heading) => heading.textContent === "AIH-owned MCP declarations in ECC",
      ),
    ).toHaveLength(0);
  });

  it("offers only projector-backed MCP identities as center-panel controls", () => {
    const window = new Window({ url: "http://localhost/" });
    const model = policyStudioModel();
    const html = policyStudioHtml(model);
    window.document.write(html);
    loadStudio(window, html);

    expect(model.catalog.mcp.every((item) => item.server.type === "stdio")).toBe(true);
    for (const id of ["github", "context7"]) {
      expect(model.catalog.mcp.some((item) => item.id === id)).toBe(false);
      const row = window.document.querySelector(`#mcp-rows [data-ecc-mcp-availability="${id}"]`);
      expect(row, `${id} remains visible as availability`).not.toBeNull();
      expect(row?.querySelector("[data-reviewed]")).toBeNull();
      expect(row?.textContent).toContain("not policy-projectable");
    }
  });

  it("keeps selectable Skills inspectable and routes every MCP through approval authoring", () => {
    const window = new Window({ url: "http://localhost/" });
    const model = policyStudioModel();
    const html = policyStudioHtml(model);
    window.document.write(html);
    loadStudio(window, html);
    const skill = eccSkillCatalogInventory.find((item) => item.id === "accessibility");
    if (skill === undefined) throw new Error("expected the accessibility Skill");

    click(window, "#seek");
    const query = window.document.getElementById("spot-q") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    } | null;
    if (query === null) throw new Error("expected search input");
    query.value = skill.id;
    query.dispatchEvent(new window.Event("input", { bubbles: true }));
    click(window, "#hits .hit");
    expect(window.document.getElementById("drawer-detail")?.textContent).toContain(skill.path);
    expect(window.document.getElementById("drawer-detail")?.textContent).toContain(
      "Authored intent: not selected",
    );
    expect(window.document.getElementById("drawer-detail")?.textContent).toContain(
      "--components skill:accessibility --apply",
    );

    for (const mcp of eccExternalMcpCatalog) {
      const action = [...window.document.querySelectorAll("[data-ecc-mcp-approval]")].find(
        (node) => node.getAttribute("data-ecc-mcp-approval") === mcp.id,
      );
      if (action === undefined) throw new Error(`expected approval action for ${mcp.id}`);
      action.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      expect(window.document.getElementById("ecc-mcp-sidebar")?.hasAttribute("hidden")).toBe(false);
      const select = window.document.getElementById("ecc-mcp-id");
      if (select === null) throw new Error("expected ECC MCP approval select");
      expect((select as unknown as { value: string }).value).toBe(mcp.id);
    }
  });

  it("offers AIH-delivered Playwright as an unrequested, selectable web control", () => {
    const window = new Window({ url: "http://localhost/" });
    const model = policyStudioModel();
    const html = policyStudioHtml(model);
    window.document.write(html);
    loadStudio(window, html);

    expect(model.catalog.mcp.find((entry) => entry.id === "playwright")?.availability).toBe(
      "web-target",
    );
    const control = window.document.querySelector('[data-reviewed="playwright"]');
    expect(control).not.toBeNull();
    expect(control?.getAttribute("aria-pressed")).toBe("false");
    expect(control?.hasAttribute("disabled")).toBe(false);

    control?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const authored = JSON.parse(
      (window.document.getElementById("config-preview") as unknown as { value: string }).value,
    ) as { governance?: { catalog?: { reviewed?: Array<{ id: string }> } } };
    expect(authored.governance?.catalog?.reviewed?.map((entry) => entry.id)).toContain(
      "playwright",
    );

    const selected = window.document.querySelector('[data-reviewed="playwright"]');
    expect(selected?.getAttribute("aria-pressed")).toBe("true");
    expect(selected?.hasAttribute("disabled")).toBe(false);
    selected?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    const removed = JSON.parse(
      (window.document.getElementById("config-preview") as unknown as { value: string }).value,
    ) as { governance?: { catalog?: { reviewed?: Array<{ id: string }> } } };
    expect(removed.governance?.catalog?.reviewed?.map((entry) => entry.id)).not.toContain(
      "playwright",
    );
  });

  it("keeps Playwright target-derived after the no-repository Workbench authors it", () => {
    const stack = {
      languages: [],
      frameworks: [],
      cloud: [],
      databases: [],
      deployment: [],
      hasTypeScript: false,
      scripts: {},
      entryPoints: [],
      browserTest: false,
      isMonorepo: false,
      virtualEnvPaths: [],
    };
    expect(mcpServers("project", stack)).not.toHaveProperty("playwright");
    expect(mcpServers("project", { ...stack, frameworks: ["React"] })).toHaveProperty("playwright");
  });

  it("keeps every shipped surface reachable in the adopted Workbench shell", () => {
    const window = new Window({ url: "http://localhost/" });
    const model = policyStudioModel();
    const html = policyStudioHtml(model);
    window.document.write(html);
    loadStudio(window, html);

    const sidebar = window.document.getElementById("side");
    const aihSkills = window.document.getElementById("surface-aih-skills");
    const aihAgents = window.document.getElementById("surface-aih-agents");
    const adoption = window.document.getElementById("adoption-recipe");
    expect(sidebar?.textContent).not.toContain("AIH Skills");
    expect(sidebar?.textContent).toContain("Languages");
    expect(sidebar?.textContent).toContain("Frameworks");
    expect(sidebar?.textContent).toContain("Capabilities");
    expect(sidebar?.textContent).toContain("ECC modules");
    expect(sidebar?.textContent).toContain("Allowed CLI");
    expect(sidebar?.textContent).toContain("CLI usages");
    expect(sidebar?.textContent).not.toContain("Hosts");
    expect(sidebar?.textContent).toContain("AIH policy");
    expect(sidebar?.textContent).toContain("ECC catalog");
    expect(sidebar?.textContent).toContain("Bring Your Own");
    expect(sidebar?.textContent).not.toContain("Other sources");
    expect(sidebar?.textContent).not.toContain("Approve ECC MCP");
    expect(window.document.getElementById("byo-actions")?.textContent).toContain(
      "Organization artifacts",
    );
    expect(
      window.document.getElementById("byo-actions")?.querySelectorAll(".pop-row"),
    ).toHaveLength(2);
    expect(window.document.getElementById("preset-poplist")?.textContent).toContain("Allowed CLI");
    expect(window.document.getElementById("preset-poplist")?.textContent).toContain("CLI usages");
    expect(window.document.getElementById("rail-poplist")?.textContent).not.toContain(
      "Allowed CLI",
    );
    const repositoryLink = window.document.querySelector(
      'a[href="https://github.com/samartomar/ai-harness"]',
    );
    expect(repositoryLink?.getAttribute("aria-label")).toBe("Open AIH on GitHub");
    expect(repositoryLink?.getAttribute("target")).toBe("_blank");
    expect(repositoryLink?.getAttribute("rel")?.split(/\s+/)).toEqual(
      expect.arrayContaining(["noopener", "noreferrer"]),
    );
    expect(window.document.getElementById("download")?.nextElementSibling).toBe(repositoryLink);
    expect(repositoryLink?.nextElementSibling).toBe(window.document.getElementById("export"));

    click(window, '[title="CLI usages"]');
    const cliUsageRow = [...window.document.querySelectorAll("#preset-poplist > .pop-row")].find(
      (row) => row.textContent?.includes("CLI usages"),
    );
    const cliUsagePopover = cliUsageRow?.nextElementSibling;
    expect(cliUsagePopover?.getAttribute("data-open")).toBe("true");
    expect(cliUsagePopover?.textContent).toContain("aih heal --scope certs --apply");
    expect(cliUsagePopover?.textContent).toContain("aih heal --scope npm --apply");
    expect(cliUsagePopover?.textContent).toContain("aih heal --scope path --apply");
    expect(cliUsagePopover?.textContent).toContain("aih heal --scope mcp --apply");
    expect(cliUsagePopover?.textContent).toContain("aih certs --apply");
    expect(cliUsagePopover?.textContent).toContain("aih tools --apply");
    expect(cliUsagePopover?.textContent).toContain("aih ready");
    expect(cliUsagePopover?.textContent).toContain("aih doctor");
    expect(cliUsagePopover?.textContent).toContain("No dedicated AIH SSH repair command");
    expect(cliUsagePopover?.textContent).not.toContain("aih heal --scope ssh");
    expect(window.document.querySelectorAll("[data-view-tab]")).toHaveLength(4);
    expect(window.document.querySelectorAll("[data-aih-capability-package]")).toHaveLength(
      model.catalog.aihSkills.length + model.catalog.aihAgents.length,
    );
    expect(window.document.querySelectorAll("[data-ecc-mcp-availability]")).toHaveLength(
      model.catalog.eccMcpInventory.length,
    );
    expect(window.document.querySelectorAll("[data-ecc-skill-availability]")).toHaveLength(
      model.catalog.eccSkills.length,
    );
    const plane = window.document.getElementById("framework-rows")?.parentElement ?? null;
    const ownerTicker = window.document.getElementById("owner-ticker");
    const planeTop = plane?.querySelector(".planetop") ?? null;
    if (plane === null || ownerTicker === null || planeTop === null) {
      throw new Error("expected framework plane ordering surfaces");
    }
    const planeChildren = [...plane.children];
    expect(planeChildren.indexOf(ownerTicker as Element)).toBeLessThan(
      planeChildren.indexOf(planeTop as Element),
    );
    expect(
      [...window.document.querySelectorAll("#rail-poplist > .pop-row")].map((row) =>
        row.querySelector(".pl")?.textContent?.trim(),
      ),
      "the largest ECC menu stays first so its popover gets the full viewport height",
    ).toEqual(["ECC modules", "Languages", "Frameworks", "Capabilities"]);

    const modulesMenu = [...window.document.querySelectorAll("#side .pop-row")].find((row) =>
      row.textContent?.includes("ECC modules"),
    );
    if (modulesMenu === undefined) throw new Error("expected ECC modules menu");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 360 });
    Object.defineProperty(modulesMenu, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ bottom: 352, height: 32, left: 0, right: 250, top: 320, width: 250 }),
    });
    click(window, '[title="ECC modules"]');
    const modulesPopover = modulesMenu.nextElementSibling as unknown as {
      getAttribute: (name: string) => string | null;
      style: { maxHeight: string; top: string };
    } | null;
    if (modulesPopover === null) throw new Error("expected ECC modules popover");
    expect(modulesPopover.getAttribute("data-open")).toBe("true");
    const popoverBottom =
      Number.parseFloat(modulesPopover.style.top) +
      Number.parseFloat(modulesPopover.style.maxHeight);
    expect(popoverBottom).toBeLessThanOrEqual(348);

    expect(aihSkills).not.toBeNull();
    expect(aihSkills?.querySelectorAll("[data-aih-capability-package]")).toHaveLength(
      model.catalog.aihSkills.length,
    );
    expect(aihAgents).not.toBeNull();
    expect(aihAgents?.querySelectorAll("[data-aih-capability-package]")).toHaveLength(
      model.catalog.aihAgents.length,
    );
    const conceptFor = (label: string) =>
      [...window.document.querySelectorAll("section.grp .grphead h2")]
        .find((heading) => heading.textContent === label)
        ?.querySelector(".concept-icon")
        ?.getAttribute("data-concept");
    expect([
      conceptFor("AIH Skills"),
      conceptFor("AIH Agents"),
      conceptFor("AIH MCP servers"),
      conceptFor("AIH-Governance & Telemetry Hooks"),
      conceptFor("ECC runtime"),
      conceptFor("ECC baselines"),
    ]).toEqual(["skill", "agent", "mcp", "hook", "runtime", "core"]);
    const iconClassFor = (label: string) =>
      [...window.document.querySelectorAll("section.grp .grphead h2")]
        .find((heading) => heading.textContent === label)
        ?.querySelector(".concept-icon svg")
        ?.getAttribute("class");
    expect([
      iconClassFor("AIH Skills"),
      iconClassFor("AIH Agents"),
      iconClassFor("AIH MCP servers"),
      iconClassFor("AIH-Governance & Telemetry Hooks"),
      iconClassFor("ECC runtime"),
      iconClassFor("ECC baselines"),
    ]).toEqual([
      "lucide lucide-blocks",
      "lucide lucide-bot",
      "lucide lucide-plug",
      "lucide lucide-anchor",
      "lucide lucide-zap",
      "lucide lucide-layers",
    ]);

    click(window, '[data-view-tab="author"]');
    expect(window.document.body.getAttribute("data-view")).toBe("author");
    if (adoption === null) throw new Error("expected adoption panel");
    expect(window.document.getElementById("panel-author")?.contains(adoption)).toBe(true);
    expect(
      window.document.getElementById("panel-author")?.querySelector("#protected-form"),
    ).not.toBeNull();

    click(window, '[data-view-tab="artifacts"]');
    expect(window.document.body.getAttribute("data-view")).toBe("artifacts");
    expect(
      window.document.getElementById("panel-artifacts")?.querySelector("#artifact-intake-review"),
    ).not.toBeNull();
  });

  it("keeps Allowed CLI open while an administrator makes consecutive selections", () => {
    const window = new Window({ url: "http://localhost/" });
    const html = policyStudioHtml(policyStudioModel());
    window.document.write(html);
    loadStudio(window, html);

    const menu = [...window.document.querySelectorAll("#preset-poplist > .pop-row")].find((row) =>
      row.textContent?.includes("Allowed CLI"),
    );
    if (menu === undefined) throw new Error("expected Allowed CLI menu");
    menu.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const popover = menu.nextElementSibling;
    if (popover === null) throw new Error("expected Allowed CLI popover");

    expect(popover.getAttribute("data-open")).toBe("true");
    expect(menu.querySelector(".selcount")?.textContent).toBe("0 / 11");
    for (const cli of ["claude", "codex"]) {
      const button = popover.querySelector(`[data-sanctioned-cli="${cli}"]`);
      if (button === null) throw new Error(`expected ${cli} CLI control`);
      const prior = button.getAttribute("aria-pressed");
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

      expect(
        popover.querySelector(`[data-sanctioned-cli="${cli}"]`)?.getAttribute("aria-pressed"),
      ).not.toBe(prior);
      expect(popover.getAttribute("data-open"), `${cli} selection keeps the panel open`).toBe(
        "true",
      );
      expect(menu.getAttribute("aria-expanded")).toBe("true");
    }

    const selectAll = popover.querySelector('[data-supported-cli-action="select-all"]');
    if (selectAll === null) throw new Error("expected explicit Select all CLI control");
    selectAll.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(popover.querySelectorAll('[data-sanctioned-cli][aria-pressed="true"]')).toHaveLength(11);
    expect(popover.getAttribute("data-open")).toBe("true");

    const done = popover.querySelector('[data-supported-cli-action="done"]');
    if (done === null) throw new Error("expected Allowed CLI Done control");
    done.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(popover.hasAttribute("data-open")).toBe(false);
    expect(menu.getAttribute("aria-expanded")).toBe("false");

    click(window, '[data-posture-set="enterprise"]');
    click(window, "[data-aih-capability-package]");
    expect(
      window.document.querySelector("[data-aih-capability-package]")?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(window.document.getElementById("announcement")?.textContent).not.toContain(
      "Policy change rejected",
    );
  });

  it("refuses an Enterprise posture that has no explicit Allowed CLI selection", () => {
    const window = new Window({ url: "http://localhost/" });
    const html = policyStudioHtml(policyStudioModel());
    window.document.write(html);
    loadStudio(window, html);

    click(window, '[data-posture-set="enterprise"]');

    expect((window.document.getElementById("posture") as unknown as { value: string }).value).toBe(
      "vibe",
    );
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      "Enterprise posture was not applied",
    );
    expect(window.document.getElementById("announcement")?.textContent).toContain("Allowed CLI");

    const capability = window.document.querySelector("[data-aih-capability-package]");
    if (capability === null) throw new Error("expected AIH capability control");
    capability.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    expect(
      window.document.querySelector("[data-aih-capability-package]")?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(window.document.getElementById("announcement")?.textContent).not.toContain(
      "Policy change rejected",
    );
  });

  it("ships source-authored descriptions for every visible ECC agent and skill", () => {
    const model = policyStudioModel();
    const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
    if (ecc === undefined) throw new Error("expected ECC framework");
    const contentAssets = ecc.assets.filter(
      (asset) => asset.kind === "agent" || asset.kind === "skill",
    );
    expect(contentAssets.length).toBeGreaterThan(0);
    for (const asset of contentAssets) {
      expect(asset.metadata?.title, `${asset.id} source title`).toBeTruthy();
      expect(asset.metadata?.summary, `${asset.id} source summary`).toBeTruthy();
      expect(asset.metadata?.usageContext, `${asset.id} source usage context`).toBeTruthy();
      expect(asset.metadata?.sourcePath, `${asset.id} source path`).toMatch(
        asset.kind === "agent" ? /^agents\/.+\.md$/ : /^skills\/.+\/SKILL\.md$/,
      );
      expect(asset.metadata?.sourceSha256, `${asset.id} source digest`).toMatch(/^[a-f0-9]{64}$/);
    }
    for (const skill of model.catalog.eccSkills) {
      expect(skill.summary, `${skill.id} source summary`).toBeTruthy();
      expect(skill.usageContext, `${skill.id} source usage context`).toBeTruthy();
      expect(skill.sourceSha256, `${skill.id} source digest`).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("uses one auditable details pattern for every ECC component kind", () => {
    const window = new Window({ url: "http://localhost/" });
    const model = policyStudioModel();
    const html = policyStudioHtml(model);
    window.document.write(html);
    loadStudio(window, html);

    const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
    if (ecc === undefined) throw new Error("expected ECC framework");
    const representatives = new Map<string, (typeof ecc.assets)[number]>();
    for (const asset of ecc.assets) {
      if (!representatives.has(asset.kind)) representatives.set(asset.kind, asset);
    }

    expect([...representatives.keys()].sort()).toEqual([
      "agent",
      "baseline",
      "capability",
      "framework",
      "lang",
      "mcp",
      "module",
      "runtime",
      "skill",
    ]);
    for (const asset of representatives.values()) {
      click(window, `[data-detail="ecc / ${asset.kind}: ${asset.id}"]`);
      const drawer = window.document.getElementById("drawer-detail");
      expect(
        drawer?.querySelector('[data-detail-section="overview"]'),
        `${asset.kind} overview`,
      ).not.toBeNull();
      expect(
        drawer?.querySelector('[data-detail-section="scope"]'),
        `${asset.kind} selection scope`,
      ).not.toBeNull();
      expect(
        drawer?.querySelector('[data-detail-section="sources"]'),
        `${asset.kind} source definitions`,
      ).not.toBeNull();
      expect(
        drawer?.querySelector('[data-detail-section="readiness"]'),
        `${asset.kind} readiness`,
      ).not.toBeNull();
      expect(
        drawer?.querySelector('[data-detail-section="security"]'),
        `${asset.kind} security and audit`,
      ).not.toBeNull();
    }

    const rules = ecc.assets.find((asset) => asset.id === "baseline:rules");
    const skill = ecc.assets.find((asset) => asset.id === "skill:tdd-workflow");
    expect(rules?.source.path).toBe("rules");
    expect(rules?.sourcePaths).toContain("rules");
    expect(skill?.source.path).toBe("skills/tdd-workflow");

    const capability = ecc.assets.find((asset) => asset.id === "capability:security");
    const lockedCapability = baselineCatalogById("ecc").components.find(
      (component) => component.id === "capability:security",
    );
    if (capability === undefined || lockedCapability === undefined) {
      throw new Error("expected pinned security capability");
    }
    expect(capability.sourcePaths).toEqual(lockedCapability.paths);
    click(window, '[data-detail="ecc / capability: capability:security"]');
    const drawer = window.document.getElementById("drawer-detail");
    expect(
      [...(drawer?.querySelectorAll("[data-source-definition]") ?? [])].map(
        (entry) => entry.textContent,
      ),
    ).toEqual(lockedCapability.paths);
    expect(drawer?.textContent).toContain("Composite capability");
    expect(drawer?.textContent).toContain("complete pinned source set");
    expect(drawer?.textContent).toContain("No aggregate tool allow-list declared");
  });

  // The locked ownership boundary: an unrecognised item is annotated, never
  // removed. Dropping it hides inventory an administrator is accountable for.
  it("carries every pinned baseline component, dropping none", () => {
    for (const framework of policyAuthoringCatalog().frameworks) {
      const components = baselineCatalogById(framework.id).components.map((item) => item.id);
      const assetIds = framework.assets.map((asset) => asset.id);
      expect(assetIds, `${framework.id} drops a pinned baseline component`).toEqual(
        expect.arrayContaining(components),
      );
      expect(assetIds.filter((assetId) => !components.includes(assetId))).toStrictEqual([]);
    }
  });

  it("kinds the whole component-id namespace, not three prefixes", () => {
    const assets = allAssets();
    expect(assets.length).toBe(426);
    expect(countByKind(assets.map((asset) => asset.kind))).toStrictEqual({
      agent: 44,
      baseline: 6,
      capability: 15,
      framework: 11,
      lang: 15,
      mcp: 6,
      module: 26,
      runtime: 3,
      skill: 300,
    });
    for (const asset of assets) {
      expect(asset.kind).toBe(asset.id.slice(0, asset.id.indexOf(":")));
    }
  });

  // External curation is a policy-document grammar fixed at three kinds, not
  // this inventory's vocabulary. Widening the inventory must not widen it.
  it("keeps the external-curation vocabulary separate and unchanged", () => {
    const assets = allAssets();
    for (const asset of assets) {
      const expected = asset.id.startsWith("agent:")
        ? "agent"
        : asset.id.startsWith("skill:")
          ? "skill"
          : asset.id === "baseline:commands" || asset.id === "module:commands-core"
            ? "command"
            : undefined;
      expect(asset.curationKind, `curationKind for ${asset.id}`).toBe(expected);
    }
    const curatable = assets.filter((asset) => asset.curationKind !== undefined);
    expect(curatable.length).toBe(346);
    for (const asset of curatable) {
      expect(CURATION_KINDS).toContain(asset.curationKind);
    }
  });

  // `#curation-kind` is a three-option select, so prefilling it with a widened
  // kind would silently leave the previous value instead of failing.
  it("offers only curation-expressible assets in the generated prefill", () => {
    const window = new Window({ url: "http://localhost/" });
    const model = policyStudioModel();
    const html = policyStudioHtml(model);
    window.document.write(html);
    loadStudio(window, html);
    const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
    const options = [...window.document.querySelectorAll("#curation-asset option")] as unknown as {
      value: string;
    }[];
    const values = options.map((option) => option.value).filter((value) => value !== "");
    expect(values.length).toBe(ecc?.assets.filter((asset) => asset.curationKind).length);
    for (const value of values) {
      expect(CURATION_KINDS).toContain(value.split("|")[0]);
    }
  });
});
