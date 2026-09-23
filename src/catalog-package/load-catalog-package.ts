import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
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
export const CATALOG_PACKAGE_PEER_RANGE = ">=0.2.0 <1.0.0";
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
  | "readCatalogContentV1Result"
  | "readCatalogRuntimeDescriptorsV1Result";

/** The public data subpaths Core reads, exactly as Catalog's `exports` map names them. */
export type CatalogPackageSubpathV1 = "./catalog-index.json" | "./catalog-runtime-descriptors.json";

type CatalogPackageFunctionsV1 = Pick<typeof CatalogPackage, CatalogPackageExportNameV1>;

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
  readonly readFile: (path: string) => Uint8Array;
}

const installedCatalogAccess: CatalogPackageAccessV1 = {
  importPackage: () => import("@aihq/catalog"),
  resolve: (specifier) => createRequire(import.meta.url).resolve(specifier),
  readFile: (path) => readFileSync(path),
};

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
  return incompatible(`the installed ${CATALOG_PACKAGE_NAME} could not be loaded (${message})`);
}

function exportIsFunction(namespace: object, name: string): boolean {
  try {
    return typeof (namespace as Record<string, unknown>)[name] === "function";
  } catch {
    // A namespace that throws on access (e.g. a partial test double) lacks the export.
    return false;
  }
}

function packageVersion(access: CatalogPackageAccessV1): string | undefined {
  try {
    const manifest: unknown = JSON.parse(
      Buffer.from(access.readFile(access.resolve(`${CATALOG_PACKAGE_NAME}/package.json`))).toString(
        "utf8",
      ),
    );
    const version = (manifest as { version?: unknown } | null)?.version;
    return typeof version === "string" ? bounded(version) : undefined;
  } catch {
    return undefined;
  }
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
      refusal: incompatible(
        `the installed ${CATALOG_PACKAGE_NAME} does not export ${missing.join(", ")} as functions`,
      ),
    };
  }
  let root: string;
  try {
    root = dirname(access.resolve(`${CATALOG_PACKAGE_NAME}/package.json`));
  } catch (error) {
    return {
      ok: false,
      refusal: incompatible(
        `the installed ${CATALOG_PACKAGE_NAME} does not publish ./package.json (${messageOf(error)})`,
      ),
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
            ? `the installed ${CATALOG_PACKAGE_NAME} does not export ${subpath}`
            : `the installed ${CATALOG_PACKAGE_NAME} could not resolve ${subpath} (${messageOf(error)})`,
        ),
      };
    }
    try {
      files[subpath] = Object.freeze({ path, bytes: Uint8Array.from(access.readFile(path)) });
    } catch (error) {
      return {
        ok: false,
        refusal: incompatible(
          `the installed ${CATALOG_PACKAGE_NAME} ${subpath} could not be read (${messageOf(error)})`,
        ),
      };
    }
  }
  const exports = {} as Record<string, unknown>;
  for (const name of names) exports[name] = (namespace as Record<string, unknown>)[name];
  return {
    ok: true,
    exports: exports as Pick<CatalogPackageFunctionsV1, K>,
    root,
    version: packageVersion(access),
    files: Object.freeze(files),
  };
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
