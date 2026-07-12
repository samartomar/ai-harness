import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nativeIdentityData from "./native-identity-data.json";

/**
 * Declared, curated, deliberately OVER-inclusive closure of source roots whose
 * behavior shapes the `aih-native` trust-scan analyzer's findings (issue #444,
 * design Decision 2). Over-inclusion is safe: an edit to an unrelated file under
 * one of these roots just forces an extra (harmless) identity bump and re-vet.
 * Under-inclusion is the real risk — a native-detector edit outside this closure
 * would leave the identity, and therefore reuse, unaffected, silently keeping a
 * stale `pass` receipt alive.
 *
 * `src/baseline-evidence/vet.ts` and `src/baseline-evidence/hash.ts` are
 * deliberately NOT reachable by these roots: they shape receipt production for
 * every analyzer alike (native, skillspector, cisco), not the aih-native
 * analyzer specifically. A change there is caught by the full migration re-vet
 * plus the `baseline:check` byte-diff instead of by this identity (design O1,
 * resolved: exclude).
 */
export const NATIVE_DETECTOR_GLOB_ROOTS = [
  "src/trust",
  "src/secrets",
  "src/mcp/policy.ts",
  "src/skill/license.ts",
  "src/config/posture.ts",
] as const;

function repoRoot(): string {
  // This file lives at src/baseline-evidence/native-identity.ts.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function collectTsFiles(absPath: string, relPath: string, out: string[]): void {
  let stat: Stats;
  try {
    stat = lstatSync(absPath);
  } catch {
    return; // an absent declared root is treated as contributing no files; drift
    // then shows up as a shrink against the committed NATIVE_DETECTOR_SOURCES.
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    if (relPath.endsWith(".ts")) out.push(relPath);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(absPath)) {
    collectTsFiles(join(absPath, entry), `${relPath}/${entry}`, out);
  }
}

/**
 * Live discovery of the declared closure's CURRENT file set. Used only by the
 * dev-time `check:native-identity` / `baseline:native-identity` gates — never at
 * scan time, since the shipped npm package has no `src/` tree to read.
 */
export function discoverNativeDetectorSourceFiles(root: string = repoRoot()): string[] {
  const files: string[] = [];
  for (const declared of NATIVE_DETECTOR_GLOB_ROOTS) {
    collectTsFiles(resolve(root, ...declared.split("/")), declared, files);
  }
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

/**
 * Live digest recompute over the declared closure's current bytes — dev-time
 * only (see `discoverNativeDetectorSourceFiles`). `sha256(join("\n", sorted(
 * "<relpath>\0<sha256(fileBytes)>")))`, sliced to 12 hex characters.
 */
export function computeNativeDetectorDigest(root: string = repoRoot()): string {
  const files = discoverNativeDetectorSourceFiles(root);
  const lines = files.map((relPath) => {
    const bytes = readFileSync(resolve(root, ...relPath.split("/")));
    return `${relPath}\0${createHash("sha256").update(bytes).digest("hex")}`;
  });
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex").slice(0, 12);
}

/**
 * Committed, generated snapshot of the declared closure (data-only, like
 * `vendor-lock.json`/`vendor.ts`). Regenerate with
 * `npm run baseline:native-identity -- --write` whenever `check:native-identity`
 * reports drift, then review the diff like any other generated artifact.
 */
export const NATIVE_DETECTOR_SOURCES: readonly string[] = nativeIdentityData.sources;
export const NATIVE_DETECTOR_DIGEST: string = nativeIdentityData.digest;

/**
 * `aih-native`'s analyzer identity: a pure content digest over the declared
 * native-detector source closure — deliberately NOT a package version (issue
 * #444). A version prefix would invalidate every receipt at each release version
 * bump even when no detector source changed, forcing a full re-vet on every
 * release PR. Reads the committed constant (never re-hashes `src/` at call
 * time), because the identity must resolve from the shipped `dist/` package too.
 */
export function nativeAnalyzerIdentity(): string {
  return `native.${NATIVE_DETECTOR_DIGEST}`;
}
