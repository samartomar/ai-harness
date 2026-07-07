import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { command, docsLintChecks, loadDocsLintRules } from "../../src/docs-lint/index.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-docs-lint-"));
  roots.push(root);
  return root;
}

function ctx(root = tempRoot(), overrides: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    ...overrides,
  };
}

describe("docs-lint", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("loads BetterDoc phrase rules from slop-lint.md", () => {
    const rules = loadDocsLintRules(process.cwd());

    expect(rules?.source).toBe("packs/docs-quality/betterdoc/references/slop-lint.md");
    expect(rules?.phrases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phrase: "Here's the thing", label: "throat-clearing phrase" }),
        expect.objectContaining({ phrase: "robust", label: "business jargon" }),
        expect.objectContaining({ phrase: "What if", label: "rhetorical setup" }),
      ]),
    );
  });

  it("emits coded findings and a non-zero report for blocked docs", async () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "README.md"),
      [
        "Here's the thing: this robust platform unlocks value.",
        "Every team needs this.",
        "> [!NOTE]",
        "> This is production-ready.",
      ].join("\n"),
    );
    const c = ctx(root);

    const checks = docsLintChecks(c);
    expect(checks.map((check) => check.code)).toEqual(
      expect.arrayContaining([
        "docs.banned-phrase",
        "docs.vague-absolute",
        "docs.unsupported-callout-claim",
      ]),
    );
    expect(checks.find((check) => check.code === "docs.banned-phrase")?.location).toEqual({
      uri: "README.md",
      startLine: 1,
    });

    const result = await executePlan(await command.plan(c), c);
    expect(result.report?.exitCode()).toBe(1);
  });

  it("ignores fenced Markdown examples", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "README.md"),
      ["```md", "Here's the thing: this robust platform unlocks value.", "```"].join("\n"),
    );

    expect(docsLintChecks(ctx(root))).toEqual([
      expect.objectContaining({ verdict: "pass", detail: expect.stringContaining("scanned 1") }),
    ]);
  });

  it("scans docs but skips internal report specs by default", () => {
    const root = tempRoot();
    mkdirSync(join(root, "docs", "specs"), { recursive: true });
    writeFileSync(join(root, "README.md"), "Plain setup notes.\n");
    writeFileSync(join(root, "docs", "guide.md"), "This robust claim should be grounded.\n");
    writeFileSync(join(root, "docs", "specs", "scratch.md"), "Clearly a draft spec.\n");

    const checks = docsLintChecks(ctx(root));

    expect(checks.map((check) => check.location?.uri)).toContain("docs/guide.md");
    expect(checks.map((check) => check.location?.uri)).not.toContain("docs/specs/scratch.md");
  });
});
