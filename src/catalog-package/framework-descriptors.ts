import { createHash } from "node:crypto";
import { canonicalStrictJsonBytesV1 } from "../contract/strict-json-v1.js";
import {
  type CatalogPackageAccessV1,
  CatalogPackageRefusalError,
  type CatalogPackageRefusalV1,
  candidateCatalogActiveV1,
  loadCatalogPackageFileV1,
  loadCatalogPackageV1,
} from "./load-catalog-package.js";

export type CatalogFrameworkIdV1 = "ecc" | "superpowers";

export const ACCEPTED_CATALOG_FRAMEWORK_DESCRIPTOR_SHA256_V1 = Object.freeze({
  ecc: "cc723716e8749862d8e76769a0475d6e788c31c711d98c94e2c9c47695861f47",
  superpowers: "2a5e0b8f6fca6b89640200052ab17cd78e8c943aa24fbaf5bb1195591b19f61c",
} as const);

export type FrameworkDescriptorLoadV1 =
  | {
      readonly ok: true;
      readonly frameworkId: CatalogFrameworkIdV1;
      readonly bytes: Uint8Array;
      readonly sha256: string;
      readonly catalogVersion?: string;
    }
  | { readonly ok: false; readonly refusal: CatalogPackageRefusalV1 };

function incompatible(
  frameworkId: CatalogFrameworkIdV1,
  detail: string,
): { readonly ok: false; readonly refusal: CatalogPackageRefusalV1 } {
  return {
    ok: false,
    refusal: {
      reason: "catalog-package-incompatible",
      detail: `the installed @aihq/catalog ${frameworkId} framework descriptor ${detail}; this Core requires format aih-catalog-framework-descriptor version 1`,
    },
  };
}

function validDescriptor(value: unknown, frameworkId: CatalogFrameworkIdV1): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const descriptor = value as Record<string, unknown>;
  return (
    Object.keys(descriptor).length === 4 &&
    descriptor.format === "aih-catalog-framework-descriptor" &&
    descriptor.version === 1 &&
    descriptor.frameworkId === frameworkId &&
    descriptor.sections !== null &&
    typeof descriptor.sections === "object" &&
    !Array.isArray(descriptor.sections) &&
    Object.keys(descriptor.sections as Record<string, unknown>).length > 0
  );
}

export interface CatalogFrameworkDescriptorV1 {
  readonly format: "aih-catalog-framework-descriptor";
  readonly version: 1;
  readonly frameworkId: CatalogFrameworkIdV1;
  readonly sections: Readonly<Record<string, unknown>>;
}

const admittedFrameworkDescriptors = new Map<
  CatalogFrameworkIdV1,
  Readonly<CatalogFrameworkDescriptorV1>
>();

/** Synchronous companion for existing synchronous Core framework APIs. */
export function loadFrameworkDescriptorV1(
  frameworkId: CatalogFrameworkIdV1,
  access?: CatalogPackageAccessV1,
): CatalogFrameworkDescriptorV1 {
  const admitted = access === undefined ? admittedFrameworkDescriptors.get(frameworkId) : undefined;
  if (admitted !== undefined) return structuredClone(admitted);
  const subpath = `./catalog-framework-${frameworkId}.json` as const;
  const loaded = loadCatalogPackageFileV1(subpath, access);
  if (!loaded.ok) throw new CatalogPackageRefusalError(loaded.refusal);
  const sha256 = createHash("sha256").update(loaded.file.bytes).digest("hex");
  // An activated candidate's named digest stands in for Core's (internal preparation only).
  const candidate = access === undefined && candidateCatalogActiveV1();
  if (!candidate && sha256 !== ACCEPTED_CATALOG_FRAMEWORK_DESCRIPTOR_SHA256_V1[frameworkId]) {
    throw new CatalogPackageRefusalError(
      incompatible(frameworkId, `has unaccepted authority sha256 ${sha256}`).refusal,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(loaded.file.bytes),
    );
  } catch {
    throw new CatalogPackageRefusalError(incompatible(frameworkId, "is not JSON").refusal);
  }
  const canonical = Buffer.concat([canonicalStrictJsonBytesV1(value), Buffer.from("\n")]);
  if (!canonical.equals(Buffer.from(loaded.file.bytes)) || !validDescriptor(value, frameworkId)) {
    throw new CatalogPackageRefusalError(
      incompatible(frameworkId, "is non-canonical or malformed").refusal,
    );
  }
  const descriptor = structuredClone(value) as CatalogFrameworkDescriptorV1;
  if (access === undefined) admittedFrameworkDescriptors.set(frameworkId, descriptor);
  return structuredClone(descriptor);
}

/** Reads one required descriptor section and refuses instead of substituting embedded data. */
export function loadFrameworkDescriptorSectionV1<T>(
  frameworkId: CatalogFrameworkIdV1,
  section: string,
  access?: CatalogPackageAccessV1,
): T {
  const value = loadFrameworkDescriptorV1(frameworkId, access).sections[section];
  if (value === undefined) {
    throw new CatalogPackageRefusalError(
      incompatible(frameworkId, `does not contain required section ${section}`).refusal,
    );
  }
  return structuredClone(value) as T;
}

/**
 * Loads one framework descriptor only through the installed Catalog package,
 * admits only bytes whose SHA-256 Core accepts, asks Catalog's public reader to
 * validate them, and independently checks the Core-owned envelope before
 * exposing the exact bytes.
 */
export async function loadFrameworkDescriptorBytesV1(
  frameworkId: CatalogFrameworkIdV1,
  access?: CatalogPackageAccessV1,
): Promise<FrameworkDescriptorLoadV1> {
  const subpath = `./catalog-framework-${frameworkId}.json` as const;
  const loaded = await loadCatalogPackageV1(
    ["readCatalogFrameworkDescriptorV1Result"],
    [subpath],
    access,
  );
  if (!loaded.ok) return loaded;
  // Core keeps a private copy of the accepted bytes; the reader only ever sees another copy.
  const verified = Uint8Array.from(loaded.files[subpath].bytes);
  const sha256 = createHash("sha256").update(verified).digest("hex");
  if (sha256 !== ACCEPTED_CATALOG_FRAMEWORK_DESCRIPTOR_SHA256_V1[frameworkId]) {
    return incompatible(frameworkId, `has unaccepted authority sha256 ${sha256}`);
  }
  const handed = Uint8Array.from(verified);
  let read: unknown;
  try {
    read = loaded.exports.readCatalogFrameworkDescriptorV1Result({
      bytes: handed,
      frameworkId,
    });
  } catch {
    return incompatible(frameworkId, "reader threw");
  }
  if (createHash("sha256").update(handed).digest("hex") !== sha256) {
    return incompatible(frameworkId, "reader changed the descriptor bytes it validated");
  }
  if (read === null || typeof read !== "object" || Array.isArray(read)) {
    return incompatible(frameworkId, "reader returned a malformed result");
  }
  const result = read as Record<string, unknown>;
  if (result.state !== "read" || !validDescriptor(result.descriptor, frameworkId)) {
    return incompatible(frameworkId, "bytes were refused or malformed");
  }
  return {
    ok: true,
    frameworkId,
    bytes: Uint8Array.from(verified),
    sha256,
    ...(loaded.version === undefined ? {} : { catalogVersion: loaded.version }),
  };
}
