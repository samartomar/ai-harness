import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { baselineAnalyzerVersions } from "../baseline-evidence/analyzer-profile.js";
import { BASELINE_CATALOG_IDS, baselineCatalogById } from "../baseline-evidence/catalogs.js";
import { comparePinSets, formatPinCurrency } from "../baseline-evidence/pin-currency.js";
import { parseBaselineEvidenceLock } from "../baseline-evidence/schema.js";

/**
 * Fail closed when the committed baseline evidence no longer describes the pins
 * this build declares.
 *
 * Cheap by construction: it reads the committed lock and compares recorded
 * identities against declared ones. It does not rescan anything, so it can run
 * on every event without the cost that made the from-scratch re-vet impractical
 * to repeat — while still being the thing that decides when that expensive run
 * is genuinely required.
 */
export function checkBaselinePinCurrency(lockPath: string): { ok: boolean; report: string } {
  const lock = parseBaselineEvidenceLock(JSON.parse(readFileSync(lockPath, "utf8")));
  const drift = comparePinSets({
    lock,
    catalogs: BASELINE_CATALOG_IDS.map((id) => baselineCatalogById(id)),
    analyzerVersions: baselineAnalyzerVersions(),
  });
  return { ok: drift.length === 0, report: formatPinCurrency(drift) };
}

/** The committed lock this check defends, resolved relative to this module. */
export function defaultLockPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "baseline-evidence",
    "vendor-lock.json",
  );
}

/**
 * The CLI body, exported and parameterized so its reporting and exit behaviour
 * are testable directly. Returns the exit code rather than setting it, so a
 * caller — including a test — observes the decision instead of a side effect.
 */
export function runPinCurrencyCli(
  lockPath: string = defaultLockPath(),
  write: (text: string) => void = (text) => void process.stdout.write(text),
): number {
  const { ok, report } = checkBaselinePinCurrency(lockPath);
  write(`${report}\n`);
  return ok ? 0 : 1;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  process.exitCode = runPinCurrencyCli();
}
