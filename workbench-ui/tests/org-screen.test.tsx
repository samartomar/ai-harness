import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { alertText, createTestHost, fixtureModel, statusText } from "./test-host.js";

/**
 * Inventory rows 8, 9, 13 and 14: the provenance strip, the readiness line
 * with the adoption recipe and the evidence drawers, developer tool setup,
 * and the ECC hook controls. The intent is ported from
 * `tests/org-policy/workbench/new-shell-org.test.ts` (organization screen and
 * evidence rows) and `developer-tool-catalog.test.ts` (the seven rows and
 * their recorded choice).
 */

const NO_CONTROLS =
  "No Core controls selected. Choose controls after setting the hosts and posture you intend to use.";
const DEVELOPER_TOOL_SAVED = "Saved as an explicit developer-tool policy choice.";
const HOSTILE = '<img src=x onerror="globalThis.__pwned=1">';

const sha = (letter: string) => `sha256:${letter.repeat(64)}`;

function withEccHooks(model: Record<string, unknown>): Record<string, unknown> {
  const controls = (model.catalog as { eccHookControls: Record<string, unknown> }).eccHookControls;
  controls.hooks = [
    {
      id: "pre:bash:block-no-verify",
      event: "PreToolUse",
      profiles: ["minimal", "standard", "strict"],
      disableEligible: true,
    },
    {
      id: "pre:bash:dispatcher",
      event: "PreToolUse",
      profiles: ["minimal", "standard", "strict"],
      disableEligible: false,
    },
  ];
  (controls.disabledHooks as Record<string, unknown>).eligibleIds = ["pre:bash:block-no-verify"];
  return model;
}

beforeEach(() => {
  location.hash = "#/admin";
});
afterEach(cleanup);

async function openOrg(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Organization" }));
  return screen.getByRole("main", { name: "Organization" });
}

describe("organization screen", () => {
  it("announces deployment readiness politely, with the hand-built sentence", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const org = await openOrg(user);
    const readiness = within(org).getByRole("status", { name: "Deployment readiness" });
    expect(readiness.getAttribute("aria-live")).toBe("polite");
    expect(readiness.textContent).toBe(NO_CONTROLS);
  });

  it("opens the adoption recipe from the keyboard and closes it on Escape", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const org = await openOrg(user);
    const trigger = within(org).getByRole("button", { name: "Adoption recipe →" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Adoption recipe" });
    expect(dialog.textContent).toContain("Reading it does not change your policy.");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Adoption recipe" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows no evidence drawer when the artifact carries no delivery data", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const org = await openOrg(user);
    expect(within(org).queryByRole("button", { name: "Evidence & versions" })).toBeNull();
  });

  it("lists the evidence and versions rows as text, never as markup", async () => {
    const user = userEvent.setup();
    const model = fixtureModel();
    model.evidenceDelivery = {
      coreVersion: "0.5.0",
      workbenchCatalogDigest: sha("c"),
      vendorLockDigest: sha("d"),
      scannerLibraryVersion: "0.3.0",
      expectedScannerPublisher: {
        repository: "fixture/scan",
        workflow: "fixture/scan/.github/workflows/publish.yml",
        ref: "refs/heads/main",
        commit: "a".repeat(40),
      },
      publicBaseline: {
        publisher: HOSTILE,
        workflow: "fixture/core/.github/workflows/vendor.yml",
        artifactDigest: sha("b"),
        verifiedAt: "2026-09-06T00:00:00Z",
        validUntil: "2026-09-07T00:00:00Z",
      },
    };
    render(<App host={createTestHost()} model={model} />);

    const org = await openOrg(user);
    await user.click(within(org).getByRole("button", { name: "Evidence & versions" }));
    const dialog = screen.getByRole("dialog", { name: "Evidence & versions · Core 0.5.0" });
    expect(dialog.textContent).toContain("This Workbench catalog");
    expect(dialog.textContent).toContain(sha("c"));
    expect(dialog.textContent).toContain(HOSTILE);
    expect(dialog.textContent).toContain("A scan does not grant organization approval.");
    expect(dialog.querySelectorAll("img")).toHaveLength(0);
    expect((globalThis as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it("prints the provenance lines under the header, on every admin screen", async () => {
    const user = userEvent.setup();
    const model = fixtureModel();
    model.catalogProvenance = {
      tier: "publisher",
      sourceId: "source:fixture-core",
      channel: "stable",
      resolvedAt: "2026-09-06T00:00:00Z",
      ageSeconds: null,
      bootstrapProvenance: "packaged",
    };
    render(<App host={createTestHost()} model={model} />);

    const strip = screen.getByRole("region", { name: "Artifact provenance" });
    expect(strip.textContent).toContain("Supported catalog · verified publisher");
    expect(strip.textContent).toContain("packaged fallback (no download age)");
    await openOrg(user);
    expect(screen.getByRole("region", { name: "Artifact provenance" })).toBeDefined();
  });

  it("shows no provenance strip when the artifact carries no provenance", () => {
    render(<App host={createTestHost()} model={fixtureModel()} />);
    expect(screen.queryByRole("region", { name: "Artifact provenance" })).toBeNull();
  });

  it("records an explicit developer tool choice and says so in words", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const org = await openOrg(user);
    const setup = within(org).getByRole("region", { name: "Developer tool setup" });
    expect(within(setup).getAllByRole("article")).toHaveLength(7);
    expect(setup.textContent).toContain("Developer tool setup: All default tools selected");

    const serena = within(setup).getByRole("article", { name: "Serena" });
    expect(serena.textContent).toContain("Selected: pending setup");
    await user.click(within(serena).getByRole("button", { name: "Exclude Serena from setup" }));

    expect(statusText()).toContain(DEVELOPER_TOOL_SAVED);
    const excluded = within(
      within(org).getByRole("region", { name: "Developer tool setup" }),
    ).getByRole("article", { name: "Serena" });
    expect(excluded.textContent).toContain("Excluded by policy");
    expect(within(excluded).getByRole("button", { name: "Include Serena in setup" })).toBeDefined();
  });

  it("disables a hook only under a recorded profile, and re-enables it", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={withEccHooks(fixtureModel())} />);

    const org = await openOrg(user);
    const ecc = within(org).getByRole("region", { name: "ECC hook controls" });
    expect(ecc.textContent).toContain("it is not AIH enforcement");
    // Without a profile the control is present and labelled, never silent.
    const before = within(ecc).getByRole("button", { name: "Disable pre:bash:block-no-verify" });
    expect((before as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(ecc).getByText("Required wrapper; no individual disabled setting."),
    ).toBeDefined();

    await user.click(within(ecc).getByRole("radio", { name: "Strict" }));
    expect(statusText()).toContain("ECC hook profile set to strict.");

    await user.click(
      within(within(org).getByRole("region", { name: "ECC hook controls" })).getByRole("button", {
        name: "Disable pre:bash:block-no-verify",
      }),
    );
    expect(statusText()).toContain(
      "Disabled pre:bash:block-no-verify for ECC's strict profile. ECC applies this after process spawn; it is not AIH enforcement.",
    );
    await user.click(
      within(within(org).getByRole("region", { name: "ECC hook controls" })).getByRole("button", {
        name: "Re-enable pre:bash:block-no-verify",
      }),
    );
    expect(statusText()).toContain("Re-enabled pre:bash:block-no-verify");
    expect(alertText()).toBe("");
  });
});
