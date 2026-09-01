import { type Element, Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();

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

function click(window: Window, node: Element | null, label: string): void {
  if (node === null) throw new Error(`expected ${label}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function policy(window: Window): unknown {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected policy preview");
  return JSON.parse(preview.value);
}

function text(window: Window, id: string): string {
  return window.document.getElementById(id)?.textContent ?? "";
}

function report(window: Window): string {
  const preview = window.document.getElementById("report-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected report preview");
  return preview.value;
}

function tickerCount(window: Window, owner: string): string {
  return (
    window.document.querySelector(`#owner-ticker [data-owner-focus="${owner}"] b`)?.textContent ??
    ""
  );
}

function hidden(window: Window, id: string): boolean | undefined {
  return (window.document.getElementById(id) as unknown as { hidden: boolean } | null)?.hidden;
}

function detailNarration(window: Window): string {
  return window.document.querySelector("#drawer-detail .journey-effective")?.textContent ?? "";
}

function setValue(window: Window, id: string, value: string): void {
  const input = window.document.getElementById(id) as unknown as { value: string } | null;
  if (input === null) throw new Error(`expected #${id}`);
  input.value = value;
}

describe("policy studio navigation ownership and ECC MCP authoring", () => {
  it("maps every left-rail ECC selection to the same canonical row in the main inventory", () => {
    const window = studio();
    const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
    if (ecc === undefined) throw new Error("expected ECC framework");
    const railKinds = new Set(["lang", "framework", "capability", "module"]);
    const owned = ecc.assets.filter((asset) => railKinds.has(asset.kind));

    expect(window.document.getElementById("profile")).toBeNull();
    expect(owned.length).toBeGreaterThan(0);
    for (const asset of owned) {
      const key = `${ecc.id}|${asset.kind}|${asset.id}`;
      expect(
        window.document.querySelector(`.rail [data-framework-select="${key}"]`),
        `${asset.id} is selectable from the rail`,
      ).not.toBeNull();
      const mainControl = window.document.querySelector(
        `#framework-rows [data-framework-select="${key}"]`,
      );
      expect(mainControl, `${asset.id} has a canonical row in the main inventory`).not.toBeNull();
      expect(
        window.document
          .querySelector(`.rail [data-framework-select="${key}"]`)
          ?.getAttribute("aria-controls"),
        `${asset.id} rail control maps to its main row`,
      ).toBe(mainControl?.closest(".row")?.id);
    }

    const first = owned[0];
    if (first === undefined) throw new Error("expected rail-owned asset");
    const key = `${ecc.id}|${first.kind}|${first.id}`;
    const baseline = JSON.stringify(policy(window));
    click(
      window,
      window.document.querySelector(`.rail [data-framework-select="${key}"]`),
      first.id,
    );
    expect(JSON.stringify(policy(window))).not.toBe(baseline);
    const selectedCount = window.document.querySelectorAll(
      '#framework-rows [data-framework-select][aria-pressed="true"]',
    ).length;
    expect(selectedCount).toBeGreaterThan(0);
    expect(text(window, "t-req")).toBe(String(selectedCount));
    expect(report(window)).toContain("0 selected but not shown as a row at this pin.");
    expect(
      window.document
        .querySelector(`#framework-rows [data-framework-select="${key}"]`)
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    const mappedGroup = window.document
      .querySelector(`#framework-rows [data-framework-select="${key}"]`)
      ?.closest(".grp");
    expect(mappedGroup?.getAttribute("data-open")).toBe("1");
    expect(mappedGroup?.querySelector("[data-group]")?.getAttribute("aria-expanded")).toBe("true");
    click(window, window.document.querySelector('[data-filter="requested"]'), "Selected filter");
    expect(window.document.querySelector('[data-filter="requested"]')?.textContent).toContain(
      String(selectedCount),
    );
    expect(text(window, "c-shown")).toBe(String(selectedCount));
    expect(hidden(window, "plane-empty")).toBe(true);
    const governedSkills = ecc.assets.filter((asset) => asset.kind === "skill").length;
    const visibleEccInventory =
      ecc.assets.length -
      governedSkills +
      model.catalog.eccSkills.length +
      model.catalog.externalMcp.length;
    const aihMcpRows = new Set([
      ...model.catalog.mcp.map((entry) => entry.id),
      ...model.catalog.eccMcpInventory
        .filter((entry) => entry.owner === "aih")
        .map((entry) => entry.id),
    ]).size;
    expect(tickerCount(window, "ECC")).toBe(String(visibleEccInventory));
    expect(tickerCount(window, "all")).toBe(
      String(
        aihMcpRows +
          model.catalog.hooks.length +
          model.catalog.aihSkills.length +
          model.catalog.aihAgents.length +
          visibleEccInventory,
      ),
    );
    click(
      window,
      window.document.querySelector(`#framework-rows [data-framework-select="${key}"]`),
      `remove ${first.id}`,
    );
    expect(JSON.stringify(policy(window))).toBe(baseline);
    expect(text(window, "t-req")).toBe("0");
    expect(
      window.document
        .querySelector(`.rail [data-framework-select="${key}"]`)
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    click(window, window.document.getElementById("clear-policy"), "reset center exclusions");
    expect(JSON.stringify(policy(window))).toBe(baseline);
    for (const preset of ["vibe", "enterprise"]) {
      setValue(window, "preset-select", preset);
      window.document
        .getElementById("preset-select")
        ?.dispatchEvent(new window.Event("change", { bubbles: true }));
      expect(JSON.stringify(policy(window)), `${preset} changes policy`).not.toBe(baseline);
      click(window, window.document.getElementById("clear-policy"), `${preset} inverse`);
      expect(JSON.stringify(policy(window)), `${preset} returns to baseline`).toBe(baseline);
    }
    window.close();
  }, 10_000);

  it("opens rail-owned detail through search without offering another mutation path", () => {
    const window = studio();
    const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
    const asset = ecc?.assets.find((item) => item.kind === "module");
    if (ecc === undefined || asset === undefined)
      throw new Error("expected a rail-owned ECC module");
    click(window, window.document.getElementById("seek"), "search");
    const query = window.document.getElementById("spot-q") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    } | null;
    if (query === null) throw new Error("expected search input");
    query.value = asset.id;
    query.dispatchEvent(new window.Event("input", { bubbles: true }));
    click(window, window.document.querySelector("#hits .hit"), `search result ${asset.id}`);
    expect(window.document.getElementById("drawer-detail")?.textContent).toContain(asset.id);
    expect(detailNarration(window)).toContain("Authored intent: not selected.");
    expect(window.document.querySelector("#drawer-detail [data-framework-select]")).toBeNull();
    expect(window.document.querySelector("#drawer-detail [data-add-riders]")).toBeNull();
    click(window, window.document.querySelector("[data-drawer-close]"), "close detail");
    click(
      window,
      window.document.querySelector(
        `.rail [data-framework-select="ecc|${asset.kind}|${asset.id}"]`,
      ),
      `select ${asset.id}`,
    );
    click(window, window.document.getElementById("seek"), "search selected item");
    query.value = asset.id;
    query.dispatchEvent(new window.Event("input", { bubbles: true }));
    click(window, window.document.querySelector("#hits .hit"), `selected result ${asset.id}`);
    expect(detailNarration(window)).toContain("Authored intent: selected.");
    expect(detailNarration(window)).toContain(
      "Effective count: not evaluated in this portable artifact",
    );
    expect(window.document.querySelector("#drawer-detail [data-framework-select]")).toBeNull();
    expect(window.document.querySelector("#drawer-detail [data-add-riders]")).toBeNull();
    window.close();
  });

  it("authors and removes a pinned ECC MCP approval without an installation claim", () => {
    const window = studio();
    const entry = model.catalog.externalMcp.find(
      (item) => item.addability !== "https-configurable",
    );
    const configurable = model.catalog.externalMcp.find(
      (item) => item.addability === "https-configurable",
    );
    if (entry === undefined || configurable === undefined)
      throw new Error("expected manual and HTTPS-configurable ECC MCP entries");
    const baseline = JSON.stringify(policy(window));

    expect(window.document.getElementById("open-ecc-mcp"), "no duplicate rail action").toBeNull();
    click(
      window,
      window.document.querySelector(`[data-ecc-mcp-approval="${entry.id}"]`),
      `${entry.id} approval action`,
    );
    expect(hidden(window, "ecc-mcp-sidebar")).toBe(false);
    expect(hidden(window, "drawer")).toBe(true);
    click(window, window.document.querySelector("[data-detail]"), "generic detail");
    expect(hidden(window, "drawer")).toBe(false);
    expect(hidden(window, "ecc-mcp-sidebar")).toBe(true);
    click(
      window,
      window.document.querySelector(`[data-ecc-mcp-approval="${entry.id}"]`),
      `reopen ${entry.id} approval`,
    );
    expect(hidden(window, "ecc-mcp-sidebar")).toBe(false);
    expect(hidden(window, "drawer")).toBe(true);
    const options = [...window.document.querySelectorAll("#ecc-mcp-id option")].map(
      (option) => (option as unknown as { value: string }).value,
    );
    expect(options.filter(Boolean).sort()).toEqual(
      model.catalog.externalMcp.map((item) => item.id).sort(),
    );
    const approverInput = window.document.getElementById("ecc-mcp-approved-by");
    expect(approverInput?.getAttribute("type")).toBe("email");
    expect(approverInput?.getAttribute("autocomplete")).toBe("email");
    expect(approverInput?.closest("label")?.textContent).toMatch(/Approver email/i);
    setValue(window, "ecc-mcp-id", entry.id);
    setValue(window, "ecc-mcp-approved-by", "Samar");
    setValue(window, "ecc-mcp-authentication-mode", "OAuth 2.1");
    setValue(window, "ecc-mcp-data-classes", "*");
    click(
      window,
      window.document.getElementById("save-ecc-mcp-approval"),
      "reject invalid approval",
    );
    expect(JSON.stringify(policy(window))).toBe(baseline);
    expect(text(window, "ecc-mcp-approved-by-error")).toMatch(/valid approver email/i);
    expect(text(window, "ecc-mcp-data-classes-error")).toMatch(
      /one to 20 comma-separated lowercase data-class identifiers/i,
    );
    expect(text(window, "announcement")).toContain(
      "Correct the highlighted ECC MCP approval fields.",
    );
    expect(text(window, "announcement")).not.toContain("must match a schema variant");
    setValue(window, "ecc-mcp-approved-by", "approver@example.com");
    setValue(window, "ecc-mcp-data-classes", "issue-metadata,design-metadata");
    click(window, window.document.getElementById("save-ecc-mcp-approval"), "save ECC MCP approval");
    expect(text(window, "announcement")).toMatch(/approval-only.*explicit Add is unavailable/i);
    expect(text(window, "announcement")).not.toMatch(/eligible/i);

    const authored = parseOrgPolicy(policy(window));
    expect(authored.governance?.eccMcpApprovals).toEqual([
      {
        id: entry.id,
        sourceContentSha256: model.catalog.eccMcpApproval.sourceContentSha256,
        state: "approved",
        approvedBy: "approver@example.com",
        authenticationMode: "OAuth 2.1",
        allowedDataClasses: ["issue-metadata", "design-metadata"],
      },
    ]);
    const sidebarText = window.document.getElementById("ecc-mcp-sidebar")?.textContent ?? "";
    expect(sidebarText).toMatch(/Only https-configurable entries can use later explicit Add/i);
    expect(sidebarText).toMatch(/does not install, contact, scan, attest, or claim reachability/i);
    click(
      window,
      window.document.querySelector(`[data-ecc-mcp-approval-remove="${entry.id}"]`),
      `remove ${entry.id} approval`,
    );
    expect(JSON.stringify(policy(window))).toBe(baseline);
    setValue(window, "ecc-mcp-id", configurable.id);
    click(
      window,
      window.document.getElementById("save-ecc-mcp-approval"),
      "save configurable approval",
    );
    expect(text(window, "announcement")).toMatch(/eligible.*explicit Add/i);
    click(
      window,
      window.document.querySelector(`[data-ecc-mcp-approval-remove="${configurable.id}"]`),
      `remove ${configurable.id} approval`,
    );
    expect(JSON.stringify(policy(window))).toBe(baseline);
    window.close();
  });
});
