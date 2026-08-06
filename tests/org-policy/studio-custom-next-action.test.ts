import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const CANDIDATE = {
  id: "acme-mcp",
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
  });

  // aih trust scan takes a local path or a GitHub owner/repo. A registry
  // package identity is not a scan target, and emitting one as if it were
  // would hand the administrator a command that cannot run.
  it("does not present the registry package as a scan target", () => {
    const text = customRowsText(studioWithCustomCandidate());
    expect(text).not.toContain(`aih trust scan ${CANDIDATE.pkg}`);
    expect(text).toMatch(/path|owner\/repo/);
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
});
