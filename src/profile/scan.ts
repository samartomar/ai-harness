import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The synthesized profile of a repository: the languages/stacks present plus the
 * canonical commands a model should run to test, build, and lint it. Every field
 * is derived purely from on-disk signature files (no network, no execution), so
 * the same tree always yields the same {@link RepoStack}.
 */
export interface RepoStack {
  /** Detected languages/runtimes, deduped, in first-seen order. */
  languages: string[];
  /** How to run the test suite (e.g. "npx vitest run"), or undefined if unknown. */
  testRunner?: string;
  /** How to produce a build (e.g. "next build"), or undefined if unknown. */
  buildCommand?: string;
  /** How to lint (e.g. "ruff check ."), or undefined if unknown. */
  lintCommand?: string;
  /** Detected deployment targets (Docker / Kubernetes-Helm / Terraform). */
  deployment: string[];
}

export interface ScanOptions {
  /** How deep to recurse below `root` (root itself is depth 0). */
  maxDepth: number;
}

/** Directories never worth walking — build output, vendored deps, VCS metadata. */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".ai-context",
  "coverage",
  ".next",
  "target",
  "vendor",
]);

/**
 * A signature file the model recognizes, paired with the side effects it has on
 * the accumulating stack. Filename matches are exact; `*.csproj`-style patterns
 * are handled separately by {@link matchesExtension}.
 */
interface Accumulator {
  languages: string[];
  deployment: string[];
  testRunner?: string;
  buildCommand?: string;
  lintCommand?: string;
}

/**
 * Recursively scan `root` for stack signatures and synthesize a {@link RepoStack}.
 * Pure and side-effect-free beyond reading the filesystem: excludes vendored and
 * generated directories, is robust to unreadable directories (skips them), and
 * dedupes languages. Detection rules mirror the reference profiler in the
 * blueprint exactly (env var names, commands, thresholds).
 */
export function scanRepo(root: string, opts: ScanOptions): RepoStack {
  const acc: Accumulator = { languages: [], deployment: [] };
  walk(root, 0, Math.max(0, opts.maxDepth), acc);
  return {
    languages: dedupe(acc.languages),
    testRunner: acc.testRunner,
    buildCommand: acc.buildCommand,
    lintCommand: acc.lintCommand,
    deployment: dedupe(acc.deployment),
  };
}

function walk(dir: string, depth: number, maxDepth: number, acc: Accumulator): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip, never throw
  }

  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) subdirs.push(entry.name);
      continue;
    }
    if (entry.isFile()) inspectFile(dir, entry.name, acc);
  }

  if (depth >= maxDepth) return;
  for (const name of subdirs) {
    walk(join(dir, name), depth + 1, maxDepth, acc);
  }
}

/** Apply the blueprint detection rules for a single file. */
function inspectFile(dir: string, name: string, acc: Accumulator): void {
  switch (name) {
    case "package.json":
      detectNode(join(dir, name), acc);
      return;
    case "go.mod":
      addLanguage(acc, "Go");
      acc.testRunner ??= "go test ./...";
      acc.buildCommand ??= "go build ./...";
      return;
    case "Cargo.toml":
      addLanguage(acc, "Rust");
      acc.testRunner ??= "cargo test";
      acc.buildCommand ??= "cargo build";
      return;
    case "pyproject.toml":
    case "requirements.txt":
      addLanguage(acc, "Python");
      acc.testRunner ??= "pytest";
      acc.buildCommand ??= "python -m build";
      acc.lintCommand ??= "ruff check";
      return;
    case "pom.xml":
      addLanguage(acc, "Java/Maven");
      acc.testRunner ??= "mvn test";
      acc.buildCommand ??= "mvn clean package";
      return;
    case "build.gradle":
    case "build.gradle.kts":
      addLanguage(acc, "Java/Gradle");
      acc.testRunner ??= "gradle test";
      acc.buildCommand ??= "gradle build";
      return;
    case "Dockerfile":
      addDeployment(acc, "Docker");
      return;
    case "Chart.yaml":
      addDeployment(acc, "Kubernetes/Helm");
      return;
    case "main.tf":
      addDeployment(acc, "Terraform");
      return;
    default:
      detectByExtension(name, acc);
  }
}

/** `.NET Core` is signalled by any `*.csproj`, `*.slnx`, or `*.sln`. */
function detectByExtension(name: string, acc: Accumulator): void {
  if (
    matchesExtension(name, ".csproj") ||
    matchesExtension(name, ".slnx") ||
    matchesExtension(name, ".sln")
  ) {
    addLanguage(acc, ".NET Core");
    acc.testRunner ??= "dotnet test";
    acc.buildCommand ??= "dotnet build";
  }
}

/**
 * Inspect a `package.json` for the JS toolchain. Always adds "TypeScript/Node.js"
 * (matching the blueprint, which treats a Node manifest as a TS/Node project),
 * then refines the test runner from `vitest`/`jest` and the build from `next`.
 * Unreadable or malformed manifests still register the language.
 */
function detectNode(path: string, acc: Accumulator): void {
  addLanguage(acc, "TypeScript/Node.js");
  const deps = readPackageDeps(path);
  if (deps.has("vitest")) acc.testRunner ??= "npx vitest run";
  else if (deps.has("jest")) acc.testRunner ??= "npm run test";
  if (deps.has("next")) acc.buildCommand ??= "next build";
}

/** Union of dependencies + devDependencies declared in a package.json. */
function readPackageDeps(path: string): Set<string> {
  const names = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return names; // malformed manifest — language still counts, no dep refinement
  }
  if (!isRecord(parsed)) return names;
  for (const field of ["dependencies", "devDependencies"]) {
    const section = parsed[field];
    if (isRecord(section)) {
      for (const dep of Object.keys(section)) names.add(dep);
    }
  }
  return names;
}

function matchesExtension(name: string, ext: string): boolean {
  return name.length > ext.length && name.toLowerCase().endsWith(ext);
}

function addLanguage(acc: Accumulator, language: string): void {
  acc.languages.push(language);
}

function addDeployment(acc: Accumulator, target: string): void {
  acc.deployment.push(target);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
