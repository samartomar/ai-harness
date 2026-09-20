import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(uiRoot, "..");
const ENGINE_ENTRY = "src/org-policy/workbench/engine/index";
const ALLOWED_PACKAGES = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@radix-ui/react-dialog",
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/u.test(entry.name) ? [path] : [];
  });
}

function specifiers(text: string): string[] {
  const found = text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)["']([^"']+)["']/gmu);
  return [...found].map((match) => match[1] as string);
}

/**
 * Source-level half of the boundary: the UI reaches policy behavior only
 * through the engine entry. The check on the real bundle arrives with the
 * engine boundary outcome.
 */
describe("workbench-ui import boundary", () => {
  const files = [...sourceFiles(join(uiRoot, "src")), join(uiRoot, "preview", "main.tsx")];

  it("finds the UI source", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [relative(repositoryRoot, file).replaceAll("\\", "/"), file]))(
    "%s imports only the engine entry, the UI itself, and allow-listed packages",
    (_label, file) => {
      const offenders = specifiers(readFileSync(file, "utf8")).filter((specifier) => {
        if (ALLOWED_PACKAGES.has(specifier)) return false;
        if (!specifier.startsWith(".")) return true;
        const target = relative(repositoryRoot, resolve(dirname(file), specifier)).replaceAll(
          "\\",
          "/",
        );
        if (target.startsWith("workbench-ui/")) return false;
        return target.replace(/\.(js|ts)$/u, "") !== ENGINE_ENTRY;
      });
      expect(offenders).toEqual([]);
    },
  );

  // Node types are visible to the UI type program until the engine boundary
  // outcome removes them, so Node globals are refused here instead.
  it.each(files.map((file) => [relative(repositoryRoot, file).replaceAll("\\", "/"), file]))(
    "%s uses no Node globals",
    (_label, file) => {
      const found = readFileSync(file, "utf8").match(
        /\b(?:process\.|Buffer\b|require\(|__dirname\b|__filename\b|globalThis\.process\b)/gu,
      );
      expect(found ?? []).toEqual([]);
    },
  );
});
