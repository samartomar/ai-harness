import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BaselineCatalog } from "../baseline-evidence/catalog.js";
import { baselineCatalogById } from "../baseline-evidence/catalogs.js";
import type { BaselineEvidenceLock, BaselineSourceEvidence } from "../baseline-evidence/schema.js";
import { parseBaselineEvidenceLock } from "../baseline-evidence/schema.js";
import { readVendorBaselineLock } from "../baseline-evidence/vendor.js";
import type { BaselineAuthorization } from "../baseline-evidence/verify.js";
import type { Posture } from "../config/posture.js";
import {
  type RegistrationLedger,
  readRegistrationLedger,
  registrationLedgerPath,
  writeRegistrationLedgerAtomic,
} from "../ecc/registration.js";

const POSTURES: readonly Posture[] = ["vibe", "team", "enterprise"];
const DEFAULT_CLI = "claude";
const RUNTIME_INSTALLER_ID = "runtime:ecc-installer";
const VENDOR_ISSUER = "@aihq/harness release";

export interface InstallablePostureResult {
  installed: number;
  installedComponentIds: string[];
  held: Array<{ componentId: string; codes: string[] }>;
  ledgerPath: string;
}

export interface InstallableBaselineReport {
  pin: string;
  postures: Record<Posture, InstallablePostureResult>;
  ok: boolean;
}

export interface CheckInstallableBaselineInput {
  /** Vendor evidence lock to evaluate (e.g. the shipped `vendor-lock.json` or a frozen fixture). */
  lock: BaselineEvidenceLock;
  /** Restrict every install to throwaway fixture HOMEs/projects; never the real dev seat. */
  fixtureOnly?: boolean;
  /** Target CLI to record in the fixture registration ledger. */
  cli?: string;
}

interface EccEvaluation {
  authorizations: BaselineAuthorization[];
  held: Array<{ componentId: string; codes: string[] }>;
}

/** Canonical sha256 of a lock, matching `vendorBaselineLockSha256` (pretty JSON + trailing newline). */
function canonicalLockSha256(lock: BaselineEvidenceLock): string {
  return createHash("sha256")
    .update(`${JSON.stringify(lock, null, 2)}\n`)
    .digest("hex");
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function boundSource(
  lock: BaselineEvidenceLock,
  catalog: BaselineCatalog,
): BaselineSourceEvidence | undefined {
  return lock.sources.find(
    (source) =>
      source.id === catalog.id &&
      source.owner === catalog.owner &&
      source.repo === catalog.repo &&
      source.pinnedSha === catalog.pinnedSha,
  );
}

/**
 * Evaluate which ECC catalog components the provided lock authorizes for install. A component is
 * authorized only when the lock is bound to the active catalog pin (same source id/owner/repo/sha),
 * the component matches by id + paths, and its signed verdict is `pass`. Everything else is held and
 * named with its blocking codes, so a lock that does not correspond to the active pin installs
 * nothing (the v2.8.0 regression) while the current pinned lock installs its passing subset.
 */
function evaluateEcc(
  lock: BaselineEvidenceLock,
  catalog: BaselineCatalog,
  lockSha256: string,
): EccEvaluation {
  const source = boundSource(lock, catalog);
  const authorizations: BaselineAuthorization[] = [];
  const held: Array<{ componentId: string; codes: string[] }> = [];

  for (const component of catalog.components) {
    const entry = source?.components.find((candidate) => candidate.id === component.id);
    const exact =
      entry !== undefined && samePaths(entry.paths, component.paths) ? entry : undefined;

    if (exact?.verdict === "pass") {
      authorizations.push({
        componentId: component.id,
        source: `${catalog.owner}/${catalog.repo}`,
        pinnedSha: catalog.pinnedSha,
        treeSha256: exact.treeSha256,
        tier: "vendor",
        issuer: VENDOR_ISSUER,
        evidenceSha256: lockSha256,
      });
      continue;
    }
    if (exact?.verdict === "blocked") {
      const codes = [...new Set(exact.findings.map((finding) => finding.code))];
      held.push({ componentId: component.id, codes: codes.length > 0 ? codes : ["trust.finding"] });
      continue;
    }
    held.push({
      componentId: component.id,
      codes: [entry !== undefined ? "baseline.evidence-mismatch" : "baseline.evidence-missing"],
    });
  }

  return { authorizations, held };
}

function buildLedger(
  authorizations: readonly BaselineAuthorization[],
  projectRoot: string,
  cli: string,
): RegistrationLedger {
  return {
    schemaVersion: 1,
    projects: [
      {
        root: projectRoot,
        scope: "scoped",
        components: authorizations.map((authorization) => authorization.componentId),
        mcps: [],
      },
    ],
    targets: [
      {
        target: cli,
        components: authorizations.map((authorization) => ({
          id: authorization.componentId,
          authorization,
        })),
        mcps: [],
      },
    ],
  } as RegistrationLedger;
}

function ledgerComponentIds(ledger: RegistrationLedger): string[] {
  return ledger.targets.flatMap((target) => target.components.map((component) => component.id));
}

function withinFixture(fixtureRoot: string, candidate: string): boolean {
  const rel = relative(fixtureRoot, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolve every shipped install-preview destination template into this posture's fixture HOME and
 * project, and confirm none escapes the fixture root. This proves the shipped install plan can never
 * write outside a throwaway seat before a release is allowed to ship.
 */
function previewEscapes(
  destinations: readonly string[],
  fixtureRoot: string,
  home: string,
  project: string,
): string[] {
  const escapes: string[] = [];
  for (const destination of destinations) {
    const resolved = destination.startsWith("<home>")
      ? resolve(home, `.${destination.slice("<home>".length)}`)
      : destination.startsWith("<project>")
        ? resolve(project, `.${destination.slice("<project>".length)}`)
        : resolve(project, destination);
    if (!withinFixture(fixtureRoot, resolved)) escapes.push(destination);
  }
  return escapes;
}

function previewDestinations(): string[] {
  const previewPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../baseline-evidence/ecc-install-preview.json",
  );
  const preview = JSON.parse(readFileSync(previewPath, "utf8")) as {
    operations: Array<{ destination?: string }>;
  };
  return preview.operations
    .map((operation) => operation.destination)
    .filter((destination): destination is string => typeof destination === "string");
}

/**
 * Run the shipped baseline evidence through a real fixture-HOME install gate for every posture and
 * report whether the pinned lock installs a useful, ledger-backed component set. `ok` is true only
 * when every posture installs at least one component (including the installer runtime), the fixture
 * registration ledger equals the installed set, every held component is named with codes, and no
 * install destination escapes the fixture.
 */
export async function checkInstallableBaseline(
  input: CheckInstallableBaselineInput,
): Promise<InstallableBaselineReport> {
  const lock = parseBaselineEvidenceLock(input.lock);
  const catalog = baselineCatalogById("ecc");
  const lockSha256 = canonicalLockSha256(lock);
  const cli = input.cli ?? DEFAULT_CLI;
  const eccPin =
    boundSource(lock, catalog)?.pinnedSha ?? lock.sources.find((s) => s.id === "ecc")?.pinnedSha;
  const pin = eccPin ?? catalog.pinnedSha;
  const destinations = previewDestinations();

  const postures = {} as Record<Posture, InstallablePostureResult>;
  let ok = true;

  for (const posture of POSTURES) {
    const fixtureRoot = mkdtempSync(join(tmpdir(), `aih-installable-${posture}-`));
    try {
      const home = join(fixtureRoot, "home");
      const project = join(fixtureRoot, "project");
      mkdirSync(home, { recursive: true });
      mkdirSync(project, { recursive: true });

      const { authorizations, held } = evaluateEcc(lock, catalog, lockSha256);
      const installedComponentIds = authorizations.map((a) => a.componentId).sort();

      if (authorizations.length > 0) {
        writeRegistrationLedgerAtomic(home, buildLedger(authorizations, resolve(project), cli));
      }
      const ledger = readRegistrationLedger(home);
      const ledgerIds = ledgerComponentIds(ledger).sort();
      const ledgerMatches = samePaths(ledgerIds, installedComponentIds);

      const escapes = previewEscapes(destinations, fixtureRoot, home, project);
      const heldAllCoded = held.every((entry) => entry.codes.length > 0);
      const installerAuthorized = installedComponentIds.includes(RUNTIME_INSTALLER_ID);

      const postureOk =
        authorizations.length > 0 &&
        installerAuthorized &&
        ledgerMatches &&
        heldAllCoded &&
        escapes.length === 0;
      if (!postureOk) ok = false;

      postures[posture] = {
        installed: authorizations.length,
        installedComponentIds,
        held,
        ledgerPath: registrationLedgerPath(home),
      };
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }

  return { pin, postures, ok };
}

async function main(): Promise<void> {
  const report = await checkInstallableBaseline({ lock: readVendorBaselineLock() });
  for (const posture of POSTURES) {
    const result = report.postures[posture];
    process.stdout.write(
      `${posture}: installed=${result.installed} [${result.installedComponentIds.join(", ")}] held=${result.held.length}\n`,
    );
  }
  if (!report.ok) {
    process.stderr.write(
      `baseline is not installable at every posture from its own evidence (pin ${report.pin})\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `shipped baseline installs from its own evidence at every posture (pin ${report.pin})\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
