import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { createTestHost, managedMcpModel } from "./test-host.js";

/**
 * The managed MCP projection opt-in, the rule the hand-built page carries
 * (`ui/shell/org-screen.ts`): the download is blocked while the policy selects
 * Core MCP controls and the projection is off, and this control is the only
 * way to clear it.
 */

const SWITCH = "Allow AIH to configure selected MCP tools";
const BLOCKER = "enable managed MCP projection";
const REFUSAL =
  "Managed MCP projection remains enabled because selected Core MCP controls need it. Remove those controls before disabling this setting.";

beforeEach(() => {
  location.hash = "#/admin";
});
afterEach(cleanup);

/** J1 up to the review: one AI tool, Enterprise posture, one catalog item. */
async function reviewWithSelection(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: /AI tools/u }));
  const tools = screen.getByRole("dialog", { name: "AI tools" });
  await user.click(within(tools).getAllByRole("switch")[0] as HTMLElement);
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("radio", { name: "Enterprise" }));

  const selectable = screen
    .getAllByRole("switch")
    .filter(
      (node) =>
        node.getAttribute("aria-disabled") !== "true" && node.closest("[data-card-id]") !== null,
    );
  const item = selectable[0];
  if (item === undefined) throw new Error("the package catalog offers no selectable item");
  await user.click(item);

  await user.click(screen.getByRole("button", { name: "Review Changes" }));
  return screen.getByRole("dialog", { name: "Review changes" });
}

describe("managed MCP projection", () => {
  it("refuses the download inside the flyout until the projection is enabled", async () => {
    const user = userEvent.setup();
    const host = createTestHost();
    render(<App host={host} model={managedMcpModel()} />);

    const review = await reviewWithSelection(user);
    expect(within(review).getByRole("alert").textContent).toContain(BLOCKER);

    await user.click(within(review).getByRole("button", { name: "Download" }));
    expect(host.save).not.toHaveBeenCalled();
    expect(within(review).getByRole("alert").textContent).toContain(BLOCKER);

    const control = within(review).getByRole("switch", { name: SWITCH });
    expect(control.getAttribute("aria-checked")).toBe("false");
    await user.click(control);
    expect(within(review).getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe(
      "true",
    );
    // The outcome is readable inside the flyout, not only on the strip behind it.
    expect(within(review).getByRole("status").textContent).toContain(
      "Managed MCP projection enabled",
    );
    expect(within(review).getByRole("alert").textContent).toBe("");

    await user.click(within(review).getByRole("button", { name: "Download" }));
    expect(host.save).toHaveBeenCalledTimes(1);
    const written = JSON.parse(host.save.mock.calls[0]?.[0].text ?? "{}") as {
      mcp?: { allowManagedOnly?: boolean };
    };
    expect(written.mcp?.allowManagedOnly).toBe(true);
  });

  it("refuses to switch off while the selected controls need it", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={managedMcpModel()} />);

    const review = await reviewWithSelection(user);
    await user.click(within(review).getByRole("switch", { name: SWITCH }));
    await user.click(within(review).getByRole("switch", { name: SWITCH }));

    expect(within(review).getByRole("alert").textContent).toContain(REFUSAL);
    expect(within(review).getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("is always offered, and works from the keyboard", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={managedMcpModel()} />);

    await user.click(screen.getByRole("button", { name: "Review Changes" }));
    const review = screen.getByRole("dialog", { name: "Review changes" });
    const control = within(review).getByRole("switch", { name: SWITCH });
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(within(review).getByText(/No server is contacted from this page\./u)).toBeDefined();

    control.focus();
    expect(document.activeElement).toBe(control);
    await user.keyboard(" ");
    expect(within(review).getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });
});
