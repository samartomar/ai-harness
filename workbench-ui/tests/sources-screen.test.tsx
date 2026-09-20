import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { createTestHost, fixtureModel } from "./test-host.js";

/**
 * Editors 11, 7 and 12: the catalog search / type tabs / source select, the
 * kind ledger and the rail collapse, and the item inspector with its three
 * tabs. The intent is ported from
 * `tests/org-policy/workbench/new-shell-sources.test.ts` ("filters the cards by
 * search and switches source tabs", "writes hostile catalog text as text"),
 * `new-shell-frame.test.ts` ("counts the prepared catalog per kind in the
 * ledger", "switches inspector tabs and closes the rails") and
 * `new-shell-inspector.test.ts` ("opens an item from a card and closes it
 * without changing the policy", "writes hostile item text as text").
 */

const SEARCH = "Search catalog";
const SOURCE = "Choose catalog source";
const NO_MATCH = 'No catalog items match "no-such-catalog-item" in the selected source.';
const HOSTILE = '<img src=x onerror="globalThis.__pwned=1">';

beforeEach(() => {
  location.hash = "#/admin";
});
afterEach(cleanup);

function results(): HTMLElement {
  return screen.getByRole("region", { name: "Catalog browse results" });
}

function inspector(): HTMLElement {
  return screen.getByRole("complementary", { name: "Inspector" });
}

describe("catalog browse", () => {
  it("shows the open source's items and the results line", async () => {
    render(<App host={createTestHost()} model={fixtureModel()} />);
    expect(screen.getByRole("heading", { name: "@aihq/fixture" })).toBeDefined();
    expect(within(results()).getByRole("status").textContent).toBe("Showing 1–3 of 3 items");
    expect(screen.getByRole("switch", { name: "fixture:control" })).toBeDefined();
    // One page holds the fixture catalog, so no paging control is offered.
    expect(screen.queryByRole("button", { name: "Next 50" })).toBeNull();
  });

  it("filters by search, and says why nothing is listed", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    await user.type(screen.getByLabelText(SEARCH), "no-such-catalog-item");
    expect(screen.queryByRole("switch", { name: "fixture:control" })).toBeNull();
    expect(within(results()).getByText(NO_MATCH)).toBeDefined();

    await user.clear(screen.getByLabelText(SEARCH));
    await user.type(screen.getByLabelText(SEARCH), "control");
    expect(screen.getByRole("switch", { name: "fixture:control" })).toBeDefined();
    expect(screen.queryByRole("switch", { name: "fixture:request" })).toBeNull();
  });

  it("filters by type, and offers every type again when one type is empty", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    await user.click(screen.getByRole("button", { name: "Hooks (1)" }));
    expect(screen.getByRole("switch", { name: "fixture:control" })).toBeDefined();
    expect(screen.queryByRole("switch", { name: "fixture:request" })).toBeNull();

    // A type with no items is not offered at all, exactly as the hand-built
    // tabs are built; an empty type is reached by narrowing an offered one.
    expect(screen.queryByRole("button", { name: "Agents (0)" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Skills (1)" }));
    await user.type(screen.getByLabelText(SEARCH), "control");
    expect(
      within(results()).getByText(
        'No skills match "control" in the selected source. 1 item is available in other types.',
      ),
    ).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Show all types" }));
    expect(screen.getByRole("switch", { name: "fixture:control" })).toBeDefined();
  });

  it("names the catalog source in the picker, never a raw URL", () => {
    render(<App host={createTestHost()} model={fixtureModel()} />);
    const picker = screen.getByLabelText(SOURCE) as HTMLSelectElement;
    expect([...picker.options].map((option) => option.textContent)).toEqual(["@aihq/fixture (3)"]);
  });

  it("writes hostile catalog text as text, never as markup", () => {
    const model = fixtureModel();
    const bundle = model.workbenchBundle as { assets: Record<string, { label: string }> };
    const asset = Object.values(bundle.assets)[0];
    if (asset === undefined) throw new Error("expected a fixture asset");
    asset.label = HOSTILE;
    render(<App host={createTestHost()} model={model} />);
    expect(results().querySelectorAll("img")).toHaveLength(0);
    expect(results().textContent).toContain(HOSTILE);
  });
});

describe("kind ledger and rail collapse", () => {
  it("counts the prepared catalog per kind, with no token or cost figure", () => {
    render(<App host={createTestHost()} model={fixtureModel()} />);
    const ledger = screen.getByRole("group", { name: "Catalog kinds" });
    expect(
      [...ledger.querySelectorAll("[data-kind-ledger-tile]")].map((tile) => [
        tile.getAttribute("data-kind-ledger-tile"),
        tile.textContent,
      ]),
    ).toEqual([
      ["skill", "Skills0%0/1selected"],
      ["command", "Command0%0/0selected"],
      ["agent", "Agents0%0/0selected"],
      ["mcp", "MCP servers0%0/1selected"],
      ["hook", "Hooks0%0/1selected"],
    ]);
    expect(ledger.textContent).not.toMatch(/token|cost|\$/iu);
  });

  it("follows the draft when an item is added", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);
    await user.click(screen.getByRole("switch", { name: "fixture:control" }));
    expect(screen.getByRole("group", { name: "Catalog kinds" }).textContent).toContain(
      "Hooks100%1/1selected",
    );
  });

  it("collapses and reopens the catalog scopes rail", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);
    const toggle = screen.getByRole("button", { name: "Toggle navigation" });
    expect(screen.getByRole("button", { name: /@aihq\/fixture/u })).toBeDefined();
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /@aihq\/fixture/u })).toBeNull();
    await user.click(toggle);
    expect(screen.getByRole("button", { name: /@aihq\/fixture/u })).toBeDefined();
  });
});

describe("item inspector", () => {
  it("opens an item from a card and closes it without changing the policy", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);
    expect(within(inspector()).getByText("Select an item to inspect it.")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "fixture:control" }));
    expect(within(inspector()).getByRole("tab", { name: "Details" })).toBeDefined();
    expect(
      screen.getByRole("switch", { name: "fixture:control" }).getAttribute("aria-checked"),
    ).toBe("false");

    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull();
    expect(
      screen.getByRole("switch", { name: "fixture:control" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("switches between the three tabs", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);
    await user.click(screen.getByRole("button", { name: "fixture:control" }));
    const rail = inspector();
    const selected = () =>
      within(rail)
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("aria-selected"));
    expect(
      within(rail)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Details", "Security Scan", "Policy JSON"]);
    expect(selected()).toEqual(["true", "false", "false"]);

    await user.click(within(rail).getByRole("tab", { name: "Security Scan" }));
    expect(selected()).toEqual(["false", "true", "false"]);
    expect(within(rail).getByRole("tabpanel").textContent).toContain(
      "it does not approve, install, or grant access",
    );

    await user.click(within(rail).getByRole("tab", { name: "Policy JSON" }));
    expect(selected()).toEqual(["false", "false", "true"]);
    expect(within(rail).getByRole("tabpanel").textContent).toContain("fixture:control");
  });

  it("writes hostile item text in the inspector as text, never as markup", async () => {
    const user = userEvent.setup();
    const model = fixtureModel();
    const bundle = model.workbenchBundle as {
      assets: Record<string, { id: string; label: string }>;
    };
    const asset = Object.values(bundle.assets)[0];
    if (asset === undefined) throw new Error("expected a fixture asset");
    asset.label = HOSTILE;
    render(<App host={createTestHost()} model={model} />);

    await user.click(screen.getByRole("button", { name: HOSTILE }));
    const rail = inspector();
    expect(rail.querySelectorAll("img")).toHaveLength(0);
    expect(rail.textContent).toContain(HOSTILE);
  });
});
