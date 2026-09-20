import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { createTestHost, fixtureModel, golden, jsonFile, statusText } from "./test-host.js";

/**
 * Editor 2: Clear policy. The intent is ported from
 * `tests/org-policy/workbench/new-shell-download-compat.test.ts` ("clears back
 * to the initial policy") and `new-shell-frame.test.ts` ("returns focus to the
 * file-menu toggle after Clear policy").
 */

const CLEARED =
  "Policy cleared. All selections, requests and curation records were removed from this draft. You can start again with any source.";
const CLEAR = "Clear policy (resets your work)";

beforeEach(() => {
  location.hash = "#/admin";
});
afterEach(cleanup);

async function openReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Review Changes" }));
  return screen.getByRole("dialog", { name: "Review changes" });
}

function policyText(dialog: HTMLElement): string {
  return (within(dialog).getByLabelText("Organization policy file") as HTMLTextAreaElement).value;
}

describe("clear policy", () => {
  it("clears a selection back to the starting policy, with the session's message", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const before = policyText(await openReview(user));
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("switch", { name: "fixture:control" }));
    expect(policyText(await openReview(user))).not.toBe(before);
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: CLEAR }));
    expect(statusText()).toContain(CLEARED);
    expect(policyText(await openReview(user))).toBe(before);
  });

  it("clears an imported policy back to the starting policy", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const before = policyText(await openReview(user));
    await user.keyboard("{Escape}");

    const imported = JSON.parse(golden("aih-org-policy.vibe.json")) as Record<string, unknown>;
    (imported.governance as Record<string, unknown>).policyVersion = "9";
    await user.upload(
      screen.getByLabelText("Import policy"),
      jsonFile("other.json", `${JSON.stringify(imported, null, 2)}\n`),
    );
    expect(policyText(await openReview(user))).not.toBe(before);
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: CLEAR }));
    expect(policyText(await openReview(user))).toBe(before);
    await user.keyboard("{Escape}");

    // The diff follows the policy back: nothing changed from the start again.
    const review = await openReview(user);
    await user.click(within(review).getByRole("radio", { name: "Changes" }));
    expect(
      within(review).getByRole("region", { name: "Changes from the starting policy" }).textContent,
    ).toContain("No changes from the starting policy.");
  });

  it("runs at once, with no confirmation step", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    await user.click(screen.getByRole("switch", { name: "fixture:control" }));
    await user.click(screen.getByRole("button", { name: CLEAR }));

    // The hand-built file menu has no confirm dialog; this page adds none.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(statusText()).toContain(CLEARED);
  });

  it("keeps the chosen file name across a clear", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const review = await openReview(user);
    const field = within(review).getByLabelText("File name");
    await user.clear(field);
    await user.type(field, "payments-team-policy.json");
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: CLEAR }));
    const after = await openReview(user);
    expect((within(after).getByLabelText("File name") as HTMLInputElement).value).toBe(
      "payments-team-policy.json",
    );
  });
});
