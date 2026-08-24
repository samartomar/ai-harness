import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkRepositoryPackedMarkdownLinks,
  inspectPackedMarkdownLinks,
} from "../../src/internals/check-packed-doc-links.js";

const roots: string[] = [];

function fixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "aih-packed-doc-links-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents, "utf8");
  }
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("packed Markdown link inspection", () => {
  it("accepts packaged files, directories, images, absolute URLs, and exact fragments", () => {
    const root = fixture({
      "README.md": [
        "# Local heading",
        "",
        "[commands](docs/commands.md#aih-policy)",
        "[guides](guides/)",
        "![diagram](docs/assets/diagram.svg)",
        "[web](https://github.com/samartomar/ai-harness)",
        "[mail](mailto:security@example.invalid)",
        "[same document](#local-heading)",
        "[reference][commands]",
        "",
        "[commands]: docs/commands.md#aih-policy",
      ].join("\n"),
      "docs/commands.md": "# Commands\n\n## aih policy\n",
      "docs/assets/diagram.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
      "guides/README.md": "# Guides\n",
    });
    const files = ["README.md", "docs/commands.md", "docs/assets/diagram.svg", "guides/README.md"];

    expect(inspectPackedMarkdownLinks(root, files)).toEqual([]);
  });

  it("reports unresolved files, directories, and Markdown fragments deterministically", () => {
    const root = fixture({
      "README.md": [
        "# Readme",
        "",
        "[missing](docs/missing.md)",
        "[missing directory](missing-guides/)",
        "[missing fragment](docs/commands.md#not-a-command)",
      ].join("\n"),
      "docs/commands.md": "# Commands\n\n## aih policy\n",
    });

    expect(inspectPackedMarkdownLinks(root, ["README.md", "docs/commands.md"])).toEqual([
      {
        source: "README.md",
        target: "docs/commands.md#not-a-command",
        reason: "missing-fragment",
      },
      { source: "README.md", target: "docs/missing.md", reason: "missing-file" },
      { source: "README.md", target: "missing-guides/", reason: "missing-directory" },
    ]);
  });

  it("rejects traversal, host-absolute paths, and malformed percent escapes", () => {
    const root = fixture({
      "README.md": [
        "# Readme",
        "",
        "[traversal](../outside.md)",
        "[root](/outside.md)",
        "[drive](C:/outside.md)",
        "[backslash](..\\outside.md)",
        "[encoded root](%2Foutside.md)",
        "[malformed](docs/%GG.md)",
      ].join("\n"),
    });

    expect(inspectPackedMarkdownLinks(root, ["README.md"])).toEqual([
      { source: "README.md", target: "../outside.md", reason: "unsafe-path" },
      { source: "README.md", target: "..\\outside.md", reason: "unsafe-path" },
      { source: "README.md", target: "/outside.md", reason: "unsafe-path" },
      { source: "README.md", target: "%2Foutside.md", reason: "unsafe-path" },
      { source: "README.md", target: "C:/outside.md", reason: "unsafe-path" },
      { source: "README.md", target: "docs/%GG.md", reason: "unsafe-path" },
    ]);
  });

  it("ignores fenced examples and resolves explicit anchors and duplicate heading slugs", () => {
    const root = fixture({
      "README.md": [
        "# Readme",
        "",
        "```md",
        "[example only](not-packed.md)",
        "```",
        "",
        "[named anchor](docs/commands.md#named-command)",
        "[duplicate heading](docs/commands.md#command-1)",
        "[formatted heading](docs/commands.md#formatted-command)",
        "[hostile-looking heading](docs/commands.md#safe)",
      ].join("\n"),
      "docs/commands.md": [
        "# Commands",
        "",
        '<a id="named-command"></a>',
        "## Command",
        "## Command",
        "## <em>Formatted</em> command",
        "## <<script>Safe</script>",
      ].join("\n"),
    });

    expect(inspectPackedMarkdownLinks(root, ["README.md", "docs/commands.md"])).toEqual([]);
  });

  it("rejects unsafe paths in the package manifest", () => {
    const root = fixture({ "README.md": "# Readme\n" });

    expect(() => inspectPackedMarkdownLinks(root, ["../README.md"])).toThrow(
      'packed documentation check failed: unsafe package path "../README.md"',
    );
  });

  it("checks the real npm manifest for a disposable package and fails broken packed links", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const root = fixture({
      "package.json": `${JSON.stringify({ name: "packed-doc-links-fixture", version: "1.0.0" })}\n`,
      "README.md": "# Fixture\n\n[commands](docs/commands.md)\n",
      "docs/commands.md": "# Commands\n",
    });

    expect(() => checkRepositoryPackedMarkdownLinks(root)).not.toThrow();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"status":"PASS"'));

    writeFileSync(join(root, "README.md"), "# Fixture\n\n[missing](missing.md)\n", "utf8");
    expect(() => checkRepositoryPackedMarkdownLinks(root)).toThrow(
      "packed documentation check failed: 1 unresolved packed Markdown link(s)",
    );
    expect(stderr).toHaveBeenCalledWith("README.md: missing-file: missing.md\n");
  });

  it("keeps a disposable installed-package proof in the full verification gate", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["verify:packed-admin-docs"]).toBe(
      "tsx tools/verify-packed-administrator-docs.mjs",
    );
    expect(pkg.scripts?.verify).toContain(
      "npm run build && npm run check:published-bin && npm run check:published-library && npm run verify:packed-admin-docs",
    );

    const proof = readFileSync("tools/verify-packed-administrator-docs.mjs", "utf8");
    expect(proof).toContain('resolve(consumer, "node_modules", "@aihq", "harness")');
    expect(proof).toContain("inspectPackedMarkdownLinks(installed, packageFiles)");
    expect(proof).toContain('args: ["policy", "lifecycle", "npm-package", "--help"]');
    expect(proof).toContain('args: ["policy", "lifecycle", "upstream-artifact", "--help"]');
    expect(proof).toContain('args: ["report", "--help"]');
    expect(proof).toContain("packed-admin-docs-help:");
  });
});
