import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { PlanContext } from "../internals/plan.js";
import type { Check, CheckCode } from "../internals/verify.js";

type DependencyNameCode = Extract<CheckCode, "trust.dependency-confusion" | "trust.typosquat">;

export const POPULAR_PACKAGES: readonly string[] = [
  "@types/node",
  "axios",
  "chalk",
  "commander",
  "debug",
  "dotenv",
  "esbuild",
  "eslint",
  "express",
  "lodash",
  "next",
  "react",
  "react-dom",
  "request",
  "requests",
  "typescript",
  "vite",
  "vitest",
  "yaml",
  "zod",
];

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".aih",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);
const DIRECT_DEP_BLOCKS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(
  code: DependencyNameCode,
  path: string,
  line: number,
  content: string,
): string {
  return `${code.replace(/\./g, "-")}:${path}:${line}:${contentHash(content).slice(0, 8)}`;
}

function linesOf(source: string): string[] {
  return source.split(/\r?\n/);
}

function lineText(source: string, line: number): string {
  return linesOf(source)[line - 1] ?? "";
}

function lineForDependency(source: string, name: string): number {
  const quoted = `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const found = linesOf(source).findIndex((line) => line.includes(quoted));
  return found >= 0 ? found + 1 : 1;
}

function dependencyCheck(
  code: DependencyNameCode,
  path: string,
  line: number,
  lineTextValue: string,
  detail: string,
): Check {
  return {
    name: code,
    verdict: "fail",
    detail: `${path}:${line} — ${detail}`,
    code,
    location: { uri: path, startLine: line },
    fingerprint: fingerprint(code, path, line, lineTextValue),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectPackageJson(root: string): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      if (abs !== root && SKIP_DIRS.has(basename(abs))) return;
      for (const entry of readdirSync(abs)) visit(join(abs, entry));
      return;
    }
    if (st.isFile() && basename(abs) === "package.json") out.push(abs);
  };
  visit(root);
  return out.sort((a, b) => toPosix(relative(root, a)).localeCompare(toPosix(relative(root, b))));
}

function directDependencyNames(pkg: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const blockName of DIRECT_DEP_BLOCKS) {
    const block = pkg[blockName];
    if (!isRecord(block)) continue;
    for (const name of Object.keys(block)) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function normalizeScope(scope: string): string | undefined {
  const trimmed = scope.trim();
  if (trimmed.length === 0) return undefined;
  const prefixed = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
  return prefixed.toLowerCase();
}

export function resolveInternalScopes(ctx: Pick<PlanContext, "env">): string[] {
  const raw = ctx.env.AIH_TRUST_INTERNAL_SCOPES ?? "";
  const scopes = new Set<string>();
  for (const part of raw.split(",")) {
    const normalized = normalizeScope(part);
    if (normalized !== undefined) scopes.add(normalized);
  }
  return [...scopes].sort((a, b) => a.localeCompare(b));
}

function scopeOfPackage(name: string): string | undefined {
  if (!name.startsWith("@")) return undefined;
  const slash = name.indexOf("/");
  if (slash <= 0) return undefined;
  return name.slice(0, slash).toLowerCase();
}

function unscopedPackageName(name: string): string | undefined {
  if (name.startsWith("@")) return undefined;
  return name.toLowerCase();
}

function isDamerauLevenshteinDistanceOne(left: string, right: string): boolean {
  if (left === right) return false;
  const lengthDelta = left.length - right.length;
  if (Math.abs(lengthDelta) > 1) return false;

  if (lengthDelta === 0) {
    const mismatches: number[] = [];
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) mismatches.push(index);
      if (mismatches.length > 2) return false;
    }
    if (mismatches.length === 1) return true;
    if (mismatches.length !== 2) return false;
    const [first, second] = mismatches;
    if (first === undefined || second === undefined || second !== first + 1) return false;
    return left[first] === right[second] && left[second] === right[first];
  }

  const longer = left.length > right.length ? left : right;
  const shorter = left.length > right.length ? right : left;
  let longerIndex = 0;
  let shorterIndex = 0;
  let edits = 0;
  while (longerIndex < longer.length && shorterIndex < shorter.length) {
    if (longer[longerIndex] === shorter[shorterIndex]) {
      longerIndex++;
      shorterIndex++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    longerIndex++;
  }
  return true;
}

function popularTypoTarget(name: string): string | undefined {
  const normalized = unscopedPackageName(name);
  if (normalized === undefined) return undefined;
  return POPULAR_PACKAGES.find((popular) =>
    isDamerauLevenshteinDistanceOne(normalized, popular.toLowerCase()),
  );
}

function scanPackageJson(
  rel: string,
  source: string,
  internalScopes: ReadonlySet<string>,
): Check[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];

  const checks: Check[] = [];
  for (const name of directDependencyNames(parsed)) {
    const line = lineForDependency(source, name);
    const text = lineText(source, line);
    const scope = scopeOfPackage(name);
    if (scope !== undefined && internalScopes.has(scope)) {
      checks.push(
        dependencyCheck(
          "trust.dependency-confusion",
          rel,
          line,
          text,
          `direct dependency ${name} uses configured internal scope ${scope}`,
        ),
      );
      continue;
    }

    const target = popularTypoTarget(name);
    if (target !== undefined) {
      checks.push(
        dependencyCheck(
          "trust.typosquat",
          rel,
          line,
          text,
          `direct dependency ${name} is Damerau-Levenshtein distance 1 from popular package ${target}`,
        ),
      );
    }
  }
  return checks;
}

export function scanTrustDependencyNames(root: string, internalScopes: readonly string[]): Check[] {
  const scopes = new Set(
    internalScopes.map((scope) => normalizeScope(scope)).filter((scope) => scope !== undefined),
  );
  const checks: Check[] = [];
  for (const abs of collectPackageJson(root)) {
    const rel = toPosix(relative(root, abs));
    checks.push(...scanPackageJson(rel, readFileSync(abs, "utf8"), scopes));
  }
  return checks;
}
