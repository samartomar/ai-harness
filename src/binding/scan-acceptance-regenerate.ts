import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkSuperpowersScanAcceptance,
  ScanAcceptanceCheckError,
  type ScanAcceptanceCheckReport,
  SUPERPOWERS_ACCEPTANCE_COMMIT,
} from "./scan-acceptance-check.js";

/** The shipped ledger lives with this module, never relative to the caller's cwd. */
export const SCAN_ACCEPTANCE_LEDGER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "scan-acceptance.json",
);
export const SCAN_ACCEPTANCE_REGEN_REASON =
  `No content findings are accepted for the exact pinned obra/superpowers framework tree at ${SUPERPOWERS_ACCEPTANCE_COMMIT}. ` +
  "This observational ledger never authorizes a runtime gate; regeneration records no acceptance.";

export class ScanAcceptanceRegenerateError extends ScanAcceptanceCheckError {}

export interface ScanAcceptanceRegenerateInput {
  checkoutPath: string;
  check?: boolean;
}

export interface ScanAcceptanceRegenerateDeps {
  check?: (input: { checkoutPath: string }) => Promise<ScanAcceptanceCheckReport>;
  read?: (path: string) => string;
  write?: (path: string, bytes: string) => void;
  targetPath?: string;
}

function fail(message: string): never {
  throw new ScanAcceptanceRegenerateError(message);
}

function canonicalLedger(): string {
  return `${JSON.stringify(
    { schemaVersion: 2, reason: SCAN_ACCEPTANCE_REGEN_REASON, accepted: [] },
    null,
    2,
  )}\n`;
}

function assertExactObservationalReport(report: ScanAcceptanceCheckReport): void {
  if (
    report.checkout?.repository !== "obra/superpowers" ||
    report.checkout?.commitSha !== SUPERPOWERS_ACCEPTANCE_COMMIT ||
    report.authorizes !== false
  ) {
    fail("checker did not prove the exact observational Superpowers acceptance state");
  }
}

function assertRegularUnlinkedTarget(target: string): void {
  if (!isAbsolute(target)) fail("scan acceptance artifact path must be absolute");
  try {
    const directory = lstatSync(dirname(target));
    const destination = lstatSync(target);
    if (
      directory.isSymbolicLink() ||
      !directory.isDirectory() ||
      destination.isSymbolicLink() ||
      !destination.isFile()
    ) {
      fail("scan acceptance artifact target must be a regular unlinked file");
    }
  } catch (error) {
    if (error instanceof ScanAcceptanceRegenerateError) throw error;
    fail("scan acceptance artifact target is unavailable or unsafe");
  }
}

function writeCanonicalLedgerAtomic(target: string, contents: string): void {
  const directory = dirname(target);
  const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Regenerate only the intentionally empty committed ledger after the checker has
 * proven the separately supplied vendor checkout exact, detached, clean, and
 * no-replacement-ref inspected. Observations are never converted into acceptance.
 */
export async function regenerateSuperpowersScanAcceptance(
  input: ScanAcceptanceRegenerateInput,
  deps: ScanAcceptanceRegenerateDeps = {},
): Promise<string> {
  if (!isAbsolute(input.checkoutPath)) fail("vendor checkout path must be explicit and absolute");
  const report = await (deps.check ?? checkSuperpowersScanAcceptance)({
    checkoutPath: input.checkoutPath,
  });
  assertExactObservationalReport(report);
  if (report.critical.length > 0)
    fail("critical scanner observations cannot regenerate acceptance");
  const bytes = canonicalLedger();
  const target = deps.targetPath ?? SCAN_ACCEPTANCE_LEDGER_PATH;
  assertRegularUnlinkedTarget(target);
  if (input.check === true) {
    let current: string;
    try {
      current = (deps.read ?? ((path) => readFileSync(path, "utf8")))(target);
    } catch {
      fail("scan acceptance artifact is unavailable for read-only check");
    }
    if (current !== bytes)
      fail(
        "scan acceptance artifact is not canonical; regenerate it from the exact vendor checkout",
      );
    return bytes;
  }
  try {
    (deps.write ?? writeCanonicalLedgerAtomic)(target, bytes);
  } catch {
    fail("scan acceptance artifact could not be written");
  }
  return bytes;
}

export async function runScanAcceptanceRegenerateCli(
  argv: readonly string[],
  deps: ScanAcceptanceRegenerateDeps = {},
): Promise<string> {
  const checkoutPath = argv[1] ?? "";
  const check = argv.length === 3 && argv[2] === "--check";
  if (!((argv.length === 2 || check) && argv[0] === "--checkout" && isAbsolute(checkoutPath))) {
    fail("usage: regen:scan-acceptance --checkout <absolute-superpowers-checkout> [--check]");
  }
  return regenerateSuperpowersScanAcceptance({ checkoutPath, check }, deps);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void runScanAcceptanceRegenerateCli(process.argv.slice(2))
    .then((bytes) => process.stdout.write(bytes))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "scan acceptance regeneration failed"}\n`,
      );
      process.exitCode = 1;
    });
}
