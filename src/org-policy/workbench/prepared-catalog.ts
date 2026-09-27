import { loadCatalogAuthoringBundleV1 } from "../../catalog-package/authoring-bundle.js";
import {
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
} from "../../contract/strict-json-v1.js";
import { type PolicyAuthoringCatalog, policyAuthoringCatalog } from "../catalog.js";
import type { WorkbenchPolicyBindingsV1 } from "./compile-policy.js";
import type {
  AuthoringCatalogBundleV1,
  WorkbenchAuthoringSourceV1,
  WorkbenchSourceInputsV1,
} from "./contracts.js";
import {
  compileOrganizationManifestAssemblyInputV1,
  extendCatalogBundleWithOrganizationInputsV1,
} from "./core/organization-catalog.js";
import {
  type FreshOrganizationPreparationV1,
  freshOrganizationPreparationSourceInputsV1,
} from "./core/organization-preparation.js";
import { applyWorkbenchSourceDataV1 } from "./core/source-data.js";

/** Offline organization manifests accepted by Core preparation, never by a browser shell. */
export interface PrepareWorkbenchCatalogOptionsV1 {
  organizationManifestBytes?: readonly string[];
  freshOrganizationPreparations?: readonly FreshOrganizationPreparationV1[];
  sourceDataPins?: readonly {
    assetId: string;
    sourceId: string;
    sourceRevisionId: string;
    contentDigest: string;
  }[];
  /** Retained for callers staging package data; Catalog already carries the packaged baseline. */
  packageDataOnly?: boolean;
}

export interface PreparedWorkbenchCatalogV1 {
  catalog: PolicyAuthoringCatalog;
  bundle: AuthoringCatalogBundleV1;
  bindings: WorkbenchPolicyBindingsV1;
  sourceInputs: WorkbenchSourceInputsV1;
}

let packaged: Readonly<PreparedWorkbenchCatalogV1> | undefined;

function manifestSourceInputsV1(manifestBytes: string): WorkbenchSourceInputsV1 {
  const assembly = compileOrganizationManifestAssemblyInputV1(manifestBytes);
  const byteLength = Buffer.byteLength(manifestBytes, "utf8");
  const bytesBase64 = Buffer.from(manifestBytes, "utf8").toString("base64");
  return Object.fromEntries(
    Object.values(assembly.sources).flatMap((source) =>
      !source.policyInputRequired
        ? []
        : [
            [
              source.id,
              {
                kind: "organization-manifest",
                sourceId: source.id,
                sourceRevisionId: source.revision.id,
                inputFormat: "organization-authoring-manifest/v1",
                digest: source.revision.contentDigest,
                byteLength,
                bytesBase64,
              } satisfies WorkbenchAuthoringSourceV1,
            ],
          ],
    ),
  );
}

function mergeSourceInputsV1(inputs: readonly WorkbenchSourceInputsV1[]): WorkbenchSourceInputsV1 {
  const merged: Record<string, WorkbenchAuthoringSourceV1> = {};
  for (const input of inputs) {
    for (const [sourceId, source] of Object.entries(input)) {
      if (merged[sourceId] !== undefined)
        throw new TypeError(`duplicate workbench source input ${sourceId}`);
      merged[sourceId] = source;
    }
  }
  return merged;
}

export function packagedPreparedWorkbenchCatalogV1(): PreparedWorkbenchCatalogV1 {
  packaged ??= deepFreezeStrictJsonV1(
    loadCatalogAuthoringBundleV1().prepared,
  ) as Readonly<PreparedWorkbenchCatalogV1>;
  return structuredClone(packaged);
}

/**
 * Core never rebuilds Catalog's baseline. It may add organization-authored
 * manifests and witnessed organization evidence to the admitted baseline.
 */
export function prepareWorkbenchCatalog(
  catalog: PolicyAuthoringCatalog = policyAuthoringCatalog(),
  options: PrepareWorkbenchCatalogOptionsV1 = {},
): PreparedWorkbenchCatalogV1 {
  const baseline = packagedPreparedWorkbenchCatalogV1();
  if (canonicalStrictJsonSha256V1(catalog) !== canonicalStrictJsonSha256V1(baseline.catalog)) {
    throw new TypeError("Core cannot compile a replacement Catalog-owned baseline");
  }
  const manifests = options.organizationManifestBytes ?? [];
  const preparations = options.freshOrganizationPreparations ?? [];
  if (manifests.length === 0 && preparations.length === 0) {
    return options.packageDataOnly
      ? baseline
      : applyWorkbenchSourceDataV1(baseline, { pins: options.sourceDataPins });
  }
  const bundle = extendCatalogBundleWithOrganizationInputsV1(
    baseline.bundle,
    manifests,
    preparations,
  );
  const sourceInputs = mergeSourceInputsV1([
    baseline.sourceInputs,
    ...manifests.map(manifestSourceInputsV1),
    ...preparations.map((preparation) => {
      const inputs = freshOrganizationPreparationSourceInputsV1(preparation);
      if (inputs === undefined)
        throw new TypeError("fresh organization preparation custody is unavailable");
      return inputs;
    }),
  ]);
  const bindings = structuredClone(baseline.bindings);
  for (const assetId of Object.keys(bundle.assets)) bindings[assetId] ??= { kind: "intent" };
  const prepared = { catalog: baseline.catalog, bundle, bindings, sourceInputs };
  return options.packageDataOnly
    ? prepared
    : applyWorkbenchSourceDataV1(prepared, { pins: options.sourceDataPins });
}

export function defaultPreparedWorkbenchCatalog(): PreparedWorkbenchCatalogV1 {
  return prepareWorkbenchCatalog();
}
