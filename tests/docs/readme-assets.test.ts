import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function htmlAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(/([A-Za-z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    attributes.set(match[1]?.toLowerCase() ?? "", match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function imageAlt(markdown: string, assetPath: string): string {
  for (const match of markdown.matchAll(/<img\b[^>]*>/giu)) {
    const attributes = htmlAttributes(match[0]);
    if (attributes.get("src") === assetPath) return attributes.get("alt") ?? "";
  }

  const md = new RegExp(`!\\[([^\\]]+)\\]\\(${escapeRegExp(assetPath)}\\)`, "u").exec(markdown);
  return md?.[1] ?? "";
}

describe("README docs currency", () => {
  it("keeps README image metadata aligned with the current v2.4 assets", () => {
    const readme = read("README.md");
    const overview = read("docs/assets/aih-overview.svg");
    const normalizedOverview = overview.replace(/\s+/g, " ");

    expect(existsSync(join(root, "docs/assets/aih-overview.svg"))).toBe(true);
    expect(existsSync(join(root, "docs/assets/aih-report-v9.png"))).toBe(true);
    expect(overview).toContain("v2.4.0 release-candidate overview");
    expect(overview).toContain("Five governed-readiness pillars");
    expect(overview).toContain("42 commands");
    expect(normalizedOverview).toContain("aih truth pack · verify · docs-lint claim gate");
    expect(overview).toContain("Claim-ledger entries &amp; project-truth assertions");
    expect(overview).toContain("SHA-bound sidecar · staged pack · drift gate");
    expect(overview).not.toContain("staged &amp; signed");
    expect(overview).not.toContain("AI-Canonical · now");

    const overviewAlt = imageAlt(readme, "docs/assets/aih-overview.svg").toLowerCase();
    expect(overviewAlt).toContain("v2.4.0");
    expect(overviewAlt).toContain("release-candidate");
    expect(overviewAlt).toContain("governed-readiness");
    expect(overviewAlt).toContain("truth verify");
    expect(overviewAlt).toContain("docs-lint claim gate");

    const reportAlt = imageAlt(readme, "docs/assets/aih-report-v9.png").toLowerCase();
    expect(reportAlt).toContain("demo showcase data");
    expect(reportAlt).toContain("harness-wiring score");
    expect(reportAlt).toContain("remediation ledger");
  });

  it("keeps the README and command docs aligned with the contract command surface", () => {
    const readme = read("README.md");
    const commandsDoc = read("docs/commands.md");
    const surface = JSON.parse(read("tests/contract/command-surface.json")) as {
      commands: Array<{ name: string }>;
    };
    const expected = surface.commands.map((command) => command.name).sort();
    const readmeRows = [
      ...readme.matchAll(/^\| \[`aih ([a-z0-9-]+)`\]\(docs\/commands\.md#aih-([a-z0-9-]+)\) \|/gmu),
    ].map((match) => [match[1] ?? "", match[2] ?? ""] as const);
    const readmeCommands = readmeRows.map(([label]) => label);
    const docSections = [...commandsDoc.matchAll(/^## aih ([a-z0-9-]+)$/gmu)].map(
      (match) => match[1] ?? "",
    );

    expect(readmeRows.every(([label, anchor]) => label === anchor)).toBe(true);
    expect([...new Set(readmeCommands)].sort()).toEqual(expected);
    expect([...new Set(docSections)].sort()).toEqual(expected);
  });
});
