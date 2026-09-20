import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { createTestHost, fixtureModel, golden, sha256Of } from "./test-host.js";

/**
 * Editor 4: the user page's "Set all N" group and Reset. The intent is ported
 * from `src/org-policy/workbench/ui/user-door.ts` (lines 429-464 and 785-806)
 * and the behaviour `tests/org-policy/workbench/user-door.test.ts` pins for
 * the choices those controls write.
 */

/** The CLI host's bound model: J1's own organization policy, as the host reads it. */
function boundUserModel(): Record<string, unknown> {
  const text = golden("aih-org-policy.v3-selection.json");
  return {
    door: "user",
    policySource: {
      kind: "binding",
      path: "/tmp/p/.aih-config.json",
      valid: true,
      sha256: sha256Of(text),
    },
    initialPolicy: JSON.parse(text),
    workbenchBundle: fixtureModel().workbenchBundle,
  };
}

beforeEach(() => {
  location.hash = "#/user";
});
afterEach(cleanup);

function setAll() {
  return screen.getByRole("group", { name: "Set every item" });
}

/** The "What your AI carries" panel's three counts. */
function counts(): Record<string, string> {
  const panel = screen.getByRole("complementary");
  const rows: Record<string, string> = {};
  for (const label of ["Required", "Optional", "Skipped"]) {
    rows[label] =
      within(panel).getByText(label).parentElement?.textContent?.replace(label, "") ?? "";
  }
  return rows;
}

describe("user page set all and reset", () => {
  it("sets every listed item the same way from one control", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost({ boundPolicy: true })} model={boundUserModel()} />);

    const items = screen.getAllByRole("radiogroup").filter((group) => {
      const name = group.getAttribute("aria-label") ?? "";
      return name !== "For" && name !== "Show" && name !== "Posture";
    });
    expect(items.length).toBeGreaterThan(0);

    await user.click(within(setAll()).getByRole("button", { name: "Required" }));
    for (const group of items)
      expect(within(group).getByRole("radio", { name: "Required", checked: true })).toBeDefined();
    expect(counts().Required).toBe(String(items.length));

    await user.click(within(setAll()).getByRole("button", { name: "Skip" }));
    expect(counts().Skipped).toBe(String(items.length));
  });

  it("presses the option only while every item already agrees", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost({ boundPolicy: true })} model={boundUserModel()} />);

    // The view's own default is Optional, so that option starts pressed.
    expect(
      within(setAll()).getByRole("button", { name: "Optional" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(within(setAll()).getByRole("button", { name: "Required" }));
    expect(
      within(setAll()).getByRole("button", { name: "Required" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(setAll()).getByRole("button", { name: "Optional" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("reset puts every item back to the view's default", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost({ boundPolicy: true })} model={boundUserModel()} />);

    const before = counts();
    await user.click(within(setAll()).getByRole("button", { name: "Skip" }));
    expect(counts()).not.toEqual(before);

    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(counts()).toEqual(before);
  });

  it("set all then reset saves the same file the untouched page saves", async () => {
    const user = userEvent.setup();
    const host = createTestHost({ boundPolicy: true });
    render(<App host={host} model={boundUserModel()} />);

    await user.type(screen.getByLabelText("Name"), "Payments API");
    await user.click(screen.getByRole("checkbox", { name: "claude" }));
    await user.click(screen.getAllByRole("button", { name: /^Save/u })[0] as HTMLElement);
    const first = host.save.mock.calls.at(-1)?.[0];

    await user.click(within(setAll()).getByRole("button", { name: "Skip" }));
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await user.click(screen.getAllByRole("button", { name: /^Save/u })[0] as HTMLElement);
    const second = host.save.mock.calls.at(-1)?.[0];

    expect(second).toEqual(first);
  });
});
