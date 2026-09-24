import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";

type Node = { type: string; [key: string]: unknown };

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

/** Every module specifier a file names: static, re-export, dynamic, require, and type imports. */
export function moduleSpecifiers(code: string): string[] {
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

/** Every TypeScript/JavaScript source file under `dir`, recursively. */
export function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(?:[cm]?ts|[cm]?js)$/.test(name) && !name.endsWith(".d.ts")) files.push(full);
  }
  return files;
}
