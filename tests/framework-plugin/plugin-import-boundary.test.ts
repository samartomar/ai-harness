import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

/**
 * C3: framework plugin sources import Core ONLY through `@aihq/core/framework-host`,
 * plus Node built-ins (`node:*`) and their own files. Anything else — a Core
 * internal path, another package, a bare built-in name — fails here.
 */

const repo = resolve(import.meta.dirname, "..", "..");
const packagesDir = join(repo, "packages");

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(?:[cm]?ts|[cm]?js)$/.test(name)) files.push(full);
  }
  return files;
}

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

type Node = { type: string; [key: string]: unknown };

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

/** Every module specifier a file names: static, re-export, dynamic, require, and type imports. */
function moduleSpecifiers(code: string): string[] {
  const ast = parse(code, { sourceType: "module", plugins: ["typescript"] });
  const found: string[] = [];
  const literal = (value: unknown): string | undefined =>
    isNode(value) && value.type === "StringLiteral" ? (value.value as string) : undefined;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isNode(value)) return;
    switch (value.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "ExportNamedDeclaration": {
        const source = literal(value.source);
        if (source !== undefined) found.push(source);
        break;
      }
      case "TSExternalModuleReference": {
        const source = literal(value.expression);
        if (source !== undefined) found.push(source);
        break;
      }
      case "TSImportType": {
        const source = literal(value.argument) ?? literal((value.argument as Node)?.literal);
        found.push(source ?? "<non-literal type import>");
        break;
      }
      case "CallExpression": {
        const callee = value.callee as Node;
        const isImport = callee.type === "Import";
        const isRequire = callee.type === "Identifier" && callee.name === "require";
        if (isImport || isRequire) {
          found.push(literal((value.arguments as unknown[])[0]) ?? "<non-literal dynamic import>");
        }
        break;
      }
      case "ImportExpression":
        found.push(literal(value.source) ?? "<non-literal dynamic import>");
        break;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "loc" && key !== "start" && key !== "end") visit(child);
    }
  };
  visit(ast.program);
  return found;
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
