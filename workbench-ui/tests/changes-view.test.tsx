import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import {
  alertText,
  createTestHost,
  fixtureModel,
  golden,
  jsonFile,
  statusText,
} from "./test-host.js";

/**
 * Editor 1 of the component UI: the Changes view inside the "Review changes"
 * flyout. The intent is ported from
 * `tests/org-policy/workbench/new-shell-changes.test.ts`, by role and
 * accessible name: the whole file and no changes to start with, the draft's
 * diff against the starting policy, Copy JSON, a refused clipboard, and
 * hostile policy text written as text.
 */

const COPIED = "Policy JSON copied to the clipboard.";
const COPY_FAILED = "Copy failed: the clipboard is unavailable here.";
const NO_CHANGES = "No changes from the starting policy.";
const HOSTILE = '<img src=x onerror="globalThis.__pwned=1">';

beforeEach(() => {
  location.hash = "#/admin";
});
afterEach(cleanup);

async function openReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Review Changes" }));
  return screen.getByRole("dialog", { name: "Review changes" });
}

async function showChanges(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.click(within(dialog).getByRole("radio", { name: "Changes" }));
  return within(dialog).getByRole("region", { name: "Changes from the starting policy" });
}

describe("changes view", () => {
  it("keeps the whole file and starts with no changes", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const review = await openReview(user);
    expect(within(review).getByRole("radio", { name: "Whole file", checked: true })).toBeDefined();
    const field = within(review).getByLabelText("Organization policy file") as HTMLTextAreaElement;
    expect(field.value).toContain('"schemaVersion"');

    const diff = await showChanges(user, review);
    expect(diff.textContent).toContain(NO_CHANGES);
    expect(within(review).queryByLabelText("Organization policy file")).toBeNull();
  });

  it("shows the draft's changes against the starting policy", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    await user.click(screen.getByRole("switch", { name: "fixture:control" }));

    const review = await openReview(user);
    const whole = (within(review).getByLabelText("Organization policy file") as HTMLTextAreaElement)
      .value;

    const diff = await showChanges(user, review);
    const added = within(diff).getAllByLabelText(/^Added: /u);
    expect(added.length).toBeGreaterThan(0);
    // Every added line is a line of the whole file, and is marked with "+",
    // not by colour alone.
    for (const row of added) {
      const text = (row.getAttribute("aria-label") ?? "").replace(/^Added: /u, "");
      expect(whole).toContain(text);
      expect(row.textContent).toContain("+");
    }
    expect(diff.textContent).not.toContain(NO_CHANGES);

    await user.click(within(review).getByRole("radio", { name: "Whole file" }));
    expect(within(review).getByLabelText("Organization policy file")).toBeDefined();
  });

  it("copies the whole policy JSON to the clipboard", async () => {
    const user = userEvent.setup();
    const host = createTestHost();
    render(<App host={host} model={fixtureModel()} />);

    const review = await openReview(user);
    const whole = (within(review).getByLabelText("Organization policy file") as HTMLTextAreaElement)
      .value;
    await user.click(within(review).getByRole("button", { name: "Copy JSON" }));

    expect(host.copyText).toHaveBeenCalledWith(whole);
    expect(statusText()).toContain(COPIED);
    expect(alertText()).not.toContain("Copy failed");
  });

  it("reports a clipboard failure instead of claiming a copy", async () => {
    const user = userEvent.setup();
    const host = createTestHost({ clipboard: false });
    render(<App host={host} model={fixtureModel()} />);

    const review = await openReview(user);
    await user.click(within(review).getByRole("button", { name: "Copy JSON" }));

    expect(alertText()).toContain(COPY_FAILED);
    expect(statusText()).not.toContain(COPIED);
  });

  it("writes hostile policy text in the diff as text, never as markup", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    // The hostile text reaches the policy through an import, and therefore
    // the diff against the starting policy.
    const imported = JSON.parse(golden("aih-org-policy.vibe.json")) as Record<string, unknown>;
    (imported.governance as Record<string, unknown>).policyVersion = HOSTILE;
    await user.upload(
      screen.getByLabelText("Import policy"),
      jsonFile("hostile.json", `${JSON.stringify(imported, null, 2)}\n`),
    );

    const review = await openReview(user);
    const diff = await showChanges(user, review);
    expect(diff.querySelectorAll("img")).toHaveLength(0);
    expect(within(diff).queryAllByRole("img")).toEqual([]);
    // Exactly as the hand-built test asserts it: the JSON-escaped text.
    expect(diff.textContent).toContain(HOSTILE.replaceAll('"', '\\"'));
    expect((globalThis as { __pwned?: unknown }).__pwned).toBeUndefined();
  });
});
