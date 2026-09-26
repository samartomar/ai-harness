import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as CatalogPackage from "@aihq/catalog";
import { AihError } from "../errors.js";

/**
 * The one place Core loads `@aihq/catalog`.
 *
 * `@aihq/catalog` is an OPTIONAL PEER of `@aihq/core`: Node resolves it from the
 * consumer's own install beside Core, so a compatible Catalog can be updated
 * without rebuilding or reinstalling Core. A Core-only install supports
 * operations that do not need Catalog. Nothing in Core imports Catalog's values statically;
 * every caller reaches its functions and its public data subpaths through this
 * module, at run time, and checks only what it actually uses.
 *
 * Catalog is a CARRIER here, never an authority: Core decides what it accepts
 * from the bytes this module hands back (for example by a Core-pinned digest).
 *
 * `catalog-package-unavailable` means exactly one thing: the package is not
 * installed next to Core. Historical ECC descriptor resolution surfaces that
 * absence as a named refusal when no matching verified local source-data
 * receipt exists; it does not use Core's embedded Workbench data as fallback.
 * An installed Catalog that cannot be loaded, lacks a needed export or does
 * not publish a needed subpath is `catalog-package-incompatible`, which a
 * caller must surface as a refusal and never answer with a substitute.
 */

export const CATALOG_PACKAGE_NAME = "@aihq/catalog";
/** The peer range `package.json` declares; compatibility beyond it is checked at run time. */
export const CATALOG_PACKAGE_PEER_RANGE = ">=0.3.0 <0.4.0";
export const CATALOG_PACKAGE_INSTALL_COMMAND = "npm install -g @aihq/core @aihq/scan @aihq/catalog";
export const CATALOG_PACKAGE_PROJECT_INSTALL_COMMAND =
  "npm install @aihq/core @aihq/scan @aihq/catalog";

export type CatalogPackageRefusalReasonV1 =
  | "catalog-package-unavailable"
  | "catalog-package-incompatible";

export interface CatalogPackageRefusalV1 {
  readonly reason: CatalogPackageRefusalReasonV1;
  /** One actionable paragraph naming the install command; bounded and control-free. */
  readonly detail: string;
}

/** The Catalog readers Core calls. */
export type CatalogPackageExportNameV1 =
  | "prepareCatalogSourceDataV1"
  | "readCatalogContentV1Result"
  | "readCatalogFrameworkDescriptorV1Result"
  | "readCatalogFrameworkPluginsV1Result"
  | "readCatalogRuntimeDescriptorsV1Result";

/** The public data subpaths Core reads, exactly as Catalog's `exports` map names them. */
export type CatalogPackageSubpathV1 =
  | "./catalog-authoring-bundle.json"
  | "./catalog-core-qualification.json"
  | "./catalog-framework-ecc.json"
  | "./catalog-framework-plugins.json"
  | "./catalog-framework-superpowers.json"
  | "./catalog-index.json"
  | "./catalog-public-baseline.json"
  | "./catalog-runtime-descriptors.json"
  | "./catalog-scanner-evidence.json"
  | "./catalog-scanner-providers.json";

type CatalogPackageFunctionsV1 = Pick<
  typeof CatalogPackage,
  "readCatalogContentV1Result" | "readCatalogRuntimeDescriptorsV1Result"
> & {
  readonly prepareCatalogSourceDataV1: (request: unknown) => unknown;
  readonly readCatalogFrameworkDescriptorV1Result: (request: unknown) => unknown;
  readonly readCatalogFrameworkPluginsV1Result: (request: unknown) => unknown;
};

export interface CatalogPackageFileV1 {
  /** Absolute path the subpath resolved to inside the installed package. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type CatalogPackageLoadV1<
  K extends CatalogPackageExportNameV1,
  S extends CatalogPackageSubpathV1,
> =
  | {
      readonly ok: true;
      readonly exports: Pick<CatalogPackageFunctionsV1, K>;
      /** The installed package root, for readers that resolve package-relative paths. */
      readonly root: string;
      readonly version: string | undefined;
      readonly files: Readonly<Record<S, CatalogPackageFileV1>>;
    }
  | { readonly ok: false; readonly refusal: CatalogPackageRefusalV1 };

/** Test seam: how the installed package is reached. Production always uses the installed peer. */
export interface CatalogPackageAccessV1 {
  readonly importPackage: () => Promise<unknown>;
  /** Resolves `@aihq/catalog/<subpath>` through the package's `exports` map to an absolute path. */
  readonly resolve: (specifier: string) => string;
  /**
   * The package's own root `package.json`, located the way Node locates the package before it
   * applies the package's `exports` map; never through `exports`, which the package controls.
   */
  readonly rootManifestPath: () => string;
  readonly readFile: (path: string) => Uint8Array;
  /** Entry names in a directory, of every type, without following any link. */
  readonly listDirectory: (path: string) => readonly string[];
}

export type CatalogPackageFileLoadV1<S extends CatalogPackageSubpathV1> =
  | {
      readonly ok: true;
      readonly root: string;
      readonly version: string | undefined;
      readonly file: CatalogPackageFileV1 & { readonly subpath: S };
    }
  | { readonly ok: false; readonly refusal: CatalogPackageRefusalV1 };

let candidateAccess: CatalogPackageAccessV1 | undefined;
let installedReached = false;

const installedCatalogAccess: CatalogPackageAccessV1 = {
  importPackage: () => {
    if (candidateAccess !== undefined) return candidateAccess.importPackage();
    installedReached = true;
    return import("@aihq/catalog");
  },
  resolve: (specifier) => {
    if (candidateAccess !== undefined) return candidateAccess.resolve(specifier);
    installedReached = true;
    return createRequire(import.meta.url).resolve(specifier);
  },
  rootManifestPath: () => {
    if (candidateAccess !== undefined) return candidateAccess.rootManifestPath();
    installedReached = true;
    return installedCatalogPackageManifestPathV1(dirname(fileURLToPath(import.meta.url)));
  },
  readFile: (path) =>
    candidateAccess !== undefined ? candidateAccess.readFile(path) : readFileSync(path),
  listDirectory: (path) =>
    candidateAccess !== undefined ? candidateAccess.listDirectory(path) : readdirSync(path),
};

/**
 * The root `package.json` of the `@aihq/catalog` that `import` from `from` loads: as Node's
 * resolver does before it reads any `exports` map, the first `node_modules/@aihq/catalog`
 * directory in `from` or an enclosing directory, with links resolved as Node resolves them.
 * (`module.findPackageJSON` answers the same question but needs Node 22.14; Core supports 20.6.)
 */
export function installedCatalogPackageManifestPathV1(from: string): string {
  for (let directory = from; ; directory = dirname(directory)) {
    const root = join(directory, "node_modules", ...CATALOG_PACKAGE_NAME.split("/"));
    if (statSync(root, { throwIfNoEntry: false })?.isDirectory() === true)
      return join(realpathSync(root), "package.json");
    if (dirname(directory) === directory)
      throw Object.assign(
        new Error(`Cannot find package '${CATALOG_PACKAGE_NAME}' imported from ${from}`),
        { code: "ERR_MODULE_NOT_FOUND" },
      );
  }
}

/**
 * Only `activateCandidateCatalogV1` (internal preparation tools) calls this: from here on
 * the process reads a verified candidate Catalog in place of the installed one. It is
 * one-way, and refused once the installed Catalog was reached, so no preparation mixes the two.
 */
export function substituteCatalogPackageAccessV1(access: CatalogPackageAccessV1): void {
  if (candidateAccess !== undefined)
    throw new TypeError("Candidate Catalog: a candidate is already active in this process");
  if (installedReached)
    throw new TypeError(
      "Candidate Catalog: the installed Catalog was already loaded in this process; a candidate cannot replace it",
    );
  candidateAccess = access;
}

/** True only after a preparation tool activated a verified candidate; never at runtime. */
export function candidateCatalogActiveV1(): boolean {
  return candidateAccess !== undefined;
}

const INSTALL_ADVICE = `Install it with: ${CATALOG_PACKAGE_INSTALL_COMMAND} (in a project: ${CATALOG_PACKAGE_PROJECT_INSTALL_COMMAND}).`;

/** Error text reaches a report, so bound it and keep control characters out. */
function bounded(value: string): string {
  const visible = value.replace(/[\p{C}]/gu, " ").trim();
  return visible.length > 240 ? `${visible.slice(0, 237)}...` : visible;
}

function messageOf(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error));
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** Refusal wording names the candidate while one serves this process's Catalog loads. */
function installed(): string {
  return `the ${candidateAccess === undefined ? "installed" : "candidate"} ${CATALOG_PACKAGE_NAME}`;
}

function incompatible(detail: string): CatalogPackageRefusalV1 {
  return {
    reason: "catalog-package-incompatible",
    detail: `${detail}; this Core needs ${CATALOG_PACKAGE_NAME} ${CATALOG_PACKAGE_PEER_RANGE} with that public API. ${INSTALL_ADVICE}`,
  };
}

function importFailure(error: unknown): CatalogPackageRefusalV1 {
  const message = messageOf(error);
  // Only a package that is genuinely absent is "unavailable". Anything else is an
  // installed Catalog that is broken, and must never be treated as absent.
  if (codeOf(error) === "ERR_MODULE_NOT_FOUND" && message.includes(`'${CATALOG_PACKAGE_NAME}'`)) {
    return {
      reason: "catalog-package-unavailable",
      detail: `${CATALOG_PACKAGE_NAME} is not installed next to @aihq/core. ${INSTALL_ADVICE}`,
    };
  }
  return incompatible(`${installed()} could not be loaded (${message})`);
}

function resolutionFailure(error: unknown): CatalogPackageRefusalV1 {
  const message = messageOf(error);
  const missingPackage =
    message.includes(`Cannot find package '${CATALOG_PACKAGE_NAME}'`) ||
    message.includes(`Cannot find package "${CATALOG_PACKAGE_NAME}"`) ||
    message.includes(`Cannot find module '${CATALOG_PACKAGE_NAME}/package.json'`) ||
    message.includes(`Cannot find module "${CATALOG_PACKAGE_NAME}/package.json"`);
  if (
    (codeOf(error) === "MODULE_NOT_FOUND" || codeOf(error) === "ERR_MODULE_NOT_FOUND") &&
    missingPackage
  ) {
    return {
      reason: "catalog-package-unavailable",
      detail: `${CATALOG_PACKAGE_NAME} is not installed next to @aihq/core. ${INSTALL_ADVICE}`,
    };
  }
  return incompatible(`${installed()} could not be resolved (${message})`);
}

function exportIsFunction(namespace: object, name: string): boolean {
  try {
    return typeof (namespace as Record<string, unknown>)[name] === "function";
  } catch {
    // A namespace that throws on access (e.g. a partial test double) lacks the export.
    return false;
  }
}

function packageManifest(access: CatalogPackageAccessV1, manifestPath: string): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        access.readFile(manifestPath),
      ),
    );
  } catch {
    return undefined;
  }
}

function packageVersion(manifest: unknown): string | undefined {
  const version = (manifest as { version?: unknown } | null)?.version;
  return typeof version === "string" ? bounded(version) : undefined;
}

/**
 * A candidate Catalog keeps the release name, version and exports, and marks itself only
 * with `CANDIDATE.json` and `package.json#aihCandidate` (Catalog `npm run build:candidate`).
 * Ordinary loading refuses either marker, however the package was installed or its tarball
 * named: a candidate is used only through the explicit, digest-checked preparation
 * activation (`activateCandidateCatalogV1`), whose reads never come here unchecked.
 * The marker is an ENTRY of the package root: of any type (a dangling link or a directory
 * counts), in any letter case (a case-insensitive file system serves a variant as the marker).
 */
function candidateRefusal(
  access: CatalogPackageAccessV1,
  root: string,
  manifest: unknown,
): CatalogPackageRefusalV1 | undefined {
  if (access === installedCatalogAccess && candidateAccess !== undefined) return undefined;
  let markers: string[];
  try {
    markers = access
      .listDirectory(root)
      .filter((name) => name.toLowerCase() === "candidate.json")
      .map(bounded);
  } catch (error) {
    return incompatible(
      `${installed()} could not be checked for a candidate marker (${messageOf(error)})`,
    );
  }
  if (manifest !== null && typeof manifest === "object" && Object.hasOwn(manifest, "aihCandidate"))
    markers.push("package.json#aihCandidate");
  return markers.length === 0
    ? undefined
    : incompatible(
        `${installed()} carries ${markers.join(", ")}: a candidate Catalog is not a release`,
      );
}

function compatibleVersion(version: string | undefined): version is string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version ?? "");
  return match?.[1] === "0" && match[2] === "3";
}

/**
 * Every manifest and marker check, all before anything is imported from the package, so a
 * refused package's code never runs. The manifest checked is the package's own root manifest;
 * a package whose `exports` sends `./package.json` anywhere else is refused.
 */
function checkedPackage(
  access: CatalogPackageAccessV1,
):
  | { readonly ok: true; readonly root: string; readonly version: string }
  | { readonly ok: false; readonly refusal: CatalogPackageRefusalV1 } {
  let manifestPath: string;
  let exportedManifestPath: string;
  try {
    manifestPath = access.rootManifestPath();
    exportedManifestPath = access.resolve(`${CATALOG_PACKAGE_NAME}/package.json`);
  } catch (error) {
    return { ok: false, refusal: resolutionFailure(error) };
  }
  if (exportedManifestPath !== manifestPath)
    return {
      ok: false,
      refusal: incompatible(
        `${installed()} exports ./package.json as ${bounded(exportedManifestPath)}, which is not its root package.json`,
      ),
    };
  const root = dirname(manifestPath);
  const manifest = packageManifest(access, manifestPath);
  const version = packageVersion(manifest);
  if (!compatibleVersion(version))
    return {
      ok: false,
      refusal: incompatible(`${installed()} version ${version ?? "is unreadable"}`),
    };
  const candidate = candidateRefusal(access, root, manifest);
  if (candidate !== undefined) return { ok: false, refusal: candidate };
  return { ok: true, root, version };
}

/**
 * Import the installed `@aihq/catalog`, hand back exactly the named functions
 * (verified by `typeof`) and the exact bytes of the named public subpaths.
 * Never throws.
 */
export async function loadCatalogPackageV1<
  K extends CatalogPackageExportNameV1,
  S extends CatalogPackageSubpathV1,
>(
  names: readonly K[],
  subpaths: readonly S[],
  access: CatalogPackageAccessV1 = installedCatalogAccess,
): Promise<CatalogPackageLoadV1<K, S>> {
  const checked = checkedPackage(access);
  if (!checked.ok) return checked;
  const { root, version } = checked;
  let namespace: unknown;
  try {
    namespace = await access.importPackage();
  } catch (error) {
    return { ok: false, refusal: importFailure(error) };
  }
  const missing =
    namespace !== null && typeof namespace === "object"
      ? names.filter((name) => !exportIsFunction(namespace as object, name))
      : [...names];
  if (missing.length > 0) {
    return {
      ok: false,
      refusal: incompatible(`${installed()} does not export ${missing.join(", ")} as functions`),
    };
  }
  const files = {} as Record<S, CatalogPackageFileV1>;
  for (const subpath of subpaths) {
    const specifier = `${CATALOG_PACKAGE_NAME}/${subpath.slice("./".length)}`;
    let path: string;
    try {
      path = access.resolve(specifier);
    } catch (error) {
      return {
        ok: false,
        refusal: incompatible(
          codeOf(error) === "ERR_PACKAGE_PATH_NOT_EXPORTED"
            ? `${installed()} does not export ${subpath}`
            : `${installed()} could not resolve ${subpath} (${messageOf(error)})`,
        ),
      };
    }
    try {
      files[subpath] = Object.freeze({ path, bytes: Uint8Array.from(access.readFile(path)) });
    } catch (error) {
      return {
        ok: false,
        refusal: incompatible(`${installed()} ${subpath} could not be read (${messageOf(error)})`),
      };
    }
  }
  const exports = {} as Record<string, unknown>;
  for (const name of names) exports[name] = (namespace as Record<string, unknown>)[name];
  return {
    ok: true,
    exports: exports as Pick<CatalogPackageFunctionsV1, K>,
    root,
    version,
    files: Object.freeze(files),
  };
}

/**
 * Synchronous data-only path for existing synchronous Core policy APIs. It
 * resolves only Catalog's public package manifest and named JSON subpath; the
 * caller owns schema validation of the returned bytes.
 */
export function loadCatalogPackageFileV1<S extends CatalogPackageSubpathV1>(
  subpath: S,
  access: CatalogPackageAccessV1 = installedCatalogAccess,
): CatalogPackageFileLoadV1<S> {
  const checked = checkedPackage(access);
  if (!checked.ok) return checked;
  const { root, version } = checked;
  const specifier = `${CATALOG_PACKAGE_NAME}/${subpath.slice("./".length)}`;
  let path: string;
  try {
    path = access.resolve(specifier);
  } catch (error) {
    return {
      ok: false,
      refusal: incompatible(
        codeOf(error) === "ERR_PACKAGE_PATH_NOT_EXPORTED"
          ? `${installed()} does not export ${subpath}`
          : `${installed()} could not resolve ${subpath} (${messageOf(error)})`,
      ),
    };
  }
  try {
    return {
      ok: true,
      root,
      version,
      file: Object.freeze({ subpath, path, bytes: Uint8Array.from(access.readFile(path)) }),
    };
  } catch (error) {
    return {
      ok: false,
      refusal: incompatible(`${installed()} ${subpath} could not be read (${messageOf(error)})`),
    };
  }
}

/** `reason: detail`, the form every report prints a package refusal in. */
export function catalogPackageRefusalMessage(refusal: CatalogPackageRefusalV1): string {
  return `${refusal.reason}: ${refusal.detail}`;
}

/** The refusal, for an API whose contract is already to throw on failure. */
export class CatalogPackageRefusalError extends AihError {
  readonly refusal: CatalogPackageRefusalV1;

  constructor(refusal: CatalogPackageRefusalV1) {
    super(catalogPackageRefusalMessage(refusal), "AIH_CATALOG_PACKAGE");
    this.refusal = refusal;
  }
}
