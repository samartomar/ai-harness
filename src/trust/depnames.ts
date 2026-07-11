import { readFileSync } from "node:fs";
import { basename, relative } from "node:path";
import type { Posture } from "../config/posture.js";
import type { PlanContext } from "../internals/plan.js";
import type { Check, CheckCode } from "../internals/verify.js";
import { OrgPolicyError, readOrgPolicy } from "../org-policy/schema.js";
import { contentFindingFingerprint } from "./fingerprint.js";
import { gradeTrustCheck } from "./grade.js";
import type { TrustFileInventory } from "./inventory.js";
import { collectFilesUnder } from "./scan.js";

type DependencyCheckCode = Extract<
  CheckCode,
  "trust.dependency-confusion" | "trust.typosquat" | "trust.unpinned-dependency"
>;

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

const DIRECT_DEP_BLOCKS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const EXACT_VERSION = /^=?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

interface DirectDependencySpec {
  blockName: (typeof DIRECT_DEP_BLOCKS)[number];
  name: string;
  spec: string;
}

interface PackageScanResult {
  checks: Check[];
  declaresDependencies: boolean;
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function dependencyFingerprint(
  occurrences: Map<string, number>,
  code: DependencyCheckCode,
  path: string,
  line: number,
  content: string,
): string {
  const key = JSON.stringify([code, path, content]);
  const occurrence = occurrences.get(key) ?? 0;
  occurrences.set(key, occurrence + 1);
  return contentFindingFingerprint({
    code,
    path,
    ruleId: code,
    content,
    occurrence,
    displayLine: line,
  });
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
  occurrences: Map<string, number>,
  code: DependencyCheckCode,
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
    fingerprint: dependencyFingerprint(
      occurrences,
      code,
      path,
      line,
      `${lineTextValue}\0${detail}`,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageJsonFiles(root: string, inventory?: TrustFileInventory): Iterable<string> {
  if (inventory === undefined)
    return collectFilesUnder(root, (abs) => basename(abs) === "package.json");
  return {
    *[Symbol.iterator]() {
      for (const entry of inventory.matching(
        (candidate) => basename(candidate.absolutePath) === "package.json",
      )) {
        yield entry.absolutePath;
      }
    },
  };
}

function hasLockfile(root: string, inventory?: TrustFileInventory): boolean {
  if (inventory === undefined) {
    return collectFilesUnder(root, (abs) => LOCKFILE_NAMES.has(basename(abs))).length > 0;
  }
  for (const _entry of inventory.matching((entry) =>
    LOCKFILE_NAMES.has(basename(entry.absolutePath)),
  )) {
    return true;
  }
  return false;
}

function directDependencySpecs(pkg: Record<string, unknown>): DirectDependencySpec[] {
  const specs: DirectDependencySpec[] = [];
  for (const blockName of DIRECT_DEP_BLOCKS) {
    const block = pkg[blockName];
    if (!isRecord(block)) continue;
    for (const [name, rawSpec] of Object.entries(block)) {
      specs.push({
        blockName,
        name,
        spec: typeof rawSpec === "string" ? rawSpec : "",
      });
    }
  }
  return specs.sort(
    (a, b) => a.name.localeCompare(b.name) || a.blockName.localeCompare(b.blockName),
  );
}

function directDependencyNames(pkg: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const spec of directDependencySpecs(pkg)) names.add(spec.name);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function normalizeScope(scope: string): string | undefined {
  const trimmed = scope.trim();
  if (trimmed.length === 0) return undefined;
  const prefixed = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
  return prefixed.toLowerCase();
}

function addScopes(scopes: Set<string>, values: readonly string[]): void {
  for (const value of values) {
    const normalized = normalizeScope(value);
    if (normalized !== undefined) scopes.add(normalized);
  }
}

export function resolveInternalScopes(
  ctx: Pick<PlanContext, "env"> & Partial<Pick<PlanContext, "root">>,
): string[] {
  const scopes = new Set<string>();
  addScopes(scopes, (ctx.env.AIH_TRUST_INTERNAL_SCOPES ?? "").split(","));
  if (ctx.root !== undefined) {
    try {
      addScopes(scopes, readOrgPolicy(ctx.root, ctx.env)?.trust?.internalScopes ?? []);
    } catch (error) {
      if (!(error instanceof OrgPolicyError)) throw error;
    }
  }
  return [...scopes].sort((a, b) => a.localeCompare(b));
}

function scopeOfPackage(name: string): string | undefined {
  if (!name.startsWith("@")) return undefined;
  const slash = name.indexOf("/");
  if (slash <= 0) return undefined;
  return name.slice(0, slash).toLowerCase();
}

interface PackageIdentity {
  scope?: string;
  name: string;
}

function packageIdentity(rawName: string): PackageIdentity | undefined {
  const name = rawName.toLowerCase();
  if (!name.startsWith("@")) return { name };
  const slash = name.indexOf("/");
  if (slash <= 1 || slash === name.length - 1) return undefined;
  return { scope: name.slice(0, slash), name: name.slice(slash + 1) };
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
  const dependency = packageIdentity(name);
  if (dependency === undefined) return undefined;
  return POPULAR_PACKAGES.find((popular) => {
    const target = packageIdentity(popular);
    if (target === undefined || target.scope !== dependency.scope) return false;
    return isDamerauLevenshteinDistanceOne(dependency.name, target.name);
  });
}

function hasFullShaFragment(spec: string): boolean {
  return /#[0-9a-f]{40}$/.test(spec.trim());
}

function isGitOrUrlDependency(spec: string): boolean {
  const trimmed = spec.trim();
  const lower = trimmed.toLowerCase();
  return (
    /^(?:git\+)?(?:https?|ssh):\/\//.test(lower) ||
    lower.startsWith("git@") ||
    lower.startsWith("github:") ||
    lower.startsWith("gitlab:") ||
    lower.startsWith("bitbucket:") ||
    lower.startsWith("file:") ||
    lower.startsWith("link:") ||
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.+)?$/.test(trimmed)
  );
}

function isExactVersionSpec(spec: string): boolean {
  const trimmed = spec.trim();
  const npmAlias = /^npm:.+@(.+)$/.exec(trimmed);
  return EXACT_VERSION.test(npmAlias?.[1] ?? trimmed);
}

function unpinnedDependencyReason(name: string, spec: string): string | undefined {
  const trimmed = spec.trim();
  if (trimmed.length === 0) return `direct dependency ${name} has an empty version spec`;
  if (isGitOrUrlDependency(trimmed)) {
    return hasFullShaFragment(trimmed)
      ? undefined
      : `direct dependency ${name} uses a git/url dependency without a 40-character SHA pin`;
  }
  if (isExactVersionSpec(trimmed)) return undefined;
  return `direct dependency ${name} uses unpinned version spec ${JSON.stringify(spec)}`;
}

function unpinnedDependencyCheck(
  occurrences: Map<string, number>,
  rel: string,
  line: number,
  lineTextValue: string,
  detail: string,
  posture: Posture,
): Check {
  return gradeTrustCheck(
    dependencyCheck(occurrences, "trust.unpinned-dependency", rel, line, lineTextValue, detail),
    posture,
  );
}

function scanPackageJson(
  occurrences: Map<string, number>,
  rel: string,
  source: string,
  internalScopes: ReadonlySet<string>,
  posture: Posture,
): PackageScanResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { checks: [], declaresDependencies: false };
  }
  if (!isRecord(parsed)) return { checks: [], declaresDependencies: false };

  const checks: Check[] = [];
  const dependencySpecs = directDependencySpecs(parsed);
  for (const dependency of dependencySpecs) {
    const reason = unpinnedDependencyReason(dependency.name, dependency.spec);
    if (reason === undefined) continue;
    const line = lineForDependency(source, dependency.name);
    const text = lineText(source, line);
    checks.push(unpinnedDependencyCheck(occurrences, rel, line, text, reason, posture));
  }

  for (const name of directDependencyNames(parsed)) {
    const line = lineForDependency(source, name);
    const text = lineText(source, line);
    const scope = scopeOfPackage(name);
    if (scope !== undefined && internalScopes.has(scope)) {
      checks.push(
        dependencyCheck(
          occurrences,
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
          occurrences,
          "trust.typosquat",
          rel,
          line,
          text,
          `direct dependency ${name} is Damerau-Levenshtein distance 1 from popular package ${target}`,
        ),
      );
    }
  }
  return { checks, declaresDependencies: dependencySpecs.length > 0 };
}

function missingLockfileCheck(
  occurrences: Map<string, number>,
  rel: string,
  source: string,
  posture: Posture,
): Check {
  return unpinnedDependencyCheck(
    occurrences,
    rel,
    1,
    lineText(source, 1),
    "package.json declares direct dependencies but no lockfile was found anywhere in the trust source",
    posture,
  );
}

export function scanTrustDependencyNames(
  root: string,
  internalScopes: readonly string[],
  posture: Posture = "vibe",
  inventory?: TrustFileInventory,
): Check[] {
  const scopes = new Set(
    internalScopes.map((scope) => normalizeScope(scope)).filter((scope) => scope !== undefined),
  );
  const checks: Check[] = [];
  const occurrences = new Map<string, number>();
  let firstPackageWithDependencies: { rel: string; source: string } | undefined;
  for (const abs of packageJsonFiles(root, inventory)) {
    const rel = toPosix(relative(root, abs));
    const source = readFileSync(abs, "utf8");
    const result = scanPackageJson(occurrences, rel, source, scopes, posture);
    checks.push(...result.checks);
    if (result.declaresDependencies && firstPackageWithDependencies === undefined) {
      firstPackageWithDependencies = { rel, source };
    }
  }
  if (firstPackageWithDependencies !== undefined && !hasLockfile(root, inventory)) {
    checks.push(
      missingLockfileCheck(
        occurrences,
        firstPackageWithDependencies.rel,
        firstPackageWithDependencies.source,
        posture,
      ),
    );
  }
  return checks;
}
