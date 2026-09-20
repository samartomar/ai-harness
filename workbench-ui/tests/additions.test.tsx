import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { alertText, createTestHost, fixtureModel, statusText } from "./test-host.js";

/**
 * Editors 15, 16 and 17 on the Additions screen. The intent is ported from
 * `tests/org-policy/workbench/new-shell-acme.test.ts` (the ECC MCP approval
 * panel, the curation edit state) and from the form handlers of
 * `ui/shell/acme-screen.ts` that `shell-extracted-semantics.test.ts` backs.
 */

const HOSTILE = '<img src=x onerror="globalThis.__pwned=1">';

beforeEach(() => {
  location.hash = "#/admin";
});
afterEach(cleanup);

function modelWithApproval(): Record<string, unknown> {
  const model = fixtureModel();
  const catalog = model.catalog as {
    externalMcp: unknown[];
    eccMcpApproval: { sourceContentSha256: string };
  };
  catalog.externalMcp = [{ id: "jira", addability: "https-configurable" }];
  (
    (model.initialPolicy as Record<string, unknown>).governance as Record<string, unknown>
  ).eccMcpApprovals = [
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

async function openAdditions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Additions" }));
  return screen.getByRole("main", { name: "Additions" });
}

/** One editor's own region, so two forms can share a field label. */
function editor(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

const CURATION_EDITOR = "ECC / Superpowers curation";

async function fillCuration(
  user: ReturnType<typeof userEvent.setup>,
  screenNode: HTMLElement,
  id = "review-agent",
) {
  const type = async (label: string, value: string) => {
    const field = within(screenNode).getByLabelText(label);
    await user.clear(field);
    await user.type(field, value);
  };
  await type("Item identifier", id);
  await type("Accountable owner email", "framework.owner@acme.example");
  await type("Source repository", "acme/catalog");
  await type("Source commit", "a".repeat(40));
  await type("Source path", "agents/review.md");
  await type("Audit record", "audit-2026-08");
  await type("Audit digest", `sha256:${"b".repeat(64)}`);
}

describe("additions screen: framework curation", () => {
  it("adds an item, lists it as text, and removes it", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);
    const page = await openAdditions(user);
    const curation = editor(CURATION_EDITOR);

    expect(within(curation).getByText("No external curation intent.")).toBeTruthy();
    await fillCuration(user, curation);
    await user.click(within(curation).getByRole("button", { name: "Add framework curation" }));

    expect(statusText()).toContain(
      "External curation intent added; it is report-only and not enforced by AIH.",
    );
    expect(within(curation).getByText("ecc: agent / review-agent")).toBeTruthy();
    expect(within(page).getByLabelText("In this policy").textContent).toContain(
      "Framework curation: 1",
    );

    await user.click(
      within(curation).getByRole("button", { name: "Remove ecc: agent / review-agent" }),
    );
    expect(statusText()).toContain("External curation intent removed.");
    expect(within(curation).getByText("No external curation intent.")).toBeTruthy();
  });

  it("locks the owner while editing, saves the edit, and cancels back to adding", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);
    await openAdditions(user);
    const curation = editor(CURATION_EDITOR);
    await fillCuration(user, curation);
    await user.click(within(curation).getByRole("button", { name: "Add framework curation" }));

    await user.click(
      within(curation).getByRole("button", { name: "Edit ecc: agent / review-agent" }),
    );
    expect(
      (
        within(curation).getByLabelText(
          "External framework owner (locked while editing)",
        ) as HTMLSelectElement
      ).disabled,
    ).toBe(true);

    const note = within(curation).getByLabelText("Admin clarification");
    await user.type(note, "reviewed by platform");
    await user.click(within(curation).getByRole("button", { name: "Save framework curation" }));
    expect(statusText()).toContain(
      "External curation intent updated; it is report-only and not enforced by AIH.",
    );
    expect(within(curation).getByText(/Clarification: reviewed by platform/)).toBeTruthy();

    // Back in add mode, with the owner field unlocked again.
    expect(within(curation).getByRole("button", { name: "Add framework curation" })).toBeTruthy();
    await user.click(
      within(curation).getByRole("button", { name: "Edit ecc: agent / review-agent" }),
    );
    await user.click(within(curation).getByRole("button", { name: "Cancel curation edit" }));
    expect(
      (within(curation).getByLabelText("External framework owner") as HTMLSelectElement).disabled,
    ).toBe(false);
  });

  it("refuses an incomplete item, marks the identifier, and records nothing", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);
    await openAdditions(user);
    const curation = editor(CURATION_EDITOR);

    await user.click(within(curation).getByRole("button", { name: "Add framework curation" }));
    expect(alertText()).toContain(
      "Use a kind, identifier, pinned repository/40-character commit/safe path, audit record, and sha256 digest.",
    );
    expect(within(curation).getByText("Use an external item identifier.")).toBeTruthy();
    expect(within(curation).getByLabelText("Item identifier").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(within(curation).getByText("No external curation intent.")).toBeTruthy();
  });
});

describe("additions screen: custom and remote MCP", () => {
  const typeInto = async (
    user: ReturnType<typeof userEvent.setup>,
    form: HTMLElement,
    label: string,
    value: string,
  ) => {
    const field = within(form).getByLabelText(label);
    await user.clear(field);
    await user.type(field, value);
  };

  it("records a pending custom MCP as a blocked, pinned candidate", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);
    const page = await openAdditions(user);
    const form = within(page).getByRole("form", { name: "Add organization MCP" });

    await typeInto(user, form, "Identifier", "acme-mcp");
    await typeInto(user, form, "Accountable owner email", "owner@acme.example");
    await typeInto(user, form, "Exact npm package name", "acme-mcp");
    await typeInto(user, form, "Exact version", "1.2.3");
    await typeInto(user, form, "Integrity digest", `sha256:${"c".repeat(64)}`);
    await typeInto(user, form, "Evidence record", "acme-mcp-scan");
    await user.click(within(form).getByRole("button", { name: "Add pending custom MCP" }));

    expect(statusText()).toContain("Pending custom MCP added. It cannot be activated.");
    expect(within(page).getByText("Blocked - evidence owed at this pin")).toBeTruthy();
    expect(within(page).getByText(/aih trust scan acme-mcp@1\.2\.3/)).toBeTruthy();
    expect(within(page).getByLabelText("In this policy").textContent).toContain("Custom MCP: 1");

    await user.click(within(page).getByRole("button", { name: "Remove acme-mcp" }));
    expect(statusText()).toContain("Custom candidate removed.");
    expect(within(page).getByText("No custom candidates.")).toBeTruthy();
  });

  it("refuses a custom MCP without an owner email and marks that field", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);
    const page = await openAdditions(user);
    const form = within(page).getByRole("form", { name: "Add organization MCP" });

    await typeInto(user, form, "Identifier", "acme-mcp");
    await user.click(within(form).getByRole("button", { name: "Add pending custom MCP" }));

    expect(alertText()).toContain(
      "Use an accountable owner email address for the pending custom MCP.",
    );
    expect(within(form).getByText("Use an accountable owner email address.")).toBeTruthy();
    expect(within(page).getByText("No custom candidates.")).toBeTruthy();
  });

  it("records a fenced remote MCP and refuses an origin with a path", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);
    const page = await openAdditions(user);
    const form = within(page).getByRole("form", { name: "Record a pending remote custom MCP" });

    await typeInto(user, form, "Identifier", "acme-remote");
    await typeInto(user, form, "HTTPS origin", "https://mcp.acme.example/path");
    await typeInto(user, form, "Approver email", "owner@acme.example");
    await typeInto(user, form, "Authentication mode", "oauth");
    await typeInto(user, form, "Allowed data classes", "issue-metadata");
    await typeInto(user, form, "Evidence record", "acme-remote-scan");
    await user.click(within(form).getByRole("button", { name: "Record pending remote MCP" }));

    expect(alertText()).toContain("Correct the highlighted remote-endpoint fields.");
    expect(
      within(form).getByText(
        "Use an exact HTTPS origin without a path, credentials, query, or fragment.",
      ),
    ).toBeTruthy();
    expect(within(page).getByText("No custom candidates.")).toBeTruthy();

    await typeInto(user, form, "HTTPS origin", "https://mcp.acme.example");
    await user.click(within(form).getByRole("button", { name: "Record pending remote MCP" }));
    expect(statusText()).toContain(
      "Pending remote MCP recorded. It remains fenced and does not activate or contact the endpoint.",
    );
    expect(
      within(page).getByText(/Remote origin: https:\/\/mcp\.acme\.example · Administrative status/),
    ).toBeTruthy();
    expect(within(page).getByLabelText("In this policy").textContent).toContain("Remote MCP: 1");
  });
});

describe("additions screen: ECC MCP approval", () => {
  it("lists pinned entries and approvals as text, and removes one", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={modelWithApproval()} />);
    const page = await openAdditions(user);

    const select = within(page).getByLabelText("ECC MCP") as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Choose pinned ECC MCP",
      "jira — https-configurable",
    ]);

    // Hostile model text is rendered as text, never as markup.
    expect(within(page).getByText(`— approved; ${HOSTILE}.`, { exact: false })).toBeTruthy();
    expect(page.querySelector("img")).toBeNull();
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();

    await user.selectOptions(select, "jira");
    expect(statusText()).toContain(
      "ECC MCP jira selected for approval authoring only; it is not installed or contacted.",
    );

    await user.click(within(page).getByRole("button", { name: "Remove approval jira" }));
    expect(statusText()).toContain("ECC MCP approval removed for jira.");
    expect(within(page).getByText("No ECC MCP approvals recorded.")).toBeTruthy();
  });
});
