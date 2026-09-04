import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
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

function announcement(window: Window): string {
  return window.document.getElementById("announcement")?.textContent ?? "";
}

function policyPreview(window: Window): string {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected authored policy preview");
  return preview.value;
}

async function settle(window: Window, done: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (done()) return;
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  }
}

async function importPolicy(window: Window, value: unknown): Promise<void> {
  const policyFile = window.document.getElementById("policy-file");
  if (policyFile === null) throw new Error("expected policy file input");
  Object.defineProperty(policyFile, "files", {
    configurable: true,
    value: [new window.File([JSON.stringify(value)], "policy.json", { type: "application/json" })],
  });
  policyFile.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle(window, () => announcement(window).length > 0);
}

const request = (id: string) => ({ id, clarification: "Requested by: administrator" });

function policy(aihMcpRequests: unknown[], catalog?: unknown): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "1",
      catalog: catalog ?? { reviewed: [], custom: [] },
      activations: [],
      authority: { approvals: [] },
      externalCuration: [],
      externalSelections: [],
      ...(aihMcpRequests.length === 0 ? {} : { aihMcpRequests }),
    },
  };
}

const customContext7Catalog = {
  reviewed: [],
  custom: [
    {
      id: "context7",
      kind: "mcp",
      description: "Organization-pinned stdio MCP",
      capabilities: [],
      risks: [],
      source: {
        type: "stdio",
        resolver: "npx",
        registry: "https://registry.npmjs.org",
        package: "context7-mcp",
        version: "1.0.0",
        integrity: `sha256:${"a".repeat(64)}`,
      },
      targets: ["claude"],
      projector: "mcp-managed-settings",
      lifecycle: "supported",
      evidence: { record: "organization-evidence" },
    },
  ],
};

function clickRequest(window: Window, id: string): void {
  const control = window.document.querySelector(`[data-mcp-request="${id}"]`);
  if (control === null) throw new Error(`expected a ${id} request control`);
  control.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

describe("Workbench validation of requested AIH-owned MCP identities", () => {
  it("imports and re-exports a two-request policy byte for byte", async () => {
    const window = studio();
    const value = policy([request("github"), request("context7")]);
    await importPolicy(window, value);

    expect(announcement(window)).toContain("without transformation");
    expect(JSON.parse(policyPreview(window)).governance.aihMcpRequests).toEqual([
      request("github"),
      request("context7"),
    ]);
    expect(policyPreview(window)).toBe(`${JSON.stringify(value, null, 2)}\n`);
  });

  it.each([
    [
      "a duplicated request",
      policy([request("context7"), request("context7")]),
      "AIH MCP request context7 is duplicated",
    ],
    [
      "requests outside the pinned declaration order",
      policy([request("playwright"), request("context7")]),
      "AIH MCP requests must follow the pinned AIH-owned MCP declaration order",
    ],
    [
      "an identity recorded as both a request and a candidate",
      policy([request("context7")], customContext7Catalog),
      "context7 is recorded as both an AIH MCP request and a policy candidate; one identity keeps one record — remove either the request or the candidate",
    ],
    [
      "a request for an identity this build ships as a control",
      policy([request("sequential-thinking")]),
      "this Core build ships a selectable AIH control for it; select the control instead",
    ],
  ])("refuses %s on import", async (_label, value, message) => {
    const window = studio();
    await importPolicy(window, value);
    expect(announcement(window)).toContain("Policy import rejected");
    expect(announcement(window)).toContain(message);
  });

  it("sorts requests into the pinned order however the administrator clicks", () => {
    const window = studio();
    clickRequest(window, "playwright");
    clickRequest(window, "context7");
    expect(JSON.parse(policyPreview(window)).governance.aihMcpRequests).toEqual([
      request("context7"),
      request("playwright"),
    ]);

    const exportButton = window.document.getElementById("export");
    if (exportButton === null) throw new Error("expected the export control");
    exportButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(announcement(window)).toContain("2 requested item(s), 0 effective in this browser");
    expect(announcement(window)).not.toContain("blocked");
  });

  it("rolls a request back when the same identity is already a policy candidate", async () => {
    const window = studio();
    await importPolicy(window, policy([], customContext7Catalog));
    expect(announcement(window)).not.toContain("rejected");
    const before = policyPreview(window);

    clickRequest(window, "context7");
    expect(announcement(window)).toContain("Policy change rejected");
    expect(announcement(window)).toContain(
      "context7 is recorded as both an AIH MCP request and a policy candidate; one identity keeps one record — remove either the request or the candidate",
    );
    expect(policyPreview(window)).toBe(before);
  });

  it("names the gate it did not satisfy when an administrator records a request", () => {
    const window = studio();
    const projector = window.document.querySelector('[data-mcp-request="context7"]');
    if (projector === null) throw new Error("expected a context7 request control");
    projector.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(announcement(window)).toBe(
      "Requested intent recorded for context7; the policy projector gate still holds, so it is not effective and grants nothing.",
    );

    const evidence = window.document.querySelector('[data-mcp-request="playwright"]');
    if (evidence === null) throw new Error("expected a playwright request control");
    evidence.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(announcement(window)).toBe(
      "Requested intent recorded for playwright; the AIH evidence gate still holds, so it is not effective and grants nothing.",
    );

    const row = window.document.querySelector('[data-ecc-mcp-availability="playwright"]');
    expect(row?.textContent).toContain("Requested by: administrator");
    expect(row?.textContent).toContain(
      "this request stays not effective until AIH publishes a current protected Scanner evidence record",
    );
    expect(JSON.parse(policyPreview(window)).governance.aihMcpRequests).toEqual([
      request("context7"),
      request("playwright"),
    ]);
  });

  it("separates AIH's runtime identity from ECC's declaration in the drawer", () => {
    const window = studio();
    const opener = window.document.querySelector('[data-detail="ECC MCP: playwright"]');
    if (opener === null) throw new Error("expected a playwright detail control");
    opener.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    const drawer = window.document.getElementById("drawer-detail");
    expect(drawer?.textContent).toContain("AIH runtime transport");
    expect(drawer?.textContent).toContain(
      "Selecting it records requested intent over AIH's own runtime identity in governance.aihMcpRequests — never over ECC's declaration — and grants no installation, evidence, approval, projection, activation, or reachability.",
    );
    expect(drawer?.textContent).not.toContain("no supported policy action");
    expect(drawer?.textContent).toContain("no current protected Scanner evidence record");
  });

  it("counts requests in the export narration and the preview report", () => {
    const window = studio();
    const control = window.document.querySelector('[data-mcp-request="playwright"]');
    if (control === null) throw new Error("expected a playwright request control");
    control.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    const report = window.document.getElementById("report-preview") as unknown as {
      value: string;
    } | null;
    expect(report?.value).toContain(
      "AIH MCP requests: 1 gated AIH-owned identity(ies) requested; a request grants nothing and never becomes effective.",
    );

    const exportButton = window.document.getElementById("export");
    if (exportButton === null) throw new Error("expected the export control");
    exportButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(announcement(window)).toContain("1 requested item(s), 0 effective in this browser");
  });
});
