/**
 * S5 (NEW-SHELL-PLAN.md §4): the changes screen of the new shell. It diffs
 * the draft against the policy the page opened with, shows the whole file in
 * `#config-preview`, copies the policy JSON, and opens the inspector's draft
 * review and exposure views.
 */
import { Window as HappyWindow } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  changeHunks,
  policyLineDiff,
} from "../../../src/org-policy/workbench/ui/shell/policy-diff.js";
import { tinyStudioModel } from "../studio-test-fixture.js";
import { announcement, closeStudios, preview, settle, studio } from "./shell-parity-harness.js";

// The shell modules are typed against the DOM lib, which the node test
// program does not load; import through a non-literal specifier (as
// new-shell-file-transfer-teardown.test.ts does).
const changesScreenModule: string = "../../../src/org-policy/workbench/ui/shell/changes-screen.js";
const { mountChangesScreen } = (await import(changesScreenModule)) as {
  mountChangesScreen(
    body: unknown,
    options: { baseline: string; announce(message: string): void },
  ): { render(policy: unknown, text: string): void; setView(view: "changes" | "whole"): void };
};

afterEach(closeStudios);

function newShell() {
  return studio(tinyStudioModel()).window;
}

type Window = ReturnType<typeof newShell>;

function click(node: { dispatchEvent(event: unknown): boolean } | null, window: Window): void {
  if (node === null) throw new Error("expected a control");
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

describe("policy line diff", () => {
  it("marks removed and added lines against the baseline", () => {
    const diff = policyLineDiff("a\nb\nc\n", "a\nB\nc\nd\n");
    expect(diff.map((line) => `${line.kind}${line.text}`)).toEqual([" a", "-b", "+B", " c", "+d"]);
    expect(diff.filter((line) => line.kind !== "-").map((line) => line.line)).toEqual([1, 2, 3, 4]);
  });

  it("reports no change for equal text", () => {
    expect(policyLineDiff("x\ny\n", "x\ny\n").every((line) => line.kind === " ")).toBe(true);
  });

  it("keeps context around changes and folds the rest into gaps", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 10", "line ten");
    const hunks = changeHunks(policyLineDiff(before, after), 2);
    expect(hunks[0]).toEqual({ kind: "gap", skipped: 8 });
    expect(hunks.filter((entry) => entry.kind === "+" || entry.kind === "-")).toHaveLength(2);
    expect(hunks.at(-1)).toEqual({ kind: "gap", skipped: 7 });
  });

  it("stays correct past the cell budget", () => {
    const before = Array.from({ length: 3000 }, (_, index) => `a${index}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, index) => `b${index}`).join("\n");
    const diff = policyLineDiff(before, after);
    expect(diff.filter((line) => line.kind === "-")).toHaveLength(3000);
    expect(diff.filter((line) => line.kind === "+")).toHaveLength(3000);
  });
});

describe("new shell changes screen", () => {
  it("keeps the whole file in #config-preview and starts with no changes", () => {
    const window = newShell();
    const document = window.document;
    const screen = document.querySelector('[data-wb-screen-panel="changes"] [data-wb-changes]');
    expect(screen?.querySelector("#json-editor #config-preview")).not.toBeNull();
    expect(document.querySelector("[data-wb-changes-count]")?.textContent).toBe(
      "No changes from the starting policy",
    );
    expect(
      document.querySelector('[data-wb-changes-view="whole"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.getElementById("json-editor")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("[data-wb-changes-diff]")?.hasAttribute("hidden")).toBe(true);
  });

  it("shows the draft's changes against the starting policy", () => {
    const window = newShell();
    const document = window.document;
    click(document.querySelector("button[data-workbench-row-action]"), window);
    click(document.querySelector('[data-wb-changes-view="changes"]'), window);
    expect(document.getElementById("json-editor")?.hasAttribute("hidden")).toBe(true);
    const diff = document.querySelector("[data-wb-changes-diff]");
    expect(diff?.hasAttribute("hidden")).toBe(false);
    const added = diff?.querySelectorAll('[data-wb-diff-line="added"]') ?? [];
    expect(added.length).toBeGreaterThan(0);
    const addedText = [...added].map((row) => row.textContent ?? "").join("\n");
    expect(preview(window)).toContain(addedText.split("\n")[0]?.replace(/^\d+\+/u, "") ?? "");
    expect(document.querySelector("[data-wb-changes-count]")?.textContent).toMatch(
      /^\d+ changed lines?$/u,
    );
    click(document.querySelector('[data-wb-changes-view="whole"]'), window);
    expect(document.getElementById("json-editor")?.hasAttribute("hidden")).toBe(false);
  });

  it("copies the whole policy JSON to the clipboard", async () => {
    const window = newShell();
    const document = window.document;
    let copied = "";
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied = text;
        },
      },
    });
    click(document.querySelector("[data-wb-changes-copy]"), window);
    await settle(window, () => announcement(window).includes("copied"));
    expect(copied).toBe(preview(window));
    expect(announcement(window)).toBe("Policy JSON copied to the clipboard.");
  });

  it("reports a clipboard failure instead of claiming a copy", async () => {
    const window = newShell();
    const document = window.document;
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    click(document.querySelector("[data-wb-changes-copy]"), window);
    await settle(window, () => announcement(window).includes("Copy failed"));
    expect(announcement(window)).toBe("Copy failed: the clipboard is unavailable here.");
  });

  it("opens the inspector's draft review and exposure views", () => {
    const window = newShell();
    const document = window.document;
    const inspector = document.getElementById("workbench-detail-panel");
    click(document.querySelector('[data-wb-changes-open="draft"]'), window);
    expect(inspector?.getAttribute("data-workbench-inspector-view")).toBe("draft");
    click(document.querySelector('[data-wb-changes-open="exposure"]'), window);
    expect(inspector?.getAttribute("data-workbench-inspector-view")).toBe("exposure");
  });

  it("writes hostile policy text in the diff as text, never as markup", () => {
    const window = new HappyWindow();
    const scope = globalThis as unknown as { document?: unknown };
    const previous = scope.document;
    scope.document = window.document;
    try {
      const hostile = '<img src=x onerror="globalThis.__pwned=1">';
      const body = window.document.createElement("div");
      const screen = mountChangesScreen(body, {
        baseline: "{}\n",
        announce() {},
      });
      screen.render({}, `${JSON.stringify({ label: hostile }, null, 2)}\n`);
      screen.setView("changes");
      const diff = body.querySelector("[data-wb-changes-diff]");
      expect(diff?.querySelectorAll("img")).toHaveLength(0);
      expect(diff?.textContent).toContain(hostile.replaceAll('"', '\\"'));
    } finally {
      scope.document = previous;
      window.close();
    }
  });
});
