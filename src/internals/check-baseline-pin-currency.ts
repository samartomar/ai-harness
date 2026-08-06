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

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const lockPath = resolve(here, "..", "baseline-evidence", "vendor-lock.json");
  const { ok, report } = checkBaselinePinCurrency(lockPath);
  process.stdout.write(`${report}\n`);
  if (!ok) process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main();
}
