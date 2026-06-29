import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type LanguageCoverageRow,
  renderLanguageCoverageMarkdown,
  runLanguageCoverageBenchmark,
} from "../../src/profile/language-coverage.js";

function rows(): LanguageCoverageRow[] {
  return runLanguageCoverageBenchmark();
}

function rowById(id: string): LanguageCoverageRow {
  const row = rows().find((candidate) => candidate.id === id);
  if (!row) throw new Error(`missing coverage row: ${id}`);
  return row;
}

describe("language coverage benchmark", () => {
  it("renders a deterministic checked-in matrix", () => {
    const rendered = renderLanguageCoverageMarkdown(rows());
    expect(rendered).toBe(renderLanguageCoverageMarkdown(rows()));
    expect(readFileSync(join(process.cwd(), "docs/coverage/language-coverage.md"), "utf8")).toBe(
      rendered,
    );
  });

  it("locks the covered Node/TypeScript daily stack as a regression baseline", () => {
    const node = rowById("node-typescript-daily-stack");

    expect(node.role).toBe("lock");
    expect(node.grades.languages).toBe("good");
    expect(node.grades.frameworks).toBe("good");
    expect(node.grades.test).toBe("good");
    expect(node.grades.build).toBe("good");
    expect(node.grades.lint).toBe("good");
    expect(node.grades.db).toBe("good");
    expect(node.grades.packageManager).toBe("good");
    expect(node.note).toContain("do not enhance");
    expect(node.note).toContain("CDK verbs");
  });

  it("seeds the Wave-2 gaps without changing the covered Node stack", () => {
    const python = rowById("python-pyproject");
    const rust = rowById("rust-cargo");
    const polyglot = rowById("node-python-rust-polyglot");

    expect(python.role).toBe("wave-2-target");
    expect(python.grades.languages).toBe("good");
    expect(python.grades.test).toBe("good");
    expect(python.grades.lint).toBe("good");
    expect(python.grades.packageManager).toBe("none");
    expect(python.note).toContain("root package.json");

    expect(rust.grades.test).toBe("good");
    expect(rust.grades.build).toBe("good");
    expect(rust.grades.lint).toBe("none");

    expect(polyglot.grades.languages).toBe("good");
    expect(polyglot.grades.test).toBe("partial");
    expect(polyglot.grades.build).toBe("partial");
    expect(polyglot.grades.workspace).toBe("none");
    expect(polyglot.note).toContain("per-workspace commands");
  });

  it("does not mark missing non-Node package/build metadata as covered", () => {
    expect(rowById("rust-cargo").grades.packageManager).toBe("none");
    expect(rowById("go-module").grades.packageManager).toBe("none");
    expect(rowById("java-maven").grades.packageManager).toBe("none");
    expect(rowById("dotnet").grades.packageManager).toBe("none");
    expect(rowById("node-python-rust-polyglot").grades.packageManager).toBe("none");
  });
});
