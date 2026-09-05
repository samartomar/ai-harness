import { type HTMLButtonElement, type HTMLInputElement, Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
  workbenchSelectionCounts,
} from "../../src/org-policy/workbench/selection-engine.js";
import { tinyStudioModel } from "./studio-test-fixture.js";

const administrator = { kind: "administrator" } as const;

function requestFixture() {
  const model = tinyStudioModel();
  const asset = Object.values(model.workbenchBundle.assets).find(
    (item) => item.authoring.action === "record-request",
  );
  if (asset === undefined) throw new Error("expected prepared request asset");
  return { model, asset };
}

describe("#973 generic request intent", () => {
  it("records exact pinned intent without selecting, activating, or evaluating it", () => {
    const { model, asset } = requestFixture();
    const result = reduceWorkbenchAction(model.workbenchBundle, createWorkbenchState(), {
      type: "record-request",
      assetId: asset.id,
      origin: administrator,
    });
    expect(result.accepted).toBe(true);
    expect(result.state.requests[0]).toMatchObject({
      assetId: asset.id,
      sourceId: asset.sourceId,
      sourceRevisionId: asset.sourceRevisionId,
      contentDigest: asset.contentDigest,
      origin: administrator,
    });
    expect(workbenchSelectionCounts(model.workbenchBundle, result.state)).toMatchObject({
      requestCount: 1,
      selectedControlCount: 0,
      rootCount: 0,
    });
  });

  it("wires generic request control to count while effective remains unevaluated", () => {
    const { asset } = requestFixture();
    const window = new Window({ url: "http://localhost/" });
    const html = policyStudioHtml(tinyStudioModel());
    window.document.write(html);
    (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
      structuredClone;
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
    if (scripts.length === 0) throw new Error("expected generated workbench script");
    window.eval(scripts.join("\n"));
    const search = window.document.querySelector<HTMLInputElement>(
      "#framework-rows input[aria-label='Search catalog']",
    );
    if (search === null) throw new Error("expected generic catalog search");
    search.value = asset.id;
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    const button = window.document.querySelector<HTMLButtonElement>(
      `button[data-workbench-asset-id="${asset.id}"]`,
    );
    if (button === null) throw new Error("expected generic request control");
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(window.document.querySelector("#framework-rows .help")?.textContent).toContain(
      "1 requested",
    );
    expect(window.document.querySelector("#framework-rows .help")?.textContent).toContain(
      "effective: not evaluated",
    );
    window.close();
  });
});
