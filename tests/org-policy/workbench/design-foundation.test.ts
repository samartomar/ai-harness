import { describe, expect, it } from "vitest";
import { policyStudioHtml } from "../../../src/org-policy/studio-template.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

/**
 * P1 (design foundation, offline): the rendered studio HTML must carry the
 * compiled workbench CSS (tokens + Tailwind utilities, see
 * tools/build-workbench.mjs) inline, and the whole document must stay
 * offline-safe — no network URL in a link/script/@import/url(), and no
 * @font-face (system fonts only, per D2).
 */
describe("workbench design foundation (P1)", () => {
  const html = policyStudioHtml(tinyStudioModel());

  it("inlines the compiled workbench CSS", () => {
    expect(html).toContain('<style id="wb-styles">');
    expect(html).toContain("--wb-color-primary");
  });

  it("never references an http(s) URL in link/script/@import/url()", () => {
    const linkHrefs = [...html.matchAll(/<link[^>]*href="([^"]*)"/gi)].map(
      (match) => match[1] ?? "",
    );
    const scriptSrcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]*)"/gi)].map(
      (match) => match[1] ?? "",
    );
    // Scope @import / url() checks to <style> blocks only: the page also
    // inlines the workbench's own JS bundle, whose *code* can legitimately
    // contain the substring "url(" (e.g. building a URL string) without that
    // being a stylesheet or font reference.
    const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(
      (match) => match[1] ?? "",
    );
    const atImports = styleBlocks.flatMap((css) =>
      [...css.matchAll(/@import\s+url\(([^)]*)\)/gi)].map((match) => match[1] ?? ""),
    );
    const cssUrls = styleBlocks.flatMap((css) =>
      [...css.matchAll(/url\(([^)]*)\)/gi)].map((match) => match[1] ?? ""),
    );
    const networkPattern = /https?:\/\//i;
    for (const value of [...linkHrefs, ...scriptSrcs, ...atImports, ...cssUrls]) {
      expect(value).not.toMatch(networkPattern);
    }
  });

  it("never declares @font-face", () => {
    const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(
      (match) => match[1] ?? "",
    );
    for (const css of styleBlocks) expect(css).not.toMatch(/@font-face/i);
  });
});

describe("workbench icons", () => {
  it("returns inline SVG for a known glyph and fails closed on an unknown one", async () => {
    const { workbenchIcon } = await import("../../../src/org-policy/workbench/ui/icons.js");
    expect(workbenchIcon("search")).toMatch(/^<svg[^>]*aria-hidden="true"/);
    expect(() => workbenchIcon("no-such-icon")).toThrow("Unknown Workbench icon");
  });
});
