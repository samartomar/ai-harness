import type * as ScanPackage from "@aihq/scan";
import { AihError } from "../errors.js";
import type { ScanExecutionAdapterV1 } from "../org-policy/governance-input-v1.js";

/**
 * The one place Core loads `@aihq/scan`.
 *
 * `@aihq/scan` is an OPTIONAL PEER of `@aihq/core`: Node resolves it from the
 * consumer's own install beside Core, so a compatible Scan can be updated
 * without rebuilding or reinstalling Core, and a Core-only install is a
 * supported arrangement. Nothing in Core imports Scan's values statically;
 * every caller reaches them through this module, at run time, and checks only
 * the exports it actually calls.
 *
 * A missing or incompatible install is a typed refusal that names the install
 * command. It is never a throw, a crash or a silently substituted
 * implementation: Core carries no copy of Scan.
 */

export const SCAN_PACKAGE_NAME = "@aihq/scan";
/** The peer range `package.json` declares; compatibility beyond it is checked at run time. */
export const SCAN_PACKAGE_PEER_RANGE = ">=0.4.0 <1.0.0";
export const SCAN_PACKAGE_INSTALL_COMMAND = "npm install -g @aihq/core @aihq/scan";
export const SCAN_PACKAGE_PROJECT_INSTALL_COMMAND = "npm install @aihq/core @aihq/scan";

export type ScanPackageRefusalReasonV1 = "scan-package-unavailable" | "scan-package-incompatible";

export interface ScanPackageRefusalV1 {
  readonly reason: ScanPackageRefusalReasonV1;
  /** One actionable paragraph naming the install command; bounded and control-free. */
  readonly detail: string;
}

/** The Scan functions Core calls for baseline request authoring and publication consumption. */
export type ScanBaselineExportNameV1 =
  | "canonicalBaselineVetRequestV1Bytes"
  | "createBaselineVetRequestV1"
  | "parseBaselineVetAttestationEnvelopeV1Json"
  | "parseBaselineVetReceiptV1Json"
  | "parseBaselineVetRequestV1Json"
  | "verifyBaselineVetAttestationV1";

/** Scan's public detector execution: exactly the members of Core's adapter seam. */
export type ScanExecutionExportNameV1 = keyof ScanExecutionAdapterV1;

export type ScanPackageExportNameV1 = ScanBaselineExportNameV1 | ScanExecutionExportNameV1;

type ScanPackageFunctionsV1 = Pick<typeof ScanPackage, ScanBaselineExportNameV1> &
  ScanExecutionAdapterV1;

export type ScanPackageLoadV1<K extends ScanPackageExportNameV1> =
  | { readonly ok: true; readonly exports: Pick<ScanPackageFunctionsV1, K> }
  | { readonly ok: false; readonly refusal: ScanPackageRefusalV1 };

/** Test seam: resolves the package namespace. Production always imports the installed peer. */
export type ScanPackageImporterV1 = () => Promise<unknown>;

const importInstalledScanPackage: ScanPackageImporterV1 = () => import("@aihq/scan");

const INSTALL_ADVICE = `Install it with: ${SCAN_PACKAGE_INSTALL_COMMAND} (in a project: ${SCAN_PACKAGE_PROJECT_INSTALL_COMMAND}).`;

/** Error text reaches a report, so bound it and keep control characters out. */
function bounded(value: string): string {
  const visible = value.replace(/[\p{C}]/gu, " ").trim();
  return visible.length > 240 ? `${visible.slice(0, 237)}...` : visible;
}

function unavailable(error: unknown): ScanPackageRefusalV1 {
  const code = (error as { code?: unknown } | null)?.code;
  const message = bounded(error instanceof Error ? error.message : String(error));
  const missing =
    code === "ERR_MODULE_NOT_FOUND" && message.includes(`'${SCAN_PACKAGE_NAME}'`)
      ? `${SCAN_PACKAGE_NAME} is not installed next to @aihq/core`
      : `${SCAN_PACKAGE_NAME} could not be loaded (${message})`;
  return {
    reason: "scan-package-unavailable",
    detail: `${missing}; this operation needs its public API. ${INSTALL_ADVICE}`,
  };
}

function exportIsFunction(namespace: object, name: string): boolean {
  try {
    return typeof (namespace as Record<string, unknown>)[name] === "function";
  } catch {
    // A namespace that throws on access (e.g. a partial test double) lacks the export.
    return false;
  }
}

/**
 * Import the installed `@aihq/scan` and hand back exactly the named functions,
 * verified by `typeof`. Never throws.
 */
export async function loadScanPackageExportsV1<K extends ScanPackageExportNameV1>(
  names: readonly K[],
  importer: ScanPackageImporterV1 = importInstalledScanPackage,
): Promise<ScanPackageLoadV1<K>> {
  let namespace: unknown;
  try {
    namespace = await importer();
  } catch (error) {
    return { ok: false, refusal: unavailable(error) };
  }
  const missing =
    namespace !== null && typeof namespace === "object"
      ? names.filter((name) => !exportIsFunction(namespace as object, name))
      : [...names];
  if (missing.length > 0) {
    return {
      ok: false,
      refusal: {
        reason: "scan-package-incompatible",
        detail: `the installed ${SCAN_PACKAGE_NAME} does not export ${missing.join(", ")} as functions; this Core needs ${SCAN_PACKAGE_NAME} ${SCAN_PACKAGE_PEER_RANGE} with that public API. ${INSTALL_ADVICE}`,
      },
    };
  }
  const exports = {} as Record<string, unknown>;
  for (const name of names) exports[name] = (namespace as Record<string, unknown>)[name];
  return { ok: true, exports: exports as Pick<ScanPackageFunctionsV1, K> };
}

/** Scan's own `{ listDetectorCapabilitiesV1, runDetectorV1 }` as Core's execution adapter. */
export async function loadScanExecutionAdapterV1(
  importer?: ScanPackageImporterV1,
): Promise<
  | { readonly ok: true; readonly adapter: ScanExecutionAdapterV1 }
  | { readonly ok: false; readonly refusal: ScanPackageRefusalV1 }
> {
  const loaded = await loadScanPackageExportsV1(
    ["listDetectorCapabilitiesV1", "runDetectorV1"],
    importer,
  );
  if (!loaded.ok) return loaded;
  const { listDetectorCapabilitiesV1, runDetectorV1 } = loaded.exports;
  return { ok: true, adapter: { listDetectorCapabilitiesV1, runDetectorV1 } };
}

/** `reason: detail`, the form every report prints a package refusal in. */
export function scanPackageRefusalMessage(refusal: ScanPackageRefusalV1): string {
  return `${refusal.reason}: ${refusal.detail}`;
}

/** The refusal, for an API whose contract is already to throw on failure. */
export class ScanPackageRefusalError extends AihError {
  readonly refusal: ScanPackageRefusalV1;

  constructor(refusal: ScanPackageRefusalV1) {
    super(scanPackageRefusalMessage(refusal), "AIH_SCAN_PACKAGE");
    this.refusal = refusal;
  }
}

/** The exports of an earlier load, or its refusal thrown as `ScanPackageRefusalError`. */
export function scanPackageExportsOrThrowV1<K extends ScanPackageExportNameV1>(
  loaded: ScanPackageLoadV1<K>,
): Pick<ScanPackageFunctionsV1, K> {
  if (!loaded.ok) throw new ScanPackageRefusalError(loaded.refusal);
  return loaded.exports;
}
