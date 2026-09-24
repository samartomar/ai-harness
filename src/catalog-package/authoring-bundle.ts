import { canonicalStrictJsonBytesV1 } from "../contract/strict-json-v1.js";
import { verifyAuthoringCatalogBundleIntegrityV1 } from "../org-policy/workbench/catalog-integrity.js";
import { AuthoringCatalogBundleV1Schema } from "../org-policy/workbench/contracts.js";
import type { PreparedWorkbenchCatalogV1 } from "../org-policy/workbench/prepared-catalog.js";
import {
  ACCEPTED_CATALOG_AUTHORING_AUTHORITY_V1,
  catalogAuthoringAuthorityDigestV1,
  deriveWorkbenchPolicyBindingsV1,
  PolicyAuthoringCatalogCarrierV1Schema,
  WorkbenchSourceInputsCarrierV1Schema,
} from "./authoring-authority.js";
import {
  type CatalogPackageAccessV1,
  CatalogPackageRefusalError,
  candidateCatalogActiveV1,
  loadCatalogPackageFileV1,
} from "./load-catalog-package.js";

export interface LoadedCatalogAuthoringBundleV1 {
  readonly prepared: PreparedWorkbenchCatalogV1;
  readonly catalogVersion?: string;
  readonly sourceRecords: readonly { readonly bytes: string; readonly sha256: string }[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function incompatible(detail: string): never {
  throw new CatalogPackageRefusalError({
    reason: "catalog-package-incompatible",
    detail: `the installed @aihq/catalog authoring bundle ${detail}`,
  });
}

function parse(
  bytes: Uint8Array,
  candidate: boolean,
): LoadedCatalogAuthoringBundleV1["prepared"] & {
  readonly sourceRecords: LoadedCatalogAuthoringBundleV1["sourceRecords"];
} {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return incompatible("is not JSON");
  }
  if (!object(value)) return incompatible("is not an object");
  let canonical: Buffer;
  try {
    canonical = Buffer.concat([canonicalStrictJsonBytesV1(value), Buffer.from("\n")]);
  } catch {
    return incompatible("is not canonical strict JSON");
  }
  if (!canonical.equals(Buffer.from(bytes))) return incompatible("is not canonical strict JSON");
  if (
    Object.keys(value).length !== 5 ||
    value.format !== "aih-catalog-authoring-bundle" ||
    value.version !== 1 ||
    !object(value.prepared) ||
    !Array.isArray(value.sourceRecords) ||
    !object(value.production)
  ) {
    return incompatible("has an unsupported envelope");
  }
  const prepared = value.prepared;
  if (
    Object.keys(prepared).length !== 4 ||
    !object(prepared.catalog) ||
    !object(prepared.bindings) ||
    !object(prepared.sourceInputs)
  ) {
    return incompatible("has malformed prepared data");
  }
  let bundle: PreparedWorkbenchCatalogV1["bundle"];
  let catalog: PreparedWorkbenchCatalogV1["catalog"];
  let sourceInputs: PreparedWorkbenchCatalogV1["sourceInputs"];
  try {
    bundle = AuthoringCatalogBundleV1Schema.parse(prepared.bundle);
    verifyAuthoringCatalogBundleIntegrityV1(bundle);
    catalog = PolicyAuthoringCatalogCarrierV1Schema.parse(
      prepared.catalog,
    ) as unknown as PreparedWorkbenchCatalogV1["catalog"];
    sourceInputs = WorkbenchSourceInputsCarrierV1Schema.parse(prepared.sourceInputs);
  } catch {
    return incompatible("has malformed catalog, source inputs, or an unsealed authoring bundle");
  }
  const authorityDigest = catalogAuthoringAuthorityDigestV1({ catalog, bundle, sourceInputs });
  if (!candidate && !ACCEPTED_CATALOG_AUTHORING_AUTHORITY_V1.includes(authorityDigest as never)) {
    return incompatible(`carries unaccepted authority sha256 ${authorityDigest}`);
  }
  const sourceRecords = value.sourceRecords.map((item) => {
    if (
      !object(item) ||
      Object.keys(item).length !== 2 ||
      typeof item.bytes !== "string" ||
      typeof item.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.sha256)
    ) {
      return incompatible("has a malformed source record");
    }
    return { bytes: item.bytes, sha256: item.sha256 };
  });
  return {
    catalog,
    bundle,
    bindings: deriveWorkbenchPolicyBindingsV1(catalog, bundle),
    sourceInputs,
    sourceRecords,
  };
}

/** Loads and validates Catalog's prepared authoring data without an embedded fallback. */
export function loadCatalogAuthoringBundleV1(
  access?: CatalogPackageAccessV1,
): LoadedCatalogAuthoringBundleV1 {
  const loaded = loadCatalogPackageFileV1("./catalog-authoring-bundle.json", access);
  if (!loaded.ok) throw new CatalogPackageRefusalError(loaded.refusal);
  // An activated candidate's named digest stands in for Core's (internal preparation only).
  const { sourceRecords, ...prepared } = parse(
    loaded.file.bytes,
    access === undefined && candidateCatalogActiveV1(),
  );
  return {
    prepared: structuredClone(prepared),
    sourceRecords: structuredClone(sourceRecords),
    ...(loaded.version === undefined ? {} : { catalogVersion: loaded.version }),
  };
}
