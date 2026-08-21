import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkSuperpowersScanAcceptance,
  ScanAcceptanceCheckError,
  type ScanAcceptanceCheckReport,
} from "./scan-acceptance-check.js";

const TARGET = resolve("src/binding/scan-acceptance.json");
const REASON =
  "No content findings are accepted for the exact pinned obra/superpowers framework tree. This observational ledger never authorizes a runtime gate; regeneration records no acceptance.";

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
  return `${JSON.stringify({ schemaVersion: 2, reason: REASON, accepted: [] }, null, 2)}\n`;
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
  if (report.critical.length > 0)
    fail("critical scanner observations cannot regenerate acceptance");
  const bytes = canonicalLedger();
  const target = deps.targetPath ?? TARGET;
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
    (deps.write ?? ((path, contents) => writeFileSync(path, contents, "utf8")))(target, bytes);
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
