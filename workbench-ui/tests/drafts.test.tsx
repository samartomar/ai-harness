import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { createTestHost, fixtureModel, golden, jsonFile } from "./test-host.js";

/**
 * Lane B of the editor port, inventory rows 19-21: draft review, policy
 * exposure and the review badge; starting points, exclusions, repairs and the
 * comparison confirm; the import migration message and preview. Queried by
 * role and accessible name only, porting the intent of
 * `tests/org-policy/workbench/new-shell-changes.test.ts` (its inspector part)
 * and `legacy-download-characterization.test.ts` (the migration goldens).
 *
 * These panels are mounted in the "Review changes" flyout until the inspector
 * exists; the lead moves them into inspector tabs at merge.
 */

const EMPTY_DRAFT = "This draft has no saved choices, requests, dependencies, or exclusions.";

beforeEach(() => {
  location.hash = "#/admin";
});
afterEach(cleanup);

async function openReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Review Changes" }));
  return screen.getByRole("dialog", { name: "Review changes" });
}

describe("row 19: draft review", () => {
  it("starts empty and says so in the hand-built page's words", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const review = await openReview(user);
    const draft = within(review).getByRole("region", { name: "Review draft" });
    expect(within(draft).getByRole("heading", { name: "Review draft (0 entries)" })).toBeDefined();
    expect(draft.textContent).toContain(EMPTY_DRAFT);
    expect(draft.textContent).toContain("0 saved entries. Changes here update your policy draft.");
  });

  it("lists a selection as a saved entry with its origin", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    await user.click(screen.getByRole("switch", { name: "fixture:control" }));

    const review = await openReview(user);
    const draft = within(review).getByRole("region", { name: "Review draft" });
    expect(draft.textContent).not.toContain(EMPTY_DRAFT);
    const entries = within(draft).getByRole("list", { name: "Saved draft entries" });
    expect(within(entries).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(entries.textContent).toContain("Origin: Administrator");
  });

  it("names the draft counts and never a token or cost figure", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const review = await openReview(user);
    const counts = within(review)
      .getByRole("region", { name: "Review draft" })
      .querySelector('[aria-label="Draft counts"]');
    expect(counts?.textContent).toContain("Controls");
    expect(counts?.textContent).toContain("Selections");
    expect(counts?.textContent).toContain("Requests");
    expect(counts?.textContent ?? "").not.toMatch(/token|\$/iu);
  });

  it("shows the review badge beside the trigger, and follows the draft", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    expect(screen.getByLabelText("Draft entries").textContent).toBe("Draft (0)");
    await user.click(screen.getByRole("switch", { name: "fixture:control" }));
    expect(screen.getByLabelText("Draft entries").textContent).not.toBe("Draft (0)");
    // The trigger keeps its exact accessible name.
    expect(screen.getByRole("button", { name: "Review Changes" })).toBeDefined();
  });

  it("saves a reason on a saved entry", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    await user.click(screen.getByRole("switch", { name: "fixture:control" }));
    const review = await openReview(user);
    const draft = within(review).getByRole("region", { name: "Review draft" });

    await user.click(within(draft).getAllByText("Add a reason")[0] as HTMLElement);
    const field = within(draft).getAllByLabelText(/^Your reason for /u)[0] as HTMLTextAreaElement;
    await user.type(field, "local code review");
    await user.click(
      within(draft).getAllByRole("button", { name: "Save reason" })[0] as HTMLElement,
    );

    expect(
      screen
        .queryAllByRole("status")
        .map((node) => node.textContent ?? "")
        .join(" "),
    ).toContain("Reason saved in this policy draft.");
  });
});

describe("row 19: policy exposure", () => {
  it("shows the exposure counts, the limits sentence and the empty groups", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const review = await openReview(user);
    const exposure = within(review).getByRole("region", { name: "Policy exposure" });
    expect(
      within(exposure).getByRole("heading", { name: "A policy is a shape of exposure" }),
    ).toBeDefined();
    expect(exposure.textContent).toContain("Selected items");
    expect(exposure.textContent).toContain("Items with verified reports");
    expect(exposure.textContent).toContain(
      "Destinations, file access and credential scope may be unspecified.",
    );
    expect(exposure.textContent).toContain("No catalog items are selected.");
    expect(exposure.textContent).toContain("No current catalog requests are pending.");
  });

  it("lists a selected item with its declared access and its checks", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    await user.click(screen.getByRole("switch", { name: "fixture:control" }));
    const review = await openReview(user);
    const selected = within(review).getByRole("region", {
      name: "Selected item declarations",
    });
    expect(selected.textContent).toContain("Declared access: ");
    expect(selected.textContent).toContain("Checks: ");
    expect(selected.textContent).not.toContain("No catalog items are selected.");
  });
});

describe("row 20: starting points, repairs and the comparison", () => {
  it("shows the starting points region and the repairs region", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const review = await openReview(user);
    expect(within(review).getByRole("region", { name: "Starting points" })).toBeDefined();
    const repairs = within(review).getByRole("region", {
      name: "Saved selections needing review",
    });
    expect(repairs.textContent).toContain("No saved selection needs review.");
  });

  it("reviews a replacement before it is confirmed", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const review = await openReview(user);
    const comparison = within(review).getByRole("region", { name: "Review replacement" });
    const chooser = within(comparison).getByLabelText("Item to compare") as HTMLSelectElement;
    const option = [...chooser.options].find((candidate) => candidate.value !== "");
    if (option === undefined) throw new Error("the fixture model has no selectable item");

    await user.selectOptions(chooser, option.value);
    expect(comparison.textContent).toContain("This preview removes ");
    expect(comparison.textContent).toContain("No longer included: ");
    // With no declared conflict the fixture offers the review and refuses the
    // confirm; nothing is applied by opening it.
    const confirm = within(comparison).getByRole("button", { name: "Confirm replacement" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
  });
});

describe("row 21: the import migration message and preview", () => {
  it("shows the migration message and the migrated bytes, as text", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const review = await openReview(user);
    const migration = within(review).getByRole("region", { name: "Import a policy" });
    expect(migration.textContent).toContain("No policy has been imported in this session.");

    const bytes = golden("aih-org-policy.vibe.json");
    await user.upload(
      within(migration).getByLabelText("Import policy for migration"),
      jsonFile("policy.json", bytes),
    );

    const preview = within(migration).getByLabelText(
      "Migrated policy preview",
    ) as HTMLTextAreaElement;
    expect(preview.value).toContain('"schemaVersion"');
    expect(migration.textContent).not.toContain("No policy has been imported in this session.");
  });

  it("keeps the policy and says why when an import is refused", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const review = await openReview(user);
    const migration = within(review).getByRole("region", { name: "Import a policy" });
    const before = (
      within(migration).getByLabelText("Migrated policy preview") as HTMLTextAreaElement
    ).value;

    await user.upload(
      within(migration).getByLabelText("Import policy for migration"),
      jsonFile("bad.json", '{"schemaVersion":2,"schemaVersion":2}'),
    );

    expect(migration.textContent).toContain(
      "Policy import rejected: duplicate JSON object key: schemaVersion",
    );
    expect(
      (within(migration).getByLabelText("Migrated policy preview") as HTMLTextAreaElement).value,
    ).toBe(before);
  });
});
