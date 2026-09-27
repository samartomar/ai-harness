import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { moduleSpecifiers } from "../framework-plugin/module-specifiers.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tools = join(repo, "tools");

function toolFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return toolFiles(path);
    return /\.(?:ts|mts|mjs)$/.test(name) ? [path] : [];
  });
}

/** A relative specifier resolves when its file exists, allowing the `.js` → `.ts` source mapping. */
function resolves(from: string, specifier: string): boolean {
  const target = resolve(dirname(from), specifier);
  return existsSync(target) || existsSync(target.replace(/\.js$/, ".ts"));
}

describe("repository tools", () => {
  it("import only modules that still exist", () => {
    const unresolved = toolFiles(tools).flatMap((file) =>
      moduleSpecifiers(readFileSync(file, "utf8"))
        .filter((specifier) => specifier.startsWith("."))
        .filter((specifier) => !resolves(file, specifier))
        .map((specifier) => `${relative(repo, file).replaceAll("\\", "/")} -> ${specifier}`),
    );
    expect(unresolved).toEqual([]);
  });
});
