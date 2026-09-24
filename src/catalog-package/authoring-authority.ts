import { z } from "zod";
import { canonicalStrictJsonSha256V1 } from "../contract/strict-json-v1.js";
import type { PolicyAuthoringCatalog } from "../org-policy/catalog.js";
import type { WorkbenchPolicyBindingsV1 } from "../org-policy/workbench/compile-policy.js";
import {
  type AuthoringCatalogBundleV1,
  WorkbenchAuthoringSourceV1Schema,
  type WorkbenchSourceInputsV1,
} from "../org-policy/workbench/contracts.js";

const CatalogRecordSchema = z.record(z.string(), z.unknown());

/**
 * Carrier schema only. Authority comes from the Core-owned digest below; this
 * schema prevents malformed admitted bytes from reaching policy code.
 */
export const PolicyAuthoringCatalogCarrierV1Schema = z
  .object({
    aihAgents: z.array(CatalogRecordSchema),
    aihCapabilityCatalog: CatalogRecordSchema,
    aihCapabilityPackage: CatalogRecordSchema,
    aihMcpRequestIds: z.array(z.string()),
    aihSkills: z.array(CatalogRecordSchema),
    eccHookControls: CatalogRecordSchema,
    eccMcpApproval: CatalogRecordSchema,
    eccMcpInventory: z.array(CatalogRecordSchema),
    eccMcpProvenance: CatalogRecordSchema,
    eccSkills: z.array(CatalogRecordSchema),
    eccSkillsProvenance: CatalogRecordSchema,
    enterpriseComposition: CatalogRecordSchema,
    externalMcp: z.array(CatalogRecordSchema),
    frameworks: z.array(CatalogRecordSchema),
    hookRegistry: CatalogRecordSchema,
    hooks: z.array(CatalogRecordSchema),
    hosts: z.array(CatalogRecordSchema),
    mcp: z.array(CatalogRecordSchema),
    nonProjectableMcp: z.array(CatalogRecordSchema),
    unavailableMcp: z.array(CatalogRecordSchema),
  })
  .strict();

export const WorkbenchSourceInputsCarrierV1Schema = z
  .record(z.string(), WorkbenchAuthoringSourceV1Schema)
  .superRefine((inputs, context) => {
    for (const [sourceId, source] of Object.entries(inputs)) {
      if (source.sourceId !== sourceId) {
        context.addIssue({
          code: "custom",
          path: [sourceId, "sourceId"],
          message: "Source input key must match sourceId.",
        });
      }
    }
  });

/** Exact producer output reviewed with Core 0.7; Catalog is only its carrier. */
export const ACCEPTED_CATALOG_AUTHORING_AUTHORITY_V1 = Object.freeze([
  "baefbf771cdb08c9e5b0429b65142524701e4d0f6b013be12baed1c454d33d31",
] as const);

export function catalogAuthoringAuthorityDigestV1(input: {
  readonly catalog: PolicyAuthoringCatalog;
  readonly bundle: AuthoringCatalogBundleV1;
  readonly sourceInputs: WorkbenchSourceInputsV1;
}): string {
  return canonicalStrictJsonSha256V1({
    catalog: input.catalog,
    bundle: input.bundle,
    sourceInputs: input.sourceInputs,
  });
}

const LEGACY_REQUEST_ORDER = Object.freeze([
  "github",
  "sequential-thinking",
  "context7",
  "playwright",
] as const);

/** Core policy logic: derive capabilities from admitted, pin-bound declarations. */
export function deriveWorkbenchPolicyBindingsV1(
  catalog: PolicyAuthoringCatalog,
  bundle: AuthoringCatalogBundleV1,
): WorkbenchPolicyBindingsV1 {
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
          item: { id: item.id, kind: item.kind, source: structuredClone(item.source) },
        },
      };
    }
  }
  // A sealed pinned-baseline source may carry another exact framework revision
  // than the catalog's current layout; its assets bind to their own admitted
  // repository, revision and path, never to the current pin.
  for (const asset of Object.values(bundle.assets)) {
    const source = bundle.sources[asset.sourceId];
    const owner = asset.sourceId.slice("source:".length);
    if (
      asset.derivation !== "upstream" ||
      source?.inputFormat !== "pinned-baseline/v1" ||
      source.upstreamOrigin.kind !== "git" ||
      (owner !== "ecc" && owner !== "superpowers") ||
      !asset.id.startsWith(`${owner}/`)
    )
      continue;
    bindings[asset.id] = {
      kind: "external-selection",
      external: {
        owner,
        item: {
          id: asset.id.slice(owner.length + 1),
          kind: asset.kind,
          source: {
            repository: source.upstreamOrigin.locator,
            commit: asset.sourceRevisionId,
            path: asset.originalPath,
          },
        },
      },
    };
  }
  for (const item of [...catalog.aihSkills, ...catalog.aihAgents]) {
    bindings[`aih/${item.id}`] = {
      kind: "package-root",
      packageRoot: { catalogRepository: catalog.aihCapabilityCatalog.repository, root: item.id },
    };
  }
  const requestIds = new Set<string>(catalog.aihMcpRequestIds);
  const requestOrder = new Map(LEGACY_REQUEST_ORDER.map((id, index) => [id, index]));
  for (const item of [...catalog.unavailableMcp, ...catalog.nonProjectableMcp]) {
    const assetId = `aih/${item.id}`;
    if (requestIds.has(item.id) && bundle.assets[assetId]?.authoring.action === "record-request") {
      const order = requestOrder.get(item.id as (typeof LEGACY_REQUEST_ORDER)[number]);
      if (order === undefined) throw new TypeError(`unsupported AIH request id ${item.id}`);
      bindings[assetId] = {
        kind: "intent",
        legacyRequestId: item.id,
        legacyRequestOrder: order,
      };
    }
  }
  for (const asset of Object.values(bundle.assets)) bindings[asset.id] ??= { kind: "intent" };
  return bindings;
}
