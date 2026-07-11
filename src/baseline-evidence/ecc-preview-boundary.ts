import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parse } from "acorn";
import type { EccInstallPreviewArtifact } from "../ecc/install-preview.js";
import { generateEccInstallPreviewArtifact } from "../ecc/install-preview-generate.js";
import { validateEccInstallPreviewArtifact } from "../ecc/install-preview-validate.js";
import type { BaselineCatalog } from "./catalog.js";
import { hashComponentTree } from "./hash.js";
import type { BaselineSourceEvidence } from "./schema.js";

const GENERATOR_ENTRY_PATHS = [
  "package.json",
  "scripts/lib/install-executor.js",
  "scripts/lib/install-manifests.js",
  "scripts/lib/install-targets/registry.js",
] as const;

export interface EccPreviewBoundaryDeps {
  generate?: typeof generateEccInstallPreviewArtifact;
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function isCovered(path: string, coveredPaths: readonly string[]): boolean {
  return coveredPaths.some((covered) => path === covered || path.startsWith(`${covered}/`));
}

function resolveRelativeModule(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  const candidates = [base, `${base}.js`, `${base}.json`, resolve(base, "index.js")];
  const found = candidates.find((candidate) => {
    if (!existsSync(candidate)) return false;
    const stats = lstatSync(candidate);
    return stats.isFile() || stats.isSymbolicLink();
  });
  if (found === undefined)
    throw new Error(`could not resolve preview generator dependency ${specifier}`);
  return found;
}

const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function checkedModuleSpecifier(path: string, form: string, argument: unknown): string | undefined {
  const specifier =
    isAstNode(argument) && argument.type === "Literal" && typeof argument.value === "string"
      ? argument.value
      : undefined;
  if (specifier === undefined) {
    throw new Error(`dynamic ${form} is forbidden in preview generator dependency ${path}`);
  }
  if (specifier.startsWith(".")) return specifier;
  if (NODE_BUILTINS.has(specifier)) return undefined;
  throw new Error(
    `unvetted package import ${JSON.stringify(specifier)} is forbidden in preview generator dependency ${path}`,
  );
}

type AstNode = Record<string, unknown> & { type: string };

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string"
  );
}

function namedNode(node: unknown, type: string, name: string): boolean {
  return isAstNode(node) && node.type === type && node.name === name;
}

function requireResolveCall(callee: AstNode): boolean {
  if (callee.type !== "MemberExpression" || !namedNode(callee.object, "Identifier", "require")) {
    return false;
  }
  return (
    namedNode(callee.property, "Identifier", "resolve") ||
    (isAstNode(callee.property) &&
      callee.property.type === "Literal" &&
      callee.property.value === "resolve")
  );
}

function literalDependencies(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  const dependencies: string[] = [];
  const visit = (value: unknown): void => {
    if (!isAstNode(value)) return;
    if (
      value.type === "ImportDeclaration" ||
      value.type === "ExportAllDeclaration" ||
      (value.type === "ExportNamedDeclaration" && value.source !== null)
    ) {
      const dependency = checkedModuleSpecifier(path, "import", value.source);
      if (dependency !== undefined) dependencies.push(dependency);
    }
    if (value.type === "ImportExpression") {
      const dependency = checkedModuleSpecifier(path, "import()", value.source);
      if (dependency !== undefined) dependencies.push(dependency);
    }
    if (value.type === "CallExpression") {
      let form: string | undefined;
      if (namedNode(value.callee, "Identifier", "require")) {
        form = "require";
      } else if (isAstNode(value.callee) && requireResolveCall(value.callee)) {
        form = "require.resolve";
      }
      if (form !== undefined) {
        const args = Array.isArray(value.arguments) ? value.arguments : [];
        const dependency = checkedModuleSpecifier(path, form, args[0]);
        if (dependency !== undefined) dependencies.push(dependency);
      }
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else {
        visit(child);
      }
    }
  };
  visit(ast);
  return dependencies;
}

export function assertPreviewGeneratorDependenciesCovered(
  eccRoot: string,
  coveredPaths: readonly string[],
): void {
  const root = realpathSync(eccRoot);
  const pending = GENERATOR_ENTRY_PATHS.map((path) => resolve(root, path));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const absolute = pending.pop();
    if (absolute === undefined || visited.has(absolute)) continue;
    visited.add(absolute);
    const fromRoot = toPosix(relative(root, absolute));
    if (fromRoot.startsWith("../") || isAbsolute(fromRoot) || !isCovered(fromRoot, coveredPaths)) {
      throw new Error(`preview generator dependency is outside runtime:ecc-installer: ${fromRoot}`);
    }
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`preview generator dependency is not a regular file: ${fromRoot}`);
    }
    if (!absolute.endsWith(".js")) continue;
    for (const dependency of literalDependencies(absolute)) {
      pending.push(resolveRelativeModule(absolute, dependency));
    }
  }
}

export function generateAuthorizedEccInstallPreview(
  input: {
    eccRoot: string;
    catalog: BaselineCatalog;
    evidence: BaselineSourceEvidence;
  },
  deps: EccPreviewBoundaryDeps = {},
): EccInstallPreviewArtifact {
  const catalogRuntime = input.catalog.components.find(
    (entry) => entry.id === "runtime:ecc-installer",
  );
  const evidenceRuntime = input.evidence.components.find(
    (entry) => entry.id === "runtime:ecc-installer",
  );
  if (catalogRuntime === undefined || evidenceRuntime === undefined) {
    throw new Error("runtime:ecc-installer evidence is required before preview generation");
  }
  if (evidenceRuntime.verdict !== "pass") {
    throw new Error("runtime:ecc-installer must pass before preview generation");
  }
  if (
    input.evidence.id !== input.catalog.id ||
    input.evidence.owner !== input.catalog.owner ||
    input.evidence.repo !== input.catalog.repo ||
    input.evidence.pinnedSha !== input.catalog.pinnedSha
  ) {
    throw new Error("runtime:ecc-installer evidence is not bound to the active catalog pin");
  }
  if (JSON.stringify(evidenceRuntime.paths) !== JSON.stringify(catalogRuntime.paths)) {
    throw new Error("runtime:ecc-installer evidence paths do not match the catalog");
  }
  const before = hashComponentTree(input.eccRoot, catalogRuntime.paths).treeSha256;
  if (before !== evidenceRuntime.treeSha256) {
    throw new Error("runtime:ecc-installer changed after vet; preview generation refused");
  }
  assertPreviewGeneratorDependenciesCovered(input.eccRoot, catalogRuntime.paths);
  const generate = deps.generate ?? generateEccInstallPreviewArtifact;
  let artifact: EccInstallPreviewArtifact | undefined;
  let generationFailed = false;
  let generationError: unknown;
  try {
    artifact = generate(input.eccRoot, input.catalog.pinnedSha);
  } catch (error) {
    generationFailed = true;
    generationError = error;
  }
  const after = hashComponentTree(input.eccRoot, catalogRuntime.paths).treeSha256;
  if (after !== before) {
    throw new Error("runtime:ecc-installer changed during preview generation");
  }
  if (generationFailed) throw generationError;
  if (artifact === undefined) throw new Error("ECC install preview generator returned no artifact");
  validateEccInstallPreviewArtifact(input.eccRoot, input.catalog, artifact);
  return artifact;
}
