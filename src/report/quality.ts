import { gitRead } from "../internals/git.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";

/**
 * CODE QUALITY — the test-to-source FILE ratio (not line coverage). A cheap,
 * honest signal derived from `git ls-files`: how many test files exist relative to
 * non-test source files. Byte-stable, zero-dep. Returns `undefined` outside a repo
 * or when there is no source to measure.
 */

const TEST_DIR = /(^|\/)(tests?|__tests__|spec)\//i;
const TEST_FILE = /[._-](test|spec)\.[cm]?[jt]sx?$|_test\.(py|go|rb)$|(^|\/)test_[^/]*\.py$/i;
const SOURCE_EXT = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "rb",
  "php",
  "cs",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "swift",
  "scala",
  "vue",
  "svelte",
]);

function ext(p: string): string {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i + 1).toLowerCase() : "";
}
const isSource = (p: string): boolean => SOURCE_EXT.has(ext(p));
const isTest = (p: string): boolean => TEST_DIR.test(p) || TEST_FILE.test(p);

export async function qualityDigest(ctx: PlanContext): Promise<DigestAction | undefined> {
  const ls = await gitRead(ctx, ["ls-files"]);
  if (ls === undefined) return undefined;
  const code = ls.split("\n").filter(Boolean).filter(isSource);
  const testFiles = code.filter(isTest).length;
  const sourceFiles = code.length - testFiles; // non-test source
  if (sourceFiles === 0) return undefined;
  const ratio = Math.round((1000 * testFiles) / sourceFiles) / 10; // one decimal
  return digest(
    `Test coverage — ${ratio}% test/source file ratio`,
    lines(
      `Test file ratio: ${ratio}%  (${testFiles} test files / ${sourceFiles} source files)`,
      "",
      "  File-count ratio (test files ÷ non-test source files) — not line coverage.",
    ),
    { ratio, testFiles, sourceFiles },
  );
}
