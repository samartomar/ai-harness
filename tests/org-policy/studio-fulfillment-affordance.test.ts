import { type HTMLButtonElement, type HTMLElement, type HTMLInputElement, Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";
import { tinyStudioModel } from "./studio-test-fixture.js";

const openWindows = new Set<Window>();

function studio(): Window {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(tinyStudioModel());
  window.document.write(html);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  openWindows.add(window);
  return window;
}

afterEach(async () => {
  await Promise.all([...openWindows].map((window) => window.happyDOM.close()));
  openWindows.clear();
});

describe("generic Workbench fulfillment boundary", () => {
  it("records a pinned request and exposes prepared metadata without claiming target fulfillment", () => {
    const model = tinyStudioModel();
    const requestAsset = Object.values(model.workbenchBundle.assets).find(
      (asset) => asset.authoring.action === "record-request",
    );
    if (requestAsset === undefined) throw new Error("expected prepared request asset");
    const window = studio();
    const search = window.document.querySelector<HTMLInputElement>(
      "#framework-rows input[aria-label='Search catalog']",
    );
    if (search === null) throw new Error("expected generic catalog search");
    search.value = requestAsset.id;
    search.dispatchEvent(new window.Event("input", { bubbles: true }));

    const row = window.document.querySelector<HTMLElement>(
      `article[data-workbench-asset-id='${requestAsset.id}']`,
    );
    if (row === null) throw new Error("expected prepared request asset");
    expect(row.textContent).toContain("Status: Not in draft");
    expect(row.textContent).toContain("Report not attached");

    const request = row.querySelector<HTMLButtonElement>("button[data-workbench-asset-id]");
    if (request === null) throw new Error("expected generic request control");
    expect(request.textContent).toBe("Request review");
    request.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(row.textContent).toContain("Status: Pending request");

    expect(window.document.querySelector(".workbench-draft-counts")?.textContent).toBe(
      "Controls 0Selections 0Requests 1",
    );
    expect(
      window.document
        .querySelector<HTMLButtonElement>(`button[data-workbench-asset-id='${requestAsset.id}']`)
        ?.getAttribute("aria-pressed"),
    ).toBeNull();

    const expand = window.document.querySelector<HTMLButtonElement>(
      `button[data-workbench-expand-id='${requestAsset.id}']`,
    );
    if (expand === null) throw new Error("expected generic expand control");
    expand.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const details = window.document.querySelector<HTMLButtonElement>(
      `button[data-workbench-detail-id='${requestAsset.id}']`,
    );
    if (details === null) throw new Error("expected generic detail control");
    details.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(window.document.querySelector<HTMLElement>("[data-workbench-detail]")?.hidden).toBe(
      false,
    );
  });
});
