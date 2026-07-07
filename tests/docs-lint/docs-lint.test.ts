import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { command, docsLintChecks, loadDocsLintRules } from "../../src/docs-lint/index.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, missingToolRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-docs-lint-"));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, contents: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
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

  it("emits coded advisory findings without failing the report for prose guidance", async () => {
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

    const checks = await docsLintChecks(c);
    expect(checks.map((check) => check.code)).toEqual(
      expect.arrayContaining([
        "docs.banned-phrase",
        "docs.vague-absolute",
        "docs.unsupported-callout-claim",
      ]),
    );
    expect(checks.every((check) => check.verdict !== "fail")).toBe(true);
    expect(checks.find((check) => check.code === "docs.banned-phrase")?.location).toEqual({
      uri: "README.md",
      startLine: 1,
    });

    const result = await executePlan(await command.plan(c), c);
    expect(result.report?.exitCode()).toBe(0);
  });

  it("fails a README claim marker with no CM mapping", async () => {
    const root = tempRoot();
    write(root, "README.md", "Managed changes are dry-run first. <!-- aih:claim -->\n");
    write(
      root,
      "docs/CONTROL_MATRIX.md",
      [
        "# Control Matrix",
        "",
        "| ID | Public claim | Implementation seam | Regression proof |",
        "| --- | --- | --- | --- |",
        "| CM-01 | Managed changes are dry-run first. | `src/internals/execute.ts` | `tests/docs-lint/example.test.ts` (`covers the mapped claim`) |",
      ].join("\n"),
    );
    write(root, "tests/docs-lint/example.test.ts", 'it("covers the mapped claim", () => {});\n');

    const checks = await docsLintChecks(ctx(root));

    expect(checks).toContainEqual(
      expect.objectContaining({
        verdict: "fail",
        code: "docs.claim-mapping-missing",
        location: { uri: "README.md", startLine: 1 },
      }),
    );
  });

  it("fails a matrix row that cites a non-existent named test", async () => {
    const root = tempRoot();
    write(root, "README.md", "Managed changes are dry-run first. <!-- aih:claim CM-01 -->\n");
    write(
      root,
      "docs/CONTROL_MATRIX.md",
      [
        "# Control Matrix",
        "",
        "| ID | Public claim | Implementation seam | Regression proof |",
        "| --- | --- | --- | --- |",
        "| CM-01 | Managed changes are dry-run first. | `src/internals/execute.ts` | `tests/docs-lint/example.test.ts` (`missing named test`) |",
      ].join("\n"),
    );
    write(root, "tests/docs-lint/example.test.ts", 'it("covers the mapped claim", () => {});\n');

    const checks = await docsLintChecks(ctx(root));

    expect(checks).toContainEqual(
      expect.objectContaining({
        verdict: "fail",
        code: "docs.claim-test-missing",
        location: { uri: "docs/CONTROL_MATRIX.md", startLine: 5 },
      }),
    );
  });

  it("fails a matrix row that cites a test path outside the repo root", async () => {
    const root = tempRoot();
    write(root, "README.md", "Managed changes are dry-run first. <!-- aih:claim CM-01 -->\n");
    write(
      root,
      "docs/CONTROL_MATRIX.md",
      [
        "# Control Matrix",
        "",
        "| ID | Public claim | Implementation seam | Regression proof |",
        "| --- | --- | --- | --- |",
        "| CM-01 | Managed changes are dry-run first. | `src/internals/execute.ts` | `tests/../../outside.test.ts` (`covers the mapped claim`) |",
      ].join("\n"),
    );

    const checks = await docsLintChecks(ctx(root));

    expect(checks).toContainEqual(
      expect.objectContaining({
        verdict: "fail",
        code: "docs.claim-test-missing",
        detail: expect.stringContaining("outside the repo root"),
        location: { uri: "docs/CONTROL_MATRIX.md", startLine: 5 },
      }),
    );
  });

  it("fails a changed feature file when no docs or matrix file changed", async () => {
    const root = tempRoot();
    write(root, "README.md", "Managed changes are dry-run first. <!-- aih:claim CM-01 -->\n");
    write(
      root,
      "docs/CONTROL_MATRIX.md",
      [
        "# Control Matrix",
        "",
        "| ID | Public claim | Implementation seam | Regression proof |",
        "| --- | --- | --- | --- |",
        "| CM-01 | Managed changes are dry-run first. | `src/internals/execute.ts` | `tests/docs-lint/example.test.ts` (`covers the mapped claim`) |",
      ].join("\n"),
    );
    write(root, "tests/docs-lint/example.test.ts", 'it("covers the mapped claim", () => {});\n');
    const run = fakeRunner((argv) =>
      argv[0] === "git" && argv.includes("diff") ? { stdout: "src/trust/index.ts\n" } : undefined,
    );

    const checks = await docsLintChecks(ctx(root, { run }));

    expect(checks).toContainEqual(
      expect.objectContaining({
        verdict: "fail",
        code: "docs.feature-ledger-drift",
      }),
    );
  });

  it("fails closed when changed path detection cannot run", async () => {
    const root = tempRoot();
    write(root, "README.md", "Managed changes are dry-run first. <!-- aih:claim CM-01 -->\n");
    write(
      root,
      "docs/CONTROL_MATRIX.md",
      [
        "# Control Matrix",
        "",
        "| ID | Public claim | Implementation seam | Regression proof |",
        "| --- | --- | --- | --- |",
        "| CM-01 | Managed changes are dry-run first. | `src/internals/execute.ts` | `tests/docs-lint/example.test.ts` (`covers the mapped claim`) |",
      ].join("\n"),
    );
    write(root, "tests/docs-lint/example.test.ts", 'it("covers the mapped claim", () => {});\n');

    const checks = await docsLintChecks(ctx(root, { run: missingToolRunner }));

    expect(checks).toContainEqual(
      expect.objectContaining({
        verdict: "fail",
        code: "docs.feature-ledger-drift",
        detail: expect.stringContaining("failed closed"),
      }),
    );
  });

  it("fails closed when changed path detection exits non-zero", async () => {
    const root = tempRoot();
    write(root, "README.md", "Managed changes are dry-run first. <!-- aih:claim CM-01 -->\n");
    write(
      root,
      "docs/CONTROL_MATRIX.md",
      [
        "# Control Matrix",
        "",
        "| ID | Public claim | Implementation seam | Regression proof |",
        "| --- | --- | --- | --- |",
        "| CM-01 | Managed changes are dry-run first. | `src/internals/execute.ts` | `tests/docs-lint/example.test.ts` (`covers the mapped claim`) |",
      ].join("\n"),
    );
    write(root, "tests/docs-lint/example.test.ts", 'it("covers the mapped claim", () => {});\n');
    const run = fakeRunner((argv) =>
      argv[0] === "git" && argv.includes("diff")
        ? { code: 128, stderr: "fatal: ambiguous argument HEAD" }
        : undefined,
    );

    const checks = await docsLintChecks(ctx(root, { run }));

    expect(checks).toContainEqual(
      expect.objectContaining({
        verdict: "fail",
        code: "docs.feature-ledger-drift",
        detail: expect.stringContaining("failed closed"),
      }),
    );
  });

  it("ignores fenced Markdown examples", async () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "README.md"),
      ["```md", "Here's the thing: this robust platform unlocks value.", "```"].join("\n"),
    );

    expect(await docsLintChecks(ctx(root))).toEqual([
      expect.objectContaining({ verdict: "pass", detail: expect.stringContaining("scanned 1") }),
    ]);
  });

  it("ignores literal claim-marker syntax in inline code examples", async () => {
    const root = tempRoot();
    write(root, "README.md", "Use `<!-- aih:claim CM-xx -->` next to public claims.\n");

    expect(await docsLintChecks(ctx(root))).toEqual([
      expect.objectContaining({ verdict: "pass", detail: expect.stringContaining("scanned 1") }),
    ]);
  });

  it("scans docs but skips internal report specs by default", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "docs", "specs"), { recursive: true });
    writeFileSync(join(root, "README.md"), "Plain setup notes.\n");
    writeFileSync(join(root, "docs", "guide.md"), "This robust claim should be grounded.\n");
    writeFileSync(join(root, "docs", "specs", "scratch.md"), "Clearly a draft spec.\n");

    const checks = await docsLintChecks(ctx(root));

    expect(checks.map((check) => check.location?.uri)).toContain("docs/guide.md");
    expect(checks.map((check) => check.location?.uri)).not.toContain("docs/specs/scratch.md");
  });
});
