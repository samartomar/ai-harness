import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

function style(): string {
  const html = policyStudioHtml(policyStudioModel());
  const match = html.match(/<style>([\s\S]*?)<\/style>/i);
  if (match?.[1] === undefined) throw new Error("expected portable Workbench styles");
  return match[1];
}

function studio(): Window {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(policyStudioModel());
  window.document.write(html);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  return window;
}

function element(window: Window, id: string) {
  const found = window.document.getElementById(id);
  if (!found) throw new Error(`expected #${id}`);
  return found;
}

function openDetail(window: Window, id: string) {
  const opener = [...window.document.querySelectorAll("[data-detail]")].find(
    (node) => node.getAttribute("data-detail") === id,
  );
  if (!opener) throw new Error(`expected detail opener for ${id}`);
  opener.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return element(window, "drawer");
}

function expectPureDrawer(drawer: ReturnType<typeof element>): void {
  expect(
    drawer.querySelector("#curation-editor, #custom-editor, #remote-custom-editor"),
  ).toBeNull();
  expect(
    drawer.querySelector(
      "[data-framework-select], [data-reviewed], [data-add-riders], form, input, select, textarea, [type=submit]",
    ),
  ).toBeNull();
  expect(drawer.querySelectorAll("[data-next-action]")).toHaveLength(1);
}

describe("Ledger Workbench identity", () => {
  it("uses paper, ink, flat rules, evidence colours, and bounded accessible motion", () => {
    const css = style();

    expect(css).toContain("--paper:#fcfcfa");
    expect(css).toContain("--ink:#16181d");
    expect(css).toContain("--rule:#d9dbd6");
    expect(css).toContain("--pass:#1a6b45");
    expect(css).toContain("--blocked:#a3232b");
    expect(css).toContain("--owed:#8a6d1c");
    expect(css).toContain("--target-control:32px");
    expect(css).toContain("--target-chip:24px");
    expect(css).toContain("--motion:120ms ease-out");
    expect(css).toContain("--type-caption:10px");
    expect(css).toContain("--type-meta:11px");
    expect(css).toContain("--type-body:13px");
    expect(css).toContain("--type-title:16px");
    expect(css).toContain("--type-masthead:20px");
    expect(css).toContain(".brand-name{font:700 var(--type-masthead)/1.2 var(--display)");
    expect(css).toContain(
      ".gcard{border:1px solid var(--rule);border-radius:6px;background:var(--surface)",
    );
    expect(css).toContain(".drawer{background:var(--surface);border-left:1px solid var(--rule)");
    expect(css).toContain(
      ".spot{width:min(100%,620px);border-radius:6px;border:1px solid var(--rule)",
    );
    expect(css).toContain(".sheet{position:fixed");
    expect(css).toContain("background:var(--surface);border-top:2px solid var(--ink)");
    expect(css).toContain("repeating-linear-gradient(45deg,var(--s-uns)");
    expect(css).toContain("overflow-wrap:anywhere");
    expect(css).toContain("@media(prefers-reduced-motion:reduce)");

    for (const declaration of css.matchAll(/transition:([^;}]+)/g)) {
      expect(declaration[1]).toContain("var(--motion)");
    }
    expect(css).not.toMatch(/font-size:\s*\d+(?:\.\d+)?px/);
    expect(css).not.toMatch(/font:[^;}]*\b\d+(?:\.\d+)?px(?:\/|(?=\s))/);

    expect(css).not.toContain("radial-gradient");
    expect(css).not.toContain("color-mix(");
    expect(css).not.toContain("var(--spring)");
    expect(css).not.toContain("backdrop-filter");
    expect(css).not.toContain("filter:blur");
    expect(css).not.toContain(".grain{");
    expect(css).not.toContain("--glass");
    expect(css).not.toContain("--blob");
    expect(css).not.toContain("#c2652a");
    expect(css).not.toContain("#a8541f");
    expect(css).not.toContain("#b4541f");
    expect(css).not.toContain("#fffcf7");
    expect(css).not.toContain("--cyan");
    expect(css).not.toContain("--amber");
    expect(css).not.toContain("--danger");
    expect(css).toContain('html[data-theme="dark"]');
    expect(css).toContain("color-scheme:dark");
    expect(css).toContain("--paper:#1d1f23;--surface:#25282d;--rule:#4b4e54");
  });

  it("keeps the inspector pure and retains the canonical selection rail on compact screens", () => {
    const window = studio();
    const drawer = window.document.getElementById("drawer");
    const authoring = window.document.getElementById("authoring-sidebar");
    const addCustom = window.document.getElementById("open-custom");

    expect(drawer?.getAttribute("aria-label")).toBe("Item detail");
    expect(
      drawer?.querySelector("#curation-editor, #custom-editor, #remote-custom-editor"),
    ).toBeNull();
    expect(
      authoring?.querySelector("#curation-editor, #custom-editor, #remote-custom-editor"),
    ).not.toBeNull();
    addCustom?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect((drawer as unknown as { hidden: boolean } | null)?.hidden).toBe(true);
    expect((authoring as unknown as { hidden: boolean } | null)?.hidden).toBe(false);
    expect(
      (window.document.getElementById("custom-editor") as unknown as { open: boolean } | null)
        ?.open,
    ).toBe(true);
    expect(style()).toContain(
      "@media(max-width:880px){.stage{grid-template-rows:auto auto auto minmax(0,1fr) auto}.bar{padding:8px;align-content:flex-start}.work{grid-template-columns:1fr}.rail{display:flex",
    );
    expect(style()).not.toContain(".rail{display:none}");
    window.close();
  });

  it("narrates state in the mutation-free inspector and routes its one next action elsewhere", () => {
    const window = studio();
    const model = policyStudioModel();
    const hookId = model.catalog.hooks[0]?.id;
    const framework = model.catalog.frameworks[0];
    const asset = framework?.assets[0];
    if (!hookId || !framework || !asset)
      throw new Error("expected baseline hook and framework asset");

    const hookDrawer = openDetail(window, hookId);
    expectPureDrawer(hookDrawer);
    expect(hookDrawer.textContent).toContain("Selected · Enforced");
    expect(hookDrawer.textContent).toContain("Effective count:");
    expect(
      [...hookDrawer.querySelectorAll(".kv span")].map((node) => node.textContent),
    ).not.toContain("Gate");
    expect(
      [...hookDrawer.querySelectorAll(".kv span")].map((node) => node.textContent),
    ).not.toContain("Requested");
    expect(hookDrawer.querySelector(".badges .ok, .note.ok")).toBeNull();

    const assetDrawer = openDetail(window, `${framework.id} / ${asset.kind}: ${asset.id}`);
    expectPureDrawer(assetDrawer);
    expect(assetDrawer.textContent).toContain("Selected · Evidence · Verdict · Materializes");
    expect(assetDrawer.textContent).toContain("Pinned provenance:");
    expect(assetDrawer.textContent).toMatch(/Vet (absent|[a-z]+)/);
    expect(assetDrawer.textContent).toContain("Effective count:");
    const assetChildren = [...(assetDrawer.querySelector("#drawer-detail")?.children ?? [])];
    const provenanceIndex = assetChildren.findIndex((node) =>
      node.textContent?.startsWith("Pinned provenance:"),
    );
    const journeyIndex = assetChildren.findIndex((node) => node.classList.contains("journey"));
    expect(provenanceIndex).toBeGreaterThanOrEqual(0);
    expect(provenanceIndex).toBeLessThan(journeyIndex);
    expect(
      [...assetDrawer.querySelectorAll(".kv span")].map((node) => node.textContent),
    ).not.toContain("Kind");
    expect(assetDrawer.querySelector(".badges .ok")).toBeNull();

    const blocked = model.catalog.frameworks
      .flatMap((entry) => entry.assets.map((candidate) => ({ framework: entry, asset: candidate })))
      .find((entry) => entry.asset.vet?.verdict === "blocked");
    if (!blocked?.asset.vet) throw new Error("expected a blocked pinned component");
    const blockedDrawer = openDetail(
      window,
      `${blocked.framework.id} / ${blocked.asset.kind}: ${blocked.asset.id}`,
    );
    const blockedText = blockedDrawer.textContent ?? "";
    for (const finding of blocked.asset.vet.findings) {
      expect(blockedText).toContain(finding.code);
      expect(blockedText).toContain(finding.detail);
      expect(blockedText).toContain(`count: ${finding.count ?? "not reported"}`);
    }

    element(window, "open-custom").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const values: Record<string, string> = {
      "custom-id": "ledger-probe",
      "custom-package": "ledger-probe",
      "custom-version": "1.0.0",
      "custom-integrity": `sha256:${"a".repeat(64)}`,
      "custom-evidence": "ledger-evidence",
    };
    for (const [id, value] of Object.entries(values)) {
      (element(window, id) as unknown as { value: string }).value = value;
    }
    element(window, "custom-form").dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
    const customDrawer = openDetail(window, "ledger-probe");
    expectPureDrawer(customDrawer);
    expect(customDrawer.textContent).toContain("Selected · Evidence · Verdict · Materializes");
    expect(customDrawer.textContent).toContain("Effective count: zero");
    expect(customDrawer.textContent).toContain("blocked");
    window.close();
  });
});
