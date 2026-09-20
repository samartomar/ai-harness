import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_IMPORT_BYTES } from "../../src/org-policy/workbench/engine/index.js";
import { App } from "../src/App.js";
import { alertText, createTestHost, fixtureModel, golden, jsonFile } from "./test-host.js";

/** The first slice's failure cases, at the level of the two pages. */

afterEach(cleanup);

const HOSTILE = "<img src=x onerror=alert(1)>";
const DIGEST = "a".repeat(64);

function boundUserModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    door: "user",
    policySource: { kind: "binding", path: "/p/.aih-config.json", valid: true, sha256: DIGEST },
    initialPolicy: JSON.parse(golden("aih-org-policy.v3-selection.json")),
    workbenchBundle: fixtureModel().workbenchBundle,
    ...overrides,
  };
}

/** A file the browser reports as oversized; its bytes must never be read. */
function oversizeFile(): File {
  const file = jsonFile("huge.json", "{}");
  Object.defineProperty(file, "size", { value: MAX_IMPORT_BYTES + 1 });
  return file;
}

async function openReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Review Changes" }));
  return screen.getByRole("dialog", { name: "Review changes" });
}

describe("admin failure cases", () => {
  it("refuses an import that is not strict JSON and keeps the policy (cases 1 and 4)", async () => {
    const user = userEvent.setup();
    location.hash = "#/admin";
    render(<App host={createTestHost()} model={fixtureModel()} />);

    await user.upload(
      screen.getByLabelText("Import policy"),
      jsonFile("bad.json", '{"schemaVersion": 2,}'),
    );
    expect(alertText()).toContain("Policy import rejected:");

    const review = await openReview(user);
    expect(
      (within(review).getByLabelText("Organization policy file") as HTMLTextAreaElement).value,
    ).toBe(golden("aih-org-policy.vibe.json"));
  });

  it("refuses an oversized import before reading the file (case 2)", async () => {
    const user = userEvent.setup();
    location.hash = "#/admin";
    render(<App host={createTestHost()} model={fixtureModel()} />);
    const file = oversizeFile();
    const read = vi.spyOn(file, "arrayBuffer");

    await user.upload(screen.getByLabelText("Import policy"), file);
    expect(alertText()).toContain("Import rejected: file exceeds the 1 MiB limit.");
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps the committed policy and the draft file name through a rejected import (case 3)", async () => {
    const user = userEvent.setup();
    location.hash = "#/admin";
    render(<App host={createTestHost()} model={fixtureModel()} />);

    let review = await openReview(user);
    await user.clear(within(review).getByLabelText("File name"));
    await user.type(within(review).getByLabelText("File name"), "team-policy.json");
    await user.keyboard("{Escape}");

    await user.upload(
      screen.getByLabelText("Import policy"),
      jsonFile("bad.json", JSON.stringify({ schemaVersion: 2, minimumPosture: "nonsense" })),
    );
    expect(alertText()).toContain("Policy import rejected:");

    review = await openReview(user);
    expect((within(review).getByLabelText("File name") as HTMLInputElement).value).toBe(
      "team-policy.json",
    );
    expect(
      (within(review).getByLabelText("Organization policy file") as HTMLTextAreaElement).value,
    ).toBe(golden("aih-org-policy.vibe.json"));
  });

  it("refuses an unsafe download file name and saves nothing (case 5)", async () => {
    const user = userEvent.setup();
    const host = createTestHost();
    location.hash = "#/admin";
    render(<App host={host} model={fixtureModel()} />);

    const review = await openReview(user);
    await user.clear(within(review).getByLabelText("File name"));
    await user.type(within(review).getByLabelText("File name"), "../x.json");
    await user.click(within(review).getByRole("button", { name: "Download" }));

    expect(alertText()).toContain(
      "Download blocked: Use a JSON filename without folders, spaces, or hidden characters.",
    );
    expect(host.save).not.toHaveBeenCalled();
  });

  it("disables the gates with a visible reason on an invalid prepared catalog (case 6)", async () => {
    const user = userEvent.setup();
    const host = createTestHost();
    const model = fixtureModel();
    delete model.workbenchBindings;
    location.hash = "#/admin";
    render(<App host={host} model={model} />);

    const reason =
      "Prepared catalog is invalid or unavailable. Regenerate this artifact with Core.";
    expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
    expect(
      (screen.getByRole("button", { name: "Check Policy" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    const review = await openReview(user);
    expect(
      (within(review).getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.keyboard("{Escape}");

    await user.upload(
      screen.getByLabelText("Import policy"),
      jsonFile("ok.json", golden("aih-org-policy.vibe.json")),
    );
    expect(alertText()).toContain("Policy import rejected:");
    expect(host.save).not.toHaveBeenCalled();
  });

  it("renders hostile catalog text as text, never as markup (case 7)", () => {
    const model = fixtureModel();
    const assets = (model.workbenchBundle as { assets: Record<string, { label: string }> }).assets;
    const control = assets["fixture:control"];
    if (control !== undefined) control.label = HOSTILE;
    location.hash = "#/admin";
    render(<App host={createTestHost()} model={model} />);

    expect(screen.queryAllByRole("img")).toEqual([]);
    expect(screen.getByText(HOSTILE)).toBeDefined();
    expect(screen.getByRole("switch", { name: HOSTILE })).toBeDefined();
  });

  it("names the host capability it lacks instead of hiding the control", () => {
    location.hash = "#/admin";
    render(<App host={createTestHost({ githubIntake: false })} model={fixtureModel()} />);
    const control = screen.getByRole("button", { name: "Import skills from GitHub" });
    expect((control as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Available on the local page opened by npx @aihq/core --ui"),
    ).toBeDefined();
  });

  it("reports the engine's errors and renders nothing else on a malformed model", () => {
    location.hash = "#/admin";
    render(<App host={createTestHost()} model={42} />);
    expect(alertText()).toContain("The Workbench model must be a JSON object.");
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });
});

describe("user failure cases", () => {
  it("refuses an oversized organization policy before reading it (case 2)", async () => {
    const user = userEvent.setup();
    location.hash = "#/user";
    render(<App host={createTestHost({ boundPolicy: false })} model={fixtureModel()} />);
    const file = oversizeFile();
    const read = vi.spyOn(file, "arrayBuffer");

    await user.upload(screen.getByLabelText("Import organization policy"), file);
    expect(alertText()).toContain("Import rejected: file exceeds the 1 MiB limit.");
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps a hostile asset id raw in the saved project file (case 7)", async () => {
    const user = userEvent.setup();
    const host = createTestHost({ boundPolicy: true });
    location.hash = "#/user";
    render(
      <App
        host={host}
        model={boundUserModel({
          initialPolicy: {
            schemaVersion: 3,
            minimumPosture: "vibe",
            governance: { supportedClis: ["claude"] },
            authoringSelections: {
              selectionVersion: "workbench-selection/v1",
              roots: [
                {
                  assetId: HOSTILE,
                  origin: { kind: "administrator" },
                  resolvedItems: [{ assetId: HOSTILE }],
                },
              ],
              exclusions: [],
              requests: [],
              drafts: [],
            },
          },
          workbenchBundle: { assets: {} },
        })}
      />,
    );

    expect(screen.queryAllByRole("img")).toEqual([]);
    const card = screen.getByRole("radiogroup", { name: HOSTILE });
    await user.click(within(card).getByRole("radio", { name: "Required" }));
    await user.type(screen.getByLabelText("Name"), "Payments API");
    await user.click(screen.getByRole("checkbox", { name: "claude" }));
    await user.click(screen.getByRole("button", { name: "Save aih-project-policy.json" }));

    expect(host.save).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(host.save.mock.calls[0]?.[0].text ?? "{}") as {
      items: { assetId: string }[];
    };
    expect(saved.items[0]?.assetId).toBe(HOSTILE);
  });

  it("shows the exact blocked sentence for each unusable policy state (case 8)", () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        boundUserModel({ policySource: undefined }),
        "No policy source was provided. Saving is disabled.",
      ],
      [
        boundUserModel({ policySource: { kind: "binding", valid: false, error: "unreadable" } }),
        "The policy source is invalid: unreadable. Saving is disabled.",
      ],
      [
        boundUserModel({ policySource: { kind: "binding", valid: true } }),
        "The policy digest is unavailable. Saving is disabled.",
      ],
      [
        boundUserModel({ initialPolicy: { schemaVersion: 9 } }),
        "The org policy is unavailable. Saving is disabled.",
      ],
      [
        boundUserModel({ initialPolicy: { schemaVersion: 3, minimumPosture: "vibe" } }),
        "The org policy lists no items. Saving is disabled.",
      ],
    ];
    location.hash = "#/user";
    for (const [model, sentence] of cases) {
      const view = render(<App host={createTestHost({ boundPolicy: true })} model={model} />);
      expect(screen.getByText(sentence)).toBeDefined();
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect(
        (
          screen.getByRole("button", {
            name: "Save aih-project-policy.json",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Check Selection" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      view.unmount();
    }
  });

  it("lists the server data a digest-less model is missing", () => {
    location.hash = "#/user";
    render(
      <App
        host={createTestHost({ boundPolicy: true })}
        model={boundUserModel({ policySource: { kind: "binding", valid: true } })}
      />,
    );
    expect(screen.getByText(/policySource\.sha256/u)).toBeDefined();
  });

  it("refuses an empty project name and saves nothing (case 9)", async () => {
    const user = userEvent.setup();
    const host = createTestHost({ boundPolicy: true });
    location.hash = "#/user";
    render(<App host={host} model={boundUserModel()} />);

    await user.click(
      within(screen.getByRole("radiogroup", { name: "fixture:control" })).getByRole("radio", {
        name: "Required",
      }),
    );
    await user.click(screen.getByRole("checkbox", { name: "claude" }));
    await user.click(screen.getByRole("button", { name: "Check Selection" }));

    expect(alertText()).toContain("name");
    expect(host.save).not.toHaveBeenCalled();
  });
});
