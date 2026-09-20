import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { alertText, createTestHost, fixtureModel, golden, statusText } from "./test-host.js";

/** Journey J1 through the component UI: the admin page produces output A. */

const ENTERPRISE_REFUSAL =
  "Enterprise posture was not applied. Select at least one Allowed CLI first, or choose the Enterprise preset to explicitly sanction every supported CLI and compose Core.";

beforeEach(() => {
  location.hash = "#/admin";
});
afterEach(cleanup);

async function openReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Review Changes" }));
  return screen.getByRole("dialog", { name: "Review changes" });
}

function policyText(dialog: HTMLElement): string {
  const field = within(dialog).getByLabelText("Organization policy file");
  return (field as HTMLTextAreaElement).value;
}

describe("admin journey", () => {
  it("refuses Enterprise before an AI tool, then records the whole J1 selection", async () => {
    const user = userEvent.setup();
    const host = createTestHost();
    render(<App host={host} model={fixtureModel()} />);

    const review = await openReview(user);
    expect(policyText(review)).toBe(golden("aih-org-policy.vibe.json"));
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("radio", { name: "Enterprise" }));
    expect(alertText()).toContain(ENTERPRISE_REFUSAL);
    expect(screen.getByRole("radio", { name: "Vibe", checked: true })).toBeDefined();
    const unchanged = await openReview(user);
    expect(policyText(unchanged)).toBe(golden("aih-org-policy.vibe.json"));
    await user.keyboard("{Escape}");

    screen.getByRole("button", { name: /AI tools/u }).focus();
    await user.keyboard("{Enter}");
    const tools = screen.getByRole("dialog", { name: "AI tools" });
    await user.click(within(tools).getByRole("switch", { name: "Claude Code" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: /AI tools/u }).textContent).toContain("1 of 2");

    await user.click(screen.getByRole("radio", { name: "Enterprise" }));
    expect(statusText()).toContain("Posture changed without modifying selections.");
    expect(screen.getByRole("radio", { name: "Enterprise", checked: true })).toBeDefined();

    await user.click(screen.getByRole("switch", { name: "fixture:control" }));
    expect(
      screen.getByRole("switch", { name: "fixture:control" }).getAttribute("aria-checked"),
    ).toBe("true");

    const final = await openReview(user);
    expect(policyText(final)).toBe(golden("aih-org-policy.v3-selection.json"));
    await user.click(within(final).getByRole("button", { name: "Download" }));
    expect(host.save).toHaveBeenCalledTimes(1);
    expect(host.save.mock.calls[0]?.[0]).toEqual({
      name: "aih-org-policy.json",
      text: golden("aih-org-policy.v3-selection.json"),
    });
  });

  it("publishes an untouched policy as it is, never compiled", async () => {
    const user = userEvent.setup();
    const host = createTestHost();
    render(<App host={host} model={fixtureModel()} />);
    await user.click(screen.getByRole("button", { name: "Publish" }));
    expect(host.save).toHaveBeenCalledTimes(1);
    expect(host.save.mock.calls[0]?.[0]).toEqual({
      name: "aih-org-policy.json",
      text: golden("aih-org-policy.vibe.json"),
    });
  });

  it("moves between the two pages and keeps each page's own state", async () => {
    const user = userEvent.setup();
    const host = createTestHost();
    render(<App host={host} model={fixtureModel()} />);
    await user.click(screen.getByRole("switch", { name: "fixture:control" }));

    await user.click(screen.getByRole("link", { name: "User page" }));
    expect(screen.getByRole("link", { name: "Admin page" })).toBeDefined();

    await user.click(screen.getByRole("link", { name: "Admin page" }));
    expect(
      screen.getByRole("switch", { name: "fixture:control" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("switches the catalog scope from the nav rail and flips the colour mode", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);
    const scope = screen.getByRole("button", { name: /@aihq\/fixture/u });
    await user.click(scope);
    expect(scope.getAttribute("aria-pressed")).toBe("true");
    // LANE A: the browse results are flat and paged, as the hand-built catalog
    // lists them; the open source's name is the masthead heading.
    expect(screen.getByRole("heading", { name: "@aihq/fixture" })).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Switch to light mode" }));
    expect(document.documentElement.dataset.mode).toBe("light");
    await user.click(screen.getByRole("button", { name: "Switch to dark mode" }));
    expect(document.documentElement.dataset.mode).toBe("dark");
  });

  it("checks the policy and closes a flyout from its Close button", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    await user.click(screen.getByRole("button", { name: "Check Policy" }));
    expect(statusText()).toContain("Schema and policy-grammar validation passed.");

    const review = await openReview(user);
    await user.click(within(review).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Review changes" })).toBeNull();
  });
});
