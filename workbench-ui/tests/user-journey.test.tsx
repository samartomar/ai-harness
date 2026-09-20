import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import {
  createTestHost,
  fixtureModel,
  golden,
  jsonFile,
  sha256Of,
  statusText,
} from "./test-host.js";

/** Journey J2 through the component UI: the user page produces output B. */

beforeEach(() => {
  location.hash = "#/user";
});
afterEach(cleanup);

async function importOrgPolicy(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
): Promise<void> {
  await user.upload(
    screen.getByLabelText("Import organization policy"),
    jsonFile("aih-org-policy.json", text),
  );
}

async function fillSelection(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const card = screen.getByRole("radiogroup", { name: "fixture:control" });
  await user.click(within(card).getByRole("radio", { name: "Required" }));
  await user.type(screen.getByLabelText("Name"), "Payments API");
  await user.click(screen.getByRole("checkbox", { name: "claude" }));
}

describe("user journey", () => {
  it("imports the organization policy, trims it, and saves the project anchor", async () => {
    const user = userEvent.setup();
    const host = createTestHost({ boundPolicy: false });
    render(<App host={host} model={fixtureModel()} />);

    expect(screen.getByText(/This page has no bound policy\./u)).toBeDefined();
    await importOrgPolicy(user, golden("aih-org-policy.v3-selection.json"));

    expect(screen.getByRole("radio", { name: "Project", checked: true })).toBeDefined();
    await fillSelection(user);

    await user.click(screen.getByRole("button", { name: "Check Selection" }));
    expect(statusText()).toContain("The selection narrows the organization policy.");

    await user.click(screen.getByRole("button", { name: "Save aih-project-policy.json" }));
    expect(host.save).toHaveBeenCalledTimes(1);
    expect(host.save.mock.calls[0]?.[0]).toEqual({
      name: "aih-project-policy.json",
      text: golden("aih-project-policy.v3-selection.json"),
    });
  });

  it("digests the bytes it was given, not the JSON it re-serializes", async () => {
    const user = userEvent.setup();
    const host = createTestHost({ boundPolicy: false });
    render(<App host={host} model={fixtureModel()} />);

    // The same policy, indented differently: its bytes are not the golden's.
    const reindented = `${JSON.stringify(
      JSON.parse(golden("aih-org-policy.v3-selection.json")),
      null,
      4,
    )}\n`;
    expect(reindented).not.toBe(golden("aih-org-policy.v3-selection.json"));
    await importOrgPolicy(user, reindented);
    await fillSelection(user);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(host.save).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(host.save.mock.calls[0]?.[0].text ?? "{}") as {
      cutFrom: { sha256: string; schemaVersion: number };
    };
    expect(saved.cutFrom.sha256).toBe(sha256Of(reindented));
    expect(saved.cutFrom.sha256).not.toBe(sha256Of(golden("aih-org-policy.v3-selection.json")));
    expect(saved.cutFrom.schemaVersion).toBe(3);
  });

  it("counts the choices in What your AI carries", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost({ boundPolicy: false })} model={fixtureModel()} />);
    await importOrgPolicy(user, golden("aih-org-policy.v3-selection.json"));

    const panel = screen.getByRole("heading", { name: "What your AI carries" })
      .parentElement as HTMLElement;
    expect(panel.textContent).toContain("Optional");
    const card = screen.getByRole("radiogroup", { name: "fixture:control" });
    await user.click(within(card).getByRole("radio", { name: "Skip" }));
    expect(within(card).getByRole("radio", { name: "Skip", checked: true })).toBeDefined();

    await user.click(
      within(screen.getByRole("radiogroup", { name: "For" })).getByRole("radio", {
        name: "Persona",
      }),
    );
    expect(panel.textContent).toContain("persona");

    await user.click(screen.getByRole("button", { name: "Switch to light mode" }));
    expect(document.documentElement.dataset.mode).toBe("light");
  });
});
