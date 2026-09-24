import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { moduleSpecifiers, sourceFiles } from "./module-specifiers.js";

/**
 * C3: framework plugin sources import Core ONLY through `@aihq/core/framework-host`,
 * plus Node built-ins (`node:*`) and their own files. Anything else — a Core
 * internal path, another package, a bare built-in name — fails here.
 */

const repo = resolve(import.meta.dirname, "..", "..");
const packagesDir = join(repo, "packages");

function pluginSourceRoots(): string[] {
  return readdirSync(packagesDir)
    .map((name) => join(packagesDir, name, "src"))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}

function violations(root: string): string[] {
  const problems: string[] = [];
  for (const file of sourceFiles(root)) {
    for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier === "@aihq/core/framework-host" || specifier.startsWith("node:")) continue;
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const target = resolve(dirname(file), specifier);
        if (target === root || target.startsWith(root + sep)) continue;
      }
      problems.push(`${relative(repo, file).split(sep).join("/")}: ${specifier}`);
    }
  }
  return problems;
}

describe("framework plugin import boundary (C3)", () => {
  it("finds the plugin packages this boundary guards", () => {
    expect(pluginSourceRoots().map((root) => relative(packagesDir, root).split(sep)[0])).toContain(
      "framework-superpowers",
    );
  });

  it.each(pluginSourceRoots().map((root) => [relative(repo, root).split(sep).join("/"), root]))(
    "%s imports only @aihq/core/framework-host, node:* and its own files",
    (_label, root) => {
      expect(violations(root)).toEqual([]);
    },
  );

  it("recognises every way a file can name a module", () => {
    const code = [
      'import { a } from "@aihq/core/framework-host";',
      'import type { B } from "../../../src/internals/plan.js";',
      'export { c } from "zod";',
      'export * from "./own.js";',
      'const d = await import("@aihq/core");',
      'const e = require("fs");',
      'type F = import("@aihq/catalog").X;',
    ].join("\n");
    expect(moduleSpecifiers(code)).toEqual([
      "@aihq/core/framework-host",
      "../../../src/internals/plan.js",
      "zod",
      "./own.js",
      "@aihq/core",
      "fs",
      "@aihq/catalog",
    ]);
  });
});
