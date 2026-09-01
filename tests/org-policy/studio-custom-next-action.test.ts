import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const CANDIDATE = {
  id: "acme-mcp",
  owner: "mcp.owner@acme.example",
  pkg: "@acme/mcp-server",
  version: "1.4.2",
  integrity: `sha256:${"a".repeat(64)}`,
  evidence: "acme-scan-001",
};

function studioWithCustomCandidate(): Window {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(model);
  window.document.write(html);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  const set = (id: string, value: string) => {
    const input = window.document.getElementById(id) as unknown as { value: string } | null;
    if (input === null) throw new Error(`expected #${id}`);
    input.value = value;
  };
  set("custom-id", CANDIDATE.id);
  set("custom-owner", CANDIDATE.owner);
  set("custom-package", CANDIDATE.pkg);
  set("custom-version", CANDIDATE.version);
  set("custom-integrity", CANDIDATE.integrity);
  set("custom-evidence", CANDIDATE.evidence);
  window.document
    .getElementById("custom-form")
    ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  return window;
}

function customRowsText(window: Window): string {
  const container = window.document.getElementById("custom-rows");
  if (container === null) throw new Error("workbench renders no custom rows");
  return container.textContent ?? "";
}

describe("policy studio custom candidate next action", () => {
  // Recorded product failure 7: a custom addition dead-ended. It was accepted,
  // shown as blocked, and then the administrator had nothing to do next.
  it("gives a pinned custom candidate an exact next command", () => {
    const window = studioWithCustomCandidate();
    const text = customRowsText(window);
    expect(text, "the row still exists").toContain(CANDIDATE.id);
    expect(text).toContain("aih trust scan");
  });

  it("binds the next command to the candidate's own pinned identity", () => {
    const text = customRowsText(studioWithCustomCandidate());
    expect(text, "package").toContain(CANDIDATE.pkg);
    expect(text, "version").toContain(CANDIDATE.version);
    expect(text, "integrity").toContain(CANDIDATE.integrity);
    expect(text, "accountable owner").toContain(CANDIDATE.owner);
  });

  it("makes the pinned npm tarball itself the exact scan target", () => {
    const text = customRowsText(studioWithCustomCandidate());
    expect(text).toContain(`aih trust scan ${CANDIDATE.pkg}@${CANDIDATE.version}`);
    expect(text).toContain(CANDIDATE.integrity);
    expect(text).toContain(CANDIDATE.evidence);
    expect(text).not.toMatch(/<local path or owner\/repo/);
  });

  it("names evidence owed at this pin instead of an unsupported-forever status", () => {
    const text = customRowsText(studioWithCustomCandidate());
    expect(text).toContain("Blocked - evidence owed at this pin");
    expect(text).not.toContain("Blocked - no supported projector/scanning/evidence");
  });

  it("names the fenced prerequisite that keeps it blocked, using a real code", () => {
    const text = customRowsText(studioWithCustomCandidate());
    const named = model.findings.fenced.filter((code) => text.includes(code));
    expect(named.length, `expected a fenced code from ${model.findings.fenced.join(", ")}`).toBe(1);
    expect(named[0]).toBe("mandatory-detector-failed");
  });

  // The next action is instruction, never activation: the ownership fence is
  // unchanged by telling the administrator what to run.
  it("adds no activation affordance to the custom row", () => {
    const window = studioWithCustomCandidate();
    const container = window.document.getElementById("custom-rows");
    expect(container?.querySelector("[data-reviewed]")).toBeFalsy();
    expect(customRowsText(window)).toContain("Blocked");
  });

  it("labels each import blast radius and visually associates matching preflight evidence", async () => {
    const window = studioWithCustomCandidate();
    const document = window.document;
    expect(document.getElementById("import-policy")?.textContent).toContain("replaces current");
    expect(document.getElementById("import-evidence")?.textContent).toContain("inspection only");

    const input = document.getElementById("evidence-file");
    if (input === null) throw new Error("expected evidence import input");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [
        new window.File(
          [JSON.stringify({ evidence: [{ id: CANDIDATE.evidence, state: "verified" }] })],
          "preflight-evidence.json",
          { type: "application/json" },
        ),
      ],
    });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (document.querySelectorAll(`[data-evidence-record="${CANDIDATE.evidence}"]`).length === 2)
        break;
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }

    const associated = document.querySelectorAll(`[data-evidence-record="${CANDIDATE.evidence}"]`);
    expect(associated).toHaveLength(2);
    for (const row of associated) {
      expect(row.classList.contains("evidence-linked")).toBe(true);
      expect(row.getAttribute("data-evidence-association")).toBeTruthy();
      expect(row.getAttribute("aria-label")).toContain("not verified or effective");
    }
  });
});
