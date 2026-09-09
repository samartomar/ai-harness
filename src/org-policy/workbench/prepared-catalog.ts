import {
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
} from "../../contract/strict-json-v1.js";
import { type PolicyAuthoringCatalog, policyAuthoringCatalog } from "../catalog.js";
import { AIH_OWNED_ECC_MCP_EXCLUSIONS } from "../ecc-mcp-catalog.js";
import {
  compileOrganizationManifestAssemblyInputV1,
  policyAuthoringCatalogBundle,
  policyAuthoringCatalogBundleWithOrganizationInputsV1,
  policyAuthoringCatalogBundleWithOrganizationManifestsV1,
} from "./catalog-bundle.js";
import type { WorkbenchPolicyBindingsV1 } from "./compile-policy.js";
import type {
  AuthoringCatalogBundleV1,
  WorkbenchAuthoringSourceV1,
  WorkbenchSourceInputsV1,
} from "./contracts.js";
import {
  type FreshOrganizationPreparationV1,
  freshOrganizationPreparationSourceInputsV1,
} from "./core/organization-preparation.js";
import { applyPackagedWorkbenchSourceDataV1 } from "./core/packaged-source-data.js";
import { applyWorkbenchSourceDataV1 } from "./core/source-data.js";
import { packagedDefaultCatalogPreassemblyV1 } from "./default-catalog-preassembly.js";

/** Offline organization manifests accepted by Core preparation, never by the browser shell. */
export interface PrepareWorkbenchCatalogOptionsV1 {
  organizationManifestBytes?: readonly string[];
  freshOrganizationPreparations?: readonly FreshOrganizationPreparationV1[];
  sourceDataPins?: readonly {
    assetId: string;
    sourceId: string;
    sourceRevisionId: string;
    contentDigest: string;
  }[];
  /** Internal package preparation only; never an external trust bypass. */
  packageDataOnly?: boolean;
}

export interface PreparedWorkbenchCatalogV1 {
  catalog: PolicyAuthoringCatalog;
  bundle: AuthoringCatalogBundleV1;
  bindings: WorkbenchPolicyBindingsV1;
  sourceInputs: WorkbenchSourceInputsV1;
}

const MAX_PREPARED_BASELINE_CACHE_ENTRIES = 4;
const preparedBaselineByDigest = new Map<string, Readonly<PreparedWorkbenchCatalogV1>>();
let prepared: PreparedWorkbenchCatalogV1 | undefined;
let preparedCatalogDigest: string | undefined;

function cachePreparedBaselineV1(
  digest: string,
  value: PreparedWorkbenchCatalogV1,
): Readonly<PreparedWorkbenchCatalogV1> {
  const snapshot = deepFreezeStrictJsonV1(structuredClone(value));
  preparedBaselineByDigest.delete(digest);
  preparedBaselineByDigest.set(digest, snapshot);
  if (preparedBaselineByDigest.size > MAX_PREPARED_BASELINE_CACHE_ENTRIES) {
    const oldest = preparedBaselineByDigest.keys().next().value;
    if (oldest !== undefined) preparedBaselineByDigest.delete(oldest);
  }
  return snapshot;
}

function cachedPreparedBaselineV1(
  digest: string,
): Readonly<PreparedWorkbenchCatalogV1> | undefined {
  const cached = preparedBaselineByDigest.get(digest);
  if (cached === undefined) return undefined;
  preparedBaselineByDigest.delete(digest);
  preparedBaselineByDigest.set(digest, cached);
  return cached;
}

function sourceInputsForManifestV1(manifestBytes: string): WorkbenchSourceInputsV1 {
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
/** Core-owned compatibility bindings, assembled before the offline shell runs. */
export function prepareWorkbenchCatalog(
  catalog: PolicyAuthoringCatalog = policyAuthoringCatalog(),
  options: PrepareWorkbenchCatalogOptionsV1 = {},
): PreparedWorkbenchCatalogV1 {
  const organizationManifestBytes = options.organizationManifestBytes ?? [];
  const freshOrganizationPreparations = options.freshOrganizationPreparations ?? [];
  if (organizationManifestBytes.length === 0 && freshOrganizationPreparations.length === 0) {
    // Consumption often supplies the catalog from an already admitted package.
    // Reuse only that exact catalog and matching package pins; historical pins
    // and custom catalogs retain the complete reconstruction path below.
    if (prepared !== undefined) {
      const packageSnapshot = prepared;
      preparedCatalogDigest ??= canonicalStrictJsonSha256V1(packageSnapshot.catalog);
      if (
        canonicalStrictJsonSha256V1(catalog) === preparedCatalogDigest &&
        (options.sourceDataPins ?? []).every((pin) => {
          const asset = packageSnapshot.bundle.assets[pin.assetId];
          return (
            asset?.sourceId === pin.sourceId &&
            asset.sourceRevisionId === pin.sourceRevisionId &&
            asset.contentDigest === pin.contentDigest
          );
        })
      ) {
        return options.packageDataOnly
          ? structuredClone(packageSnapshot)
          : applyWorkbenchSourceDataV1(packageSnapshot, { pins: options.sourceDataPins });
      }
    }
    return finishPreparedCatalogV1(structuredClone(preparedBaselineSnapshotV1(catalog)), options);
  }
  return finishPreparedCatalogV1(
    prepareCatalogV1(catalog, organizationManifestBytes, freshOrganizationPreparations),
    options,
  );
}

/** A privately held frozen baseline is cloned before public preparation callers can receive it. */
function preparedBaselineSnapshotV1(
  catalog: PolicyAuthoringCatalog,
): Readonly<PreparedWorkbenchCatalogV1> {
  const baselineDigest = canonicalStrictJsonSha256V1(catalog);
  const cached = cachedPreparedBaselineV1(baselineDigest);
  if (cached !== undefined) return cached;
  return cachePreparedBaselineV1(baselineDigest, prepareCatalogV1(catalog, [], []));
}

function prepareCatalogV1(
  catalog: PolicyAuthoringCatalog,
  organizationManifestBytes: readonly string[],
  freshOrganizationPreparations: readonly FreshOrganizationPreparationV1[],
): PreparedWorkbenchCatalogV1 {
  const bundle =
    freshOrganizationPreparations.length > 0
      ? policyAuthoringCatalogBundleWithOrganizationInputsV1(
          organizationManifestBytes,
          freshOrganizationPreparations,
          catalog,
        )
      : organizationManifestBytes.length === 0
        ? policyAuthoringCatalogBundle(catalog)
        : policyAuthoringCatalogBundleWithOrganizationManifestsV1(
            organizationManifestBytes,
            catalog,
          );
  const sourceInputs = mergeSourceInputsV1([
    ...organizationManifestBytes.map(sourceInputsForManifestV1),
    ...freshOrganizationPreparations.map((preparation) => {
      const sourceInputs = freshOrganizationPreparationSourceInputsV1(preparation);
      if (sourceInputs === undefined)
        throw new TypeError("fresh organization preparation custody is unavailable");
      return sourceInputs;
    }),
  ]);
  const bindings: WorkbenchPolicyBindingsV1 = {};
  for (const item of [...catalog.mcp, ...catalog.hooks]) {
    const control = item.control;
    const id = `aih/${control.id}`;
    if (bundle.assets[id]?.authoring.action !== "select-control") continue;
    bindings[id] = {
      kind: "control",
      candidate: {
        id: control.id,
        kind: control.kind,
        description: "AIH-provided governed control",
        capabilities: [],
        risks: [],
        source: structuredClone(control.source),
        targets: [...control.targets],
        projector: control.projector,
        lifecycle: control.lifecycle,
        evidence: { record: `aih-${control.id}` },
        findings: [],
        autoExecute: false,
      },
    };
  }
  for (const source of catalog.frameworks) {
    for (const item of source.assets) {
      bindings[`${source.id}/${item.id}`] = {
        kind: "external-selection",
        external: {
          owner: source.id,
          item: {
            id: item.id,
            kind: item.kind,
            source: structuredClone(item.source),
          },
        },
      };
    }
  }
  for (const item of [...catalog.aihSkills, ...catalog.aihAgents]) {
    bindings[`aih/${item.id}`] = {
      kind: "package-root",
      packageRoot: { catalogRepository: catalog.aihCapabilityCatalog.repository, root: item.id },
    };
  }
  const legacyRequestIds = new Set<string>(catalog.aihMcpRequestIds);
  const legacyRequestOrder = new Map(AIH_OWNED_ECC_MCP_EXCLUSIONS.map((id, index) => [id, index]));
  for (const item of [...catalog.unavailableMcp, ...catalog.nonProjectableMcp]) {
    const assetId = `aih/${item.id}`;
    if (
      legacyRequestIds.has(item.id) &&
      bundle.assets[assetId]?.authoring.action === "record-request"
    ) {
      const canonicalId = AIH_OWNED_ECC_MCP_EXCLUSIONS.find((id) => id === item.id);
      if (canonicalId === undefined)
        throw new Error(`missing canonical AIH request order for ${item.id}`);
      const order = legacyRequestOrder.get(canonicalId);
      if (order === undefined)
        throw new Error(`missing canonical AIH request order for ${item.id}`);
      bindings[assetId] = { kind: "intent", legacyRequestId: item.id, legacyRequestOrder: order };
    }
  }
  // Organization compiler output cannot carry Core capabilities, so its assets remain intent-only.
  for (const asset of Object.values(bundle.assets)) bindings[asset.id] ??= { kind: "intent" };
  return { catalog, bundle, bindings, sourceInputs };
}

function finishPreparedCatalogV1(
  base: PreparedWorkbenchCatalogV1,
  options: PrepareWorkbenchCatalogOptionsV1,
) {
  const packaged = applyPackagedWorkbenchSourceDataV1(base, options.sourceDataPins);
  return options.packageDataOnly
    ? packaged
    : applyWorkbenchSourceDataV1(packaged, { pins: options.sourceDataPins });
}

/** Pinned package data is normalized once per Core process; callers receive a copy. */
export function defaultPreparedWorkbenchCatalog(): PreparedWorkbenchCatalogV1 {
  return applyWorkbenchSourceDataV1(packagedPreparedWorkbenchCatalogV1());
}

export function packagedPreparedWorkbenchCatalogV1(): PreparedWorkbenchCatalogV1 {
  // This process-private consumer can apply sealed package records directly to the frozen cache
  // snapshot. Its result is cloned before it leaves this module, so callers never receive cache
  // authority or a shared mutable object.
  prepared ??= deepFreezeStrictJsonV1(
    structuredClone(
      packagedDefaultCatalogPreassemblyV1() ?? compilePackagedWorkbenchCatalogForBuildV1(),
    ),
  ) as PreparedWorkbenchCatalogV1;
  return structuredClone(prepared);
}

/** Package build only: bypasses every process cache before staging a sealed companion. */
export function compilePackagedWorkbenchCatalogForBuildV1(): PreparedWorkbenchCatalogV1 {
  return finishPreparedCatalogV1(prepareCatalogV1(policyAuthoringCatalog(), [], []), {
    packageDataOnly: true,
  });
}
