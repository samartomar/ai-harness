import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";
import { usageRecorderScript } from "../../src/usage/capture.js";

const model = policyStudioModel();

function hookRows(): { text: string; firstBadge: string } {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(model);
  window.document.write(html);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  const container = window.document.getElementById("hook-rows");
  if (container === null) throw new Error("workbench renders no hook rows");
  const first = container.querySelector(".row");
  return {
    text: container.textContent ?? "",
    firstBadge: first?.querySelector(".badge")?.textContent ?? "",
  };
}

describe("policy studio AIH hook transparency", () => {
  // Recorded product failure 5: the only thing the workbench said about an
  // AIH hook was "AIH-owned hook identity" - an administrator could not learn
  // when it fires, what it writes, or whether it can block their work.
  it("carries what each AIH hook does, not just that it exists", () => {
    expect(model.catalog.hooks.length).toBeGreaterThan(0);
    for (const hook of model.catalog.hooks) {
      expect(hook.id, "hook id").toBeTruthy();
      expect(hook.description.length, `${hook.id} description`).toBeGreaterThan(0);
      for (const field of ["trigger", "records", "artifact", "failureMode"] as const) {
        expect(hook.behaviour[field].length, `${hook.id} ${field}`).toBeGreaterThan(0);
      }
      expect(hook.control.source.scriptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  // The disclosure must describe the script that actually ships, or it is a
  // claim the artifact cannot honour.
  it("discloses only behaviour the shipped recorder actually implements", () => {
    const script = usageRecorderScript();
    const hook = model.catalog.hooks.find((item) => item.id === "usage-metering");
    if (hook === undefined) throw new Error("expected the usage-metering hook");
    expect(script).toContain(hook.behaviour.artifact);
    expect(script).toContain(hook.behaviour.trigger);
  });

  it("shows the disclosure on the hook row, with its pinned identity", () => {
    const { text, firstBadge } = hookRows();
    for (const hook of model.catalog.hooks) {
      expect(text, `${hook.id} description`).toContain(hook.description);
      expect(text, `${hook.id} trigger`).toContain(hook.behaviour.trigger);
      expect(text, `${hook.id} artifact`).toContain(hook.behaviour.artifact);
      expect(text, `${hook.id} failure mode`).toContain(hook.behaviour.failureMode);
      expect(text, `${hook.id} projector`).toContain(hook.control.projector);
      expect(text, `${hook.id} digest`).toContain(hook.control.source.scriptDigest);
      for (const target of hook.control.targets) {
        expect(text, `${hook.id} target ${target}`).toContain(target);
      }
    }
    // Row 14's invariant: the status badge stays the row's first .badge.
    expect(firstBadge).toBe("Disabled");
  });

  // Disclosure, not authoring: the ownership boundary is unchanged by this row.
  it("keeps custom hooks unauthorable while disclosing the AIH ones", () => {
    const html = policyStudioHtml(model);
    expect(html).toContain("Custom hooks are not supported.");
    expect(html).not.toContain("Add custom hook");
  });
});
