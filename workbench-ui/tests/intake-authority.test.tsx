import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { WorkbenchGithubSkillHost } from "../src/host.js";
import {
  alertText,
  createTestHost,
  fixtureModel as fixture,
  golden,
  jsonFile,
  statusText,
} from "./test-host.js";

/**
 * Editors 22, 18 and 23: the artifact intake workspace, the GitHub Skill
 * intake, and protected bundle authoring. The intent is ported from
 * `tests/org-policy/workbench/new-shell-download-compat.test.ts` (both
 * byte-for-byte tests) and the intake runtime's own refusals.
 *
 * These editors are on the Additions screen.
 */

const HOSTILE = '<img src=x onerror="globalThis.__pwned=1">';
const SCREEN = "Additions";
const ADDED =
  "Non-authoritative candidate added to the shared review queue. Add another item or download one intake file.";
const IMPORTED =
  "Non-authoritative artifact intake imported. Imported evidence drafts were preserved without verification.";
const GITHUB_REASON = "Available on the local page opened by npx @aihq/core --ui";

const INTAKE_GOLDEN_INPUT = {
  format: "aih-artifact-intake",
  version: 2,
  authority: { state: "not-authority" },
  defaults: { accountableOwner: "platform@acme.example" },
  items: [
    {
      id: "firecrawl-mcp",
      kind: "mcp",
      source: {
        type: "npm",
        registry: "https://registry.npmjs.org",
        package: "firecrawl-mcp",
        version: "3.24.0",
      },
    },
    {
      id: "acme-skill",
      kind: "skill",
      accountableOwner: "skills@acme.example",
      clarification: "Pinned review skill",
      source: {
        type: "github",
        repository: "acme/skills",
        commit: "b".repeat(40),
        path: "skills/review",
      },
    },
    {
      id: "pulse-directory",
      kind: "mcp",
      source: {
        type: "directory",
        provider: "pulsemcp",
        url: "https://www.pulsemcp.com/servers/acme",
      },
    },
  ],
};

beforeEach(() => {
  location.hash = "#/admin";
});
afterEach(cleanup);

async function openScreen(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: SCREEN }));
  return screen.getByRole("main", { name: SCREEN });
}

/** Fill the review queue's add form for one exact npm source. */
async function fillNpm(user: ReturnType<typeof userEvent.setup>, main: HTMLElement) {
  const form = queue(main);
  await user.type(field(form, "Default accountable owner email"), "platform@acme.example");
  await user.type(field(form, "Item identifier"), "firecrawl-mcp");
  await user.type(field(form, "Exact npm package"), "firecrawl-mcp");
  await user.type(field(form, "Exact version"), "3.24.0");
}

describe("artifact intake workspace (editor 22)", () => {
  it("opens with an empty queue and both downloads refused", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixture()} />);
    const main = await openScreen(user);

    expect(
      within(main).getByText(
        "0 / 100 candidates · no intake loaded. Add an item or import one file.",
      ),
    ).toBeDefined();
    expect(button(main, "Download one intake file").disabled).toBe(true);
    expect(button(main, "Add to review queue").disabled).toBe(true);
  });

  it("adds an exact npm source, then clears the item fields", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixture()} />);
    const main = await openScreen(user);

    await fillNpm(user, main);
    expect(button(main, "Add to review queue").disabled).toBe(false);
    await user.click(button(main, "Add to review queue"));

    expect(statusText()).toContain(ADDED);
    expect(within(main).getByText("MCP · firecrawl-mcp")).toBeDefined();
    expect(
      within(main).getByText("Accountable owner: platform@acme.example · Intake is not authority"),
    ).toBeDefined();
    // The owner survives; the item's own fields are cleared for the next one.
    const form = queue(main);
    expect(field(form, "Item identifier").value).toBe("");
    expect(field(form, "Default accountable owner email").value).toBe("platform@acme.example");
  });

  it("refuses an item the intake rules reject, and keeps the queue", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixture()} />);
    const main = await openScreen(user);

    await fillNpm(user, main);
    await user.click(button(main, "Add to review queue"));
    // A mutable version is not an exact source: the control stays refused.
    const form = queue(main);
    await user.type(field(form, "Item identifier"), "second-mcp");
    await user.type(field(form, "Exact npm package"), "second-mcp");
    await user.type(field(form, "Exact version"), "latest");
    expect(button(main, "Add to review queue").disabled).toBe(true);
    expect(within(main).getAllByText(/^MCP · /u)).toHaveLength(1);
  });

  it("imports an intake file and downloads it byte-for-byte", async () => {
    const user = userEvent.setup();
    const host = createTestHost();
    render(<App host={host} model={fixture()} />);
    const main = await openScreen(user);

    await user.upload(
      screen.getByLabelText("Import existing artifact intake"),
      jsonFile("intake.json", JSON.stringify(INTAKE_GOLDEN_INPUT)),
    );

    await waitFor(() => {
      expect(statusText()).toContain(IMPORTED);
    });
    expect(
      within(main).getByText(
        "3 / 100 candidates · 3 unique exact sources. Imported scanner files remain opaque drafts until Core prepares evidence.",
      ),
    ).toBeDefined();

    await user.click(button(main, "Download one intake file"));
    expect(host.save).toHaveBeenCalledTimes(1);
    expect(host.save.mock.calls[0]?.[0]).toEqual({
      name: "aih-artifact-intake.json",
      text: golden("aih-artifact-intake.json"),
    });
  });

  it("refuses an import that is not strict JSON, as text", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixture()} />);
    const main = await openScreen(user);

    await user.upload(
      screen.getByLabelText("Import existing artifact intake"),
      jsonFile("intake.json", "[]"),
    );

    await waitFor(() => {
      expect(alertText()).toContain("Artifact intake rejected: ");
    });
    expect(button(main, "Download one intake file").disabled).toBe(true);
  });

  it("writes hostile intake text as text, never as markup", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixture()} />);
    const main = await openScreen(user);

    await user.upload(
      screen.getByLabelText("Import existing artifact intake"),
      jsonFile(
        "intake.json",
        JSON.stringify({
          ...INTAKE_GOLDEN_INPUT,
          items: [
            {
              ...INTAKE_GOLDEN_INPUT.items[0],
              clarification: HOSTILE,
            },
          ],
        }),
      ),
    );

    await waitFor(() => {
      expect(statusText()).toContain(IMPORTED);
    });
    expect(main.querySelectorAll("img")).toHaveLength(0);
    expect((globalThis as { __pwned?: unknown }).__pwned).toBeUndefined();
  });
});

describe("GitHub Skill intake (editor 18)", () => {
  it("keeps the words on a host that cannot reach the local server", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost({ githubIntake: false })} model={fixture()} />);
    const main = await openScreen(user);

    const skill = within(main).getByRole("region", { name: "Add an organization Skill" });
    expect(within(skill).getAllByText(GITHUB_REASON).length).toBeGreaterThan(0);
    expect(within(skill).getByRole("button", { name: "Read skill link" })).toBeDefined();
  });

  it("reads an exact permalink offline and fills the add form", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost({ githubIntake: false })} model={fixture()} />);
    const main = await openScreen(user);

    await user.type(
      screen.getByLabelText("Paste a Skill discovery command or exact GitHub permalink"),
      `https://github.com/acme/skills/blob/${"b".repeat(40)}/skills/review/SKILL.md`,
    );
    await user.click(within(main).getByRole("button", { name: "Read skill link" }));

    const form = queue(main);
    await waitFor(() => {
      expect(field(form, "Item identifier").value).toBe("review");
    });
    expect(field(form, "Exact repository").value).toBe("acme/skills");
    expect(field(form, "Exact commit").value).toBe("b".repeat(40));
  });

  it("refuses command syntax, as words, and pins nothing", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost({ githubIntake: false })} model={fixture()} />);
    const main = await openScreen(user);

    await user.type(
      screen.getByLabelText("Paste a Skill discovery command or exact GitHub permalink"),
      "npx skills add acme/skills --skill review && rm",
    );
    await user.click(within(main).getByRole("button", { name: "Read skill link" }));

    const skill = within(main).getByRole("region", { name: "Add an organization Skill" });
    await waitFor(() => {
      expect(skill.textContent).toContain("command syntax is not accepted");
    });
    expect(field(queue(main), "Item identifier").value).toBe("");
  });

  it("pins a commit the connected host resolved, and refuses one it did not", async () => {
    const user = userEvent.setup();
    const githubSkill: WorkbenchGithubSkillHost = {
      resolve: vi.fn().mockResolvedValue({
        version: "aih-connected-github-skill/v1",
        state: "resolved-not-scanned",
        skill: "review",
        source: {
          type: "github",
          repository: "acme/skills",
          commit: "c".repeat(40),
          path: "skills/review/SKILL.md",
        },
      }),
      prepare: vi.fn(),
    };
    const host = { ...createTestHost({ githubIntake: true }), githubSkill };
    render(<App host={host} model={fixture()} />);
    const main = await openScreen(user);

    await user.type(
      screen.getByLabelText("Paste a Skill discovery command or exact GitHub permalink"),
      "https://skills.sh/acme/skills/review",
    );
    await user.click(within(main).getByRole("button", { name: "Resolve skill" }));

    await waitFor(() => {
      expect(field(queue(main), "Exact commit").value).toBe("c".repeat(40));
    });
    expect(githubSkill.resolve).toHaveBeenCalledWith({
      repository: "acme/skills",
      skill: "review",
    });
  });

  it("refuses a resolver answer for another repository", async () => {
    const user = userEvent.setup();
    const githubSkill: WorkbenchGithubSkillHost = {
      resolve: vi.fn().mockResolvedValue({
        version: "aih-connected-github-skill/v1",
        state: "resolved-not-scanned",
        skill: "review",
        source: {
          type: "github",
          repository: "attacker/skills",
          commit: "c".repeat(40),
          path: "skills/review/SKILL.md",
        },
      }),
      prepare: vi.fn(),
    };
    render(
      <App host={{ ...createTestHost({ githubIntake: true }), githubSkill }} model={fixture()} />,
    );
    const main = await openScreen(user);

    await user.type(
      screen.getByLabelText("Paste a Skill discovery command or exact GitHub permalink"),
      "https://skills.sh/acme/skills/review",
    );
    await user.click(within(main).getByRole("button", { name: "Resolve skill" }));

    await waitFor(() => {
      const skill = within(main).getByRole("region", { name: "Add an organization Skill" });
      expect(skill.textContent).toContain("connected Skill resolver returned an invalid result");
    });
    // Nothing was pinned: the GitHub fields are not even shown.
    expect(within(queue(main)).queryByLabelText("Exact commit")).toBeNull();
  });
});

describe("protected bundle authoring (editor 23)", () => {
  it("refuses the form with a message beside each named control", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixture()} />);
    const main = await openScreen(user);

    await user.click(within(main).getByRole("button", { name: "Add exact artifact approval" }));

    await waitFor(() => {
      expect(alertText()).toContain("Correct the highlighted protected policy fields.");
    });
    const panel = within(main).getByRole("region", { name: "Protected Enterprise policy file" });
    // Each control carries its own sentence, beside it, never a colour.
    expect(panel.textContent).toContain("Use a visible bundle version.");
    expect(panel.textContent).toContain("Use a valid accountable owner email address.");
    expect(panel.textContent).toContain("Use an exact lowercase 40 or 64 character commit.");
    // A refused control says so to assistive technology, not by colour.
    expect(
      (within(panel).getByLabelText(/^Bundle version/u) as HTMLInputElement).getAttribute(
        "aria-invalid",
      ),
    ).toBe("true");
    expect(
      (
        within(main).getByRole("textbox", {
          name: "Generated protected policy file",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("");
    expect(button(main, "Download protected policy file").disabled).toBe(true);
    // Pinned as the hand-built page behaves: never an evidence envelope.
    expect(button(main, "Download organization evidence envelope").disabled).toBe(true);
  });

  it("shows only the source fields the chosen source type needs", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixture()} />);
    await openScreen(user);

    expect(screen.getByLabelText("Exact GitHub repository")).toBeDefined();
    expect(screen.queryByLabelText("Canonical HTTPS endpoint")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Source type"), "remote");
    expect(screen.getByLabelText("Canonical HTTPS endpoint")).toBeDefined();
    expect(screen.queryByLabelText("Exact GitHub repository")).toBeNull();
  });

  it("shows the acceptance fields only for accepted-with-conditions", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixture()} />);
    await openScreen(user);

    expect(screen.queryByLabelText("Accepted findings")).toBeNull();
    await user.selectOptions(
      screen.getByLabelText("Decision disposition"),
      "accepted-with-conditions",
    );
    expect(screen.getByLabelText("Accepted findings")).toBeDefined();
    expect(screen.getByLabelText("Review by")).toBeDefined();
  });
});

function button(scope: HTMLElement, name: string): HTMLButtonElement {
  return within(scope).getByRole("button", { name }) as HTMLButtonElement;
}

/**
 * The review queue's own region. The protected form below it names some of
 * the same things ("Exact commit", "Source path"), so every field query is
 * scoped to the editor it belongs to.
 */
function queue(main: HTMLElement) {
  return within(main).getByRole("region", {
    name: "Add and review MCP, Skill, or Agent sources",
  });
}

function field(scope: HTMLElement, label: string): HTMLInputElement {
  return within(scope).getByLabelText(label) as HTMLInputElement;
}
