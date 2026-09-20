import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TOOL = "tools/wb-fonts.mjs";
const MANIFEST = "src/org-policy/workbench/ui/proto/fonts/manifest.json";

function runTool(argument: string) {
  return execFileSync(process.execPath, [TOOL, argument], { encoding: "utf8" });
}

describe("vendored prototype fonts", () => {
  it("--verify exits 0 and prints fonts ok:", () => {
    const output = runTool("--verify");
    expect(output).toContain("fonts ok:");
  });

  it("--css emits font faces for all three families", () => {
    const css = runTool("--css");
    expect(css).toContain('font-family: "Inter"');
    expect(css).toContain('font-family: "JetBrains Mono"');
    expect(css).toContain('font-family: "Material Symbols Outlined"');
  });

  it("--css is fully self-contained with woff2 data URIs", () => {
    const css = runTool("--css");
    expect(css).not.toContain("http://");
    expect(css).not.toContain("https://");
    for (const match of css.matchAll(/url\([^)]*\)/g)) {
      expect(match[0].startsWith("url(data:font/woff2;base64,")).toBe(true);
    }
  });

  // Every prototype icon is a <span class="material-symbols-outlined">name</span>;
  // without Google's own class rule the ligature never forms and the word shows.
  it("--css carries Google's verbatim .material-symbols-outlined class rule", () => {
    const css = runTool("--css");
    expect(css).toContain(".material-symbols-outlined {");
    expect(css).toContain("font-family: 'Material Symbols Outlined';");
    expect(css).toContain("-webkit-font-feature-settings: 'liga';");
  });

  // Narrower axis ranges redraw the icons: optical sizing is automatic, so a
  // pinned opsz would ignore each icon's font-size.
  it("manifest axes equal the ranges the prototype asks Google for", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    expect(manifest.axes).toEqual({
      opsz: "20..48",
      wght: "100..700",
      FILL: "0..1",
      GRAD: "-50..200",
    });
  });

  it("manifest totalBytes stays below 900000", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    expect(manifest.totalBytes).toBeLessThan(900000);
  });
});
