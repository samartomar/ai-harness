import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BaselineCatalog } from "../baseline-evidence/catalog.js";
import {
  BASELINE_CATALOG_IDS,
  type BaselineCatalogId,
  baselineCatalogById,
} from "../baseline-evidence/catalogs.js";
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
const VENDOR_ISSUER = "@aihq/harness release";

/**
 * Catalogs whose install machinery includes a runtime component that performs real filesystem
 * writes, keyed to that component's id. The installable gate demands this component be authorized
 * before it calls the catalog green — the installer-authorized requirement is scoped to catalogs
 * that carry an installer runtime (issue #438). Catalogs absent here (Superpowers today) install
 * only via human-run `doc()` guidance (see src/superpowers/install.ts): their runtime component is
 * subject content being evaluated, not installing machinery, so nothing is demanded "authorized".
 */
const INSTALLER_RUNTIME_COMPONENT_ID_BY_CATALOG: Partial<Record<BaselineCatalogId, string>> = {
  ecc: "runtime:ecc-installer",
};

/**
 * Catalogs that ship a real install-preview artifact — destination templates the gate replays
 * against a fixture HOME/project to prove no install escapes the fixture. Catalogs absent here
 * (Superpowers today) ship no such artifact by design: their installs are guidance-only `doc()`
 * actions with no destination plan to preview, so the escape check is explicitly skipped and named
 * as such in the report rather than vacuously passed.
 */
const PREVIEW_ARTIFACT_BY_CATALOG: Partial<Record<BaselineCatalogId, string>> = {
  ecc: "ecc-install-preview.json",
};

export interface InstallablePostureResult {
  installed: number;
  installedComponentIds: string[];
  held: Array<{ componentId: string; codes: string[] }>;
  ledgerPath: string;
  previewEscapes: string[];
  previewSkippedReason?: string;
}

export interface InstallableCatalogReport {
  pin: string;
  postures: Record<Posture, InstallablePostureResult>;
  ok: boolean;
}

export interface InstallableBaselineReport {
  catalogs: Record<BaselineCatalogId, InstallableCatalogReport>;
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

interface CatalogEvaluation {
  authorizations: BaselineAuthorization[];
  held: Array<{ componentId: string; codes: string[] }>;
}

/** Canonical sha256 of a lock, matching `vendorBaselineLockSha256` (pretty JSON + trailing newline). */
function canonicalLockSha256(lock: BaselineEvidenceLock): string {
  return createHash("sha256")
    .update(`${JSON.stringify(lock, null, 2)}\n`)
    .digest("hex");
}

/** Order-sensitive string-array equality; reused for both path lists and sorted component-id lists. */
export function samePaths(left: readonly string[], right: readonly string[]): boolean {
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
 * The lock's recorded pin for this catalog. Prefers the pin bound to the active catalog identity;
 * falls back to whatever pin the lock's same-id source carries even when it no longer matches (so a
 * stale/mismatched lock still reports a truthful pin instead of the active one), and only falls back
 * to the active catalog pin when the lock carries no source for this catalog id at all.
 */
function catalogPin(lock: BaselineEvidenceLock, catalog: BaselineCatalog): string {
  const bound = boundSource(lock, catalog)?.pinnedSha;
  if (bound !== undefined) return bound;
  const anySourceWithId = lock.sources.find((source) => source.id === catalog.id)?.pinnedSha;
  return anySourceWithId ?? catalog.pinnedSha;
}

/**
 * Evaluate which catalog components the provided lock authorizes for install. A component is
 * authorized only when the lock is bound to the active catalog pin (same source id/owner/repo/sha),
 * the component matches by id + paths, and its signed verdict is `pass`. Everything else is held and
 * named with its blocking codes, so a lock that does not correspond to the active pin installs
 * nothing (the v2.8.0 regression) while the current pinned lock installs its passing subset. Runs
 * identically for every catalog in `BASELINE_CATALOG_IDS` (issue #438) — only the pass criteria in
 * `postureOkForCatalog` differ per catalog.
 */
function evaluateCatalog(
  lock: BaselineEvidenceLock,
  catalog: BaselineCatalog,
  lockSha256: string,
): CatalogEvaluation {
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

interface CatalogPreviewPlan {
  destinations: string[];
  skippedReason?: string;
}

/**
 * Load the shipped install-preview destination templates for a catalog, or explicitly skip when the
 * catalog ships no such artifact (see `PREVIEW_ARTIFACT_BY_CATALOG`). Skipping is a named, reported
 * fact, never a silent vacuous pass.
 */
function previewPlanForCatalog(catalogId: BaselineCatalogId): CatalogPreviewPlan {
  const fileName = PREVIEW_ARTIFACT_BY_CATALOG[catalogId];
  if (fileName === undefined) {
    return {
      destinations: [],
      skippedReason: `catalog ${catalogId} ships no install-preview artifact by design; its installs are guidance-only doc() actions (see src/superpowers/install.ts) with no destination plan to preview`,
    };
  }
  const previewPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../baseline-evidence",
    fileName,
  );
  const preview = JSON.parse(readFileSync(previewPath, "utf8")) as {
    operations: Array<{ destination?: string }>;
  };
  return {
    destinations: preview.operations
      .map((operation) => operation.destination)
      .filter((destination): destination is string => typeof destination === "string"),
  };
}

/**
 * Per-catalog, per-posture pass criteria (issue #438; each branch is pinned with tests).
 *
 * - Catalogs with an installer runtime (ECC today): byte-for-byte the original ECC criterion — at
 *   least one authorized component, the installer runtime itself authorized, the fixture ledger
 *   matches the authorized set, every held component is named with codes, and no install-preview
 *   destination escapes the fixture.
 * - Catalogs without an installer runtime (Superpowers today): zero authorized components is a
 *   LEGAL, GREEN state — honestly-blocked evidence is a truthful report, not a gate failure. The
 *   gate only turns red when the fixture ledger disagrees with what evidence authorized, a held
 *   component is missing its codes, or a held component's code names missing/drifted evidence
 *   (`baseline.evidence-missing` / `baseline.evidence-mismatch`). Preview-escape findings gate
 *   every catalog that ships a preview artifact, independent of the installer requirement.
 */
export function postureOkForCatalog(input: {
  catalogId: BaselineCatalogId;
  authorizations: readonly BaselineAuthorization[];
  held: ReadonlyArray<{ componentId: string; codes: string[] }>;
  ledgerMatches: boolean;
  previewEscapeCount: number;
}): boolean {
  const { catalogId, authorizations, held, ledgerMatches, previewEscapeCount } = input;
  const heldAllCoded = held.every((entry) => entry.codes.length > 0);
  const installerComponentId = INSTALLER_RUNTIME_COMPONENT_ID_BY_CATALOG[catalogId];

  if (installerComponentId !== undefined) {
    const installerAuthorized = authorizations.some(
      (authorization) => authorization.componentId === installerComponentId,
    );
    return (
      authorizations.length > 0 &&
      installerAuthorized &&
      ledgerMatches &&
      heldAllCoded &&
      previewEscapeCount === 0
    );
  }

  const noMissingOrDriftedEvidence = held.every(
    (entry) =>
      !entry.codes.includes("baseline.evidence-missing") &&
      !entry.codes.includes("baseline.evidence-mismatch"),
  );
  return ledgerMatches && heldAllCoded && noMissingOrDriftedEvidence && previewEscapeCount === 0;
}

/**
 * Run the shipped baseline evidence through a real fixture-HOME install gate, for every catalog in
 * `BASELINE_CATALOG_IDS` and every posture, and report per-catalog whether the pinned lock installs
 * a useful, ledger-backed component set (issue #438: every catalog is evaluated, not just ECC).
 * Overall `ok` is true only when every catalog's `ok` is true; see `postureOkForCatalog` for the
 * per-catalog pass criteria.
 */
export async function checkInstallableBaseline(
  input: CheckInstallableBaselineInput,
): Promise<InstallableBaselineReport> {
  const lock = parseBaselineEvidenceLock(input.lock);
  const lockSha256 = canonicalLockSha256(lock);
  const cli = input.cli ?? DEFAULT_CLI;

  const catalogs = {} as Record<BaselineCatalogId, InstallableCatalogReport>;
  let ok = true;

  for (const catalogId of BASELINE_CATALOG_IDS) {
    const catalog = baselineCatalogById(catalogId);
    const pin = catalogPin(lock, catalog);
    const preview = previewPlanForCatalog(catalogId);

    const postures = {} as Record<Posture, InstallablePostureResult>;
    let catalogOk = true;

    for (const posture of POSTURES) {
      const fixtureRoot = mkdtempSync(join(tmpdir(), `aih-installable-${catalogId}-${posture}-`));
      try {
        const home = join(fixtureRoot, "home");
        const project = join(fixtureRoot, "project");
        mkdirSync(home, { recursive: true });
        mkdirSync(project, { recursive: true });

        const { authorizations, held } = evaluateCatalog(lock, catalog, lockSha256);
        const installedComponentIds = authorizations.map((a) => a.componentId).sort();

        if (authorizations.length > 0) {
          writeRegistrationLedgerAtomic(home, buildLedger(authorizations, resolve(project), cli));
        }
        const ledger = readRegistrationLedger(home);
        const ledgerIds = ledgerComponentIds(ledger).sort();
        const ledgerMatches = samePaths(ledgerIds, installedComponentIds);

        const escapes =
          preview.skippedReason === undefined
            ? previewEscapes(preview.destinations, fixtureRoot, home, project)
            : [];

        const postureOk = postureOkForCatalog({
          catalogId,
          authorizations,
          held,
          ledgerMatches,
          previewEscapeCount: escapes.length,
        });
        if (!postureOk) catalogOk = false;

        postures[posture] = {
          installed: authorizations.length,
          installedComponentIds,
          held,
          ledgerPath: registrationLedgerPath(home),
          previewEscapes: escapes,
          ...(preview.skippedReason !== undefined
            ? { previewSkippedReason: preview.skippedReason }
            : {}),
        };
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    }

    if (!catalogOk) ok = false;
    catalogs[catalogId] = { pin, postures, ok: catalogOk };
  }

  return { catalogs, ok };
}

/**
 * One-line verdict for a catalog. For catalogs with an installer requirement the gate proves real
 * installability; for catalogs without one it only proves the lock's evidence is consistent (zero
 * installed is a legal state there), so the summary must not overclaim "installable".
 */
function catalogSummaryLine(
  catalogId: BaselineCatalogId,
  catalogReport: InstallableCatalogReport,
): string {
  const requiresInstaller = INSTALLER_RUNTIME_COMPONENT_ID_BY_CATALOG[catalogId] !== undefined;
  const verdict = requiresInstaller
    ? `${catalogReport.ok ? "installable" : "NOT installable"} from its own evidence`
    : `evidence ${catalogReport.ok ? "consistent" : "INCONSISTENT"} from its own lock`;
  return `${catalogId}: ${verdict} (pin ${catalogReport.pin})`;
}

async function main(): Promise<void> {
  const report = await checkInstallableBaseline({ lock: readVendorBaselineLock() });
  const redCatalogs: BaselineCatalogId[] = [];

  for (const catalogId of BASELINE_CATALOG_IDS) {
    const catalogReport = report.catalogs[catalogId];
    for (const posture of POSTURES) {
      const result = catalogReport.postures[posture];
      const previewNote =
        result.previewSkippedReason !== undefined
          ? "preview=skipped"
          : `preview-escapes=${result.previewEscapes.length}`;
      process.stdout.write(
        `${catalogId}/${posture}: installed=${result.installed} [${result.installedComponentIds.join(", ")}] held=${result.held.length} ${previewNote}\n`,
      );
    }
    process.stdout.write(`${catalogSummaryLine(catalogId, catalogReport)}\n`);
    if (!catalogReport.ok) redCatalogs.push(catalogId);
  }

  if (!report.ok) {
    process.stderr.write(`baseline installable gate failed for: ${redCatalogs.join(", ")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    "baseline installable gate passed: installer catalogs installable and every catalog's evidence consistent at every posture\n",
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
