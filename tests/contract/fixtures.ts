import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Runner } from "../../src/internals/proc.js";
import { fakeRunner } from "../../src/internals/proc.js";

/** Write `rel` under `dir`, creating parents. */
function put(dir: string, rel: string, contents: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * A realistic TS/Node service: every command is a DECLARED script (→ `detected`),
 * plus a real `.env` so `sensitivePaths` is exercised value-blind.
 */
export function seedMindworksLike(dir: string): void {
  put(
    dir,
    "package.json",
    json({
      name: "mindworks",
      description: "A worked-example service",
      scripts: {
        test: "vitest run",
        build: "tsc -p .",
        lint: "biome check .",
        start: "node dist/main.js",
      },
      dependencies: { express: "^4" },
      devDependencies: { typescript: "^5", vitest: "^1" },
    }),
  );
  put(dir, "tsconfig.json", json({ compilerOptions: { strict: true } }));
  put(dir, "src/main.ts", "export const main = (): number => 0;\n");
  put(dir, ".env", "SECRET=do-not-read\n");
}

/** A Go repo with NO package.json: commands come from language defaults (→ `inferred`). */
export function seedNoPackageJson(dir: string): void {
  put(dir, "go.mod", "module example.com/app\n\ngo 1.22\n");
  put(dir, "main.go", "package main\n\nfunc main() {}\n");
}

/** A Node lib that declares ONLY a test script — no build, no start (strict-omit cases). */
export function seedNodeNoBuildStart(dir: string): void {
  put(
    dir,
    "package.json",
    json({ name: "lib", scripts: { test: "vitest run" }, devDependencies: { vitest: "^1" } }),
  );
  put(dir, "index.js", "module.exports = {};\n");
}

/** A pnpm workspace with a low file count — exercises the monorepo `medium` floor. */
export function seedMonorepoSmall(dir: string): void {
  put(dir, "package.json", json({ name: "root", private: true, workspaces: ["packages/*"] }));
  put(dir, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
  put(dir, "packages/a/package.json", json({ name: "a" }));
}

/** A brownfield foreign-scheme canon (a hand-rolled RULE_ROUTER, no aih marker) → adoptable. */
export function seedForeignCanon(dir: string, contextDir = "ai-coding"): void {
  put(dir, "package.json", json({ name: "legacy" }));
  put(dir, `${contextDir}/RULE_ROUTER.md`, "# Hand-rolled router\nPoints nowhere aih knows.\n");
}

/** A committed, tool-owned CLI rule set with no canon reference → an import candidate. */
export function seedImportableCli(dir: string): void {
  put(dir, "package.json", json({ name: "app" }));
  put(dir, ".claude/agents/reviewer.md", "# Reviewer agent\nDoes reviews, references no canon.\n");
}

/** A superseded legacy regeneration script under the context dir → a retire gap. */
export function seedLegacyScripts(dir: string, contextDir = "ai-coding"): void {
  put(dir, "package.json", json({ name: "legacy-scripts" }));
  put(dir, `${contextDir}/scripts/regenerate-adapters.ps1`, "# legacy generator\n");
}

/** `n` fake tracked paths for the git-`ls-files` runner. */
export function fakeTrackedPaths(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `src/file-${i}.ts`);
}

/**
 * A runner that answers `git ls-files` (plain and `-z`) with `trackedPaths`, so the
 * synthesizer's tracked-file count + committed set are deterministic without real git.
 * Every other argv falls through to a clean exit-0 (empty output).
 */
export function gitTrackedRunner(trackedPaths: readonly string[]): Runner {
  return fakeRunner((argv) => {
    if (argv.includes("ls-files")) {
      const nulDelimited = argv.includes("-z");
      return { stdout: trackedPaths.join(nulDelimited ? "\0" : "\n") };
    }
    return undefined;
  });
}
