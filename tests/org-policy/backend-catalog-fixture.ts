import { createHash } from "node:crypto";
import { canonicalStrictJsonSha256V1 } from "../../src/contract/strict-json-v1.js";
import { ECC_HOOK_PROFILES } from "../../src/org-policy/ecc-hook-controls.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { verifyAuthoringCatalogBundleIntegrityV1 } from "../../src/org-policy/workbench/catalog-integrity.js";
import type { WorkbenchPolicyBindingsV1 } from "../../src/org-policy/workbench/compile-policy.js";
import {
  type AuthoringCatalogBundleV1,
  parseAuthoringCatalogBundleV1,
} from "../../src/org-policy/workbench/contracts.js";
import {
  compileOrganizationManifestAssemblyInputV1,
  extendCatalogBundleWithOrganizationInputsV1,
} from "../../src/org-policy/workbench/core/organization-catalog.js";
import {
  consumeFreshOrganizationPreparationV1,
  freshOrganizationPreparationSourceInputsV1,
} from "../../src/org-policy/workbench/core/organization-preparation.js";
import type {
  PreparedWorkbenchCatalogV1,
  PrepareWorkbenchCatalogOptionsV1,
} from "../../src/org-policy/workbench/prepared-catalog.js";

const digest = (bytes: Uint8Array | string): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const sourceId = "source:fixture-core";
const revisionId = "revision:fixture";
const assetIds = ["fixture:control", "fixture:external", "fixture:request"] as const;

function asset(
  id: (typeof assetIds)[number],
  action: "select-control" | "record-selection" | "record-request",
) {
  const detailChunkId = `detail:${id}`;
  const detailBytes = JSON.stringify({ id, prepared: "fixture" });
  return {
    asset: {
      id,
      sourceId,
      sourceRevisionId: revisionId,
      contentDigest: digest(`asset:${id}`),
      originalPath: "catalog.json",
      derivation: "built-in" as const,
      kind: action === "select-control" ? "hook" : action === "record-request" ? "mcp" : "skill",
      label: id,
      detailChunkId,
      declaredHostCapabilities: [],
      authoring:
        action === "select-control"
          ? {
              action,
              projectorId: "usage-hook" as const,
              supportedTargets: ["claude", "codex"],
            }
          : { action, supportedTargets: [] },
    },
    detailChunkId,
    detailBytes,
  };
}

function tinyBundle(): AuthoringCatalogBundleV1 {
  const entries = [
    asset("fixture:control", "select-control"),
    asset("fixture:external", "record-selection"),
    asset("fixture:request", "record-request"),
  ];
  const bareBundle = {
    version: "authoring-catalog-bundle/v1" as const,
    sources: {
      [sourceId]: {
        id: sourceId,
        distributor: { kind: "aih" as const, locator: "@aihq/fixture" },
        upstreamOrigin: { kind: "aih" as const, locator: "@aihq/fixture" },
        inputFormat: "built-in/v1",
        revision: { id: revisionId, contentDigest: digest("fixture revision") },
        compiler: { id: "built-in", version: "1" },
      },
    },
    assets: Object.fromEntries(entries.map(({ asset }) => [asset.id, asset])),
    groups: {
      "group:fixture": {
        id: "group:fixture",
        label: "Fixture catalog",
        assetIds: [...assetIds],
      },
    },
    relations: [],
    templates: {},
    evidence: {},
    detailChunks: Object.fromEntries(
      entries.map(({ detailChunkId, detailBytes }) => [
        detailChunkId,
        { bytes: detailBytes, digest: digest(detailBytes) },
      ]),
    ),
  };
  const bundle = parseAuthoringCatalogBundleV1({
    ...bareBundle,
    provenance: {
      bundleDigest: `sha256:${canonicalStrictJsonSha256V1({ ...bareBundle, provenance: {} })}`,
    },
  });
  verifyAuthoringCatalogBundleIntegrityV1(bundle);
  return bundle;
}

const fixtureFormCatalog = {
  hosts: [],
  externalMcp: [],
  eccMcpApproval: { sourceContentSha256: digest("fixture ecc mcp") },
  eccHookControls: {
    sourceContentSha256: digest("fixture hooks"),
    profiles: ECC_HOOK_PROFILES,
    hooks: [],
    disabledHooks: {
      availability: "supported",
      detail: "Fixture hook controls are not an installed or executed profile.",
      eligibleIds: [],
    },
  },
  frameworks: [{ id: "ecc", repository: "fixture/ecc", commit: "a".repeat(40) }],
};
function createTinyBackendCatalogFixturePrototype() {
  const workbenchBundle = tinyBundle();
  const workbenchBindings: WorkbenchPolicyBindingsV1 = {
    "fixture:control": {
      kind: "control",
      candidate: {
        id: "usage-metering",
        kind: "hook",
        description: "Fixture governed hook control",
        capabilities: [],
        risks: [],
        source: {
          type: "hook",
          handler: "usage-metering",
          scriptDigest: digest("fixture control script"),
        },
        targets: ["claude", "codex"],
        projector: "usage-hook",
        lifecycle: "supported",
        evidence: { record: "aih-usage-metering" },
        findings: [],
        autoExecute: false,
      },
    },
    "fixture:external": {
      kind: "external-selection",
      external: {
        owner: "ecc",
        item: {
          id: "fixture:external",
          kind: "skill",
          source: {
            repository: "fixture/catalog",
            commit: "a".repeat(40),
            path: "SKILL.md",
          },
        },
      },
    },
    "fixture:request": { kind: "intent" },
  };
  return {
    initialPolicy: parseOrgPolicy({
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "1",
        catalog: { reviewed: [], custom: [] },
        activations: [],
        authority: { approvals: [] },
        externalCuration: [],
        externalSelections: [],
      },
    }),
    workbenchBundle,
    workbenchBindings,
    workbenchSourceInputs: {},
    catalog: fixtureFormCatalog,
  };
}

// Verify once before handing callers independently mutable fixtures.
const verifiedTinyBackendCatalogFixturePrototype = createTinyBackendCatalogFixturePrototype();

/** Independently mutable backend policy and prepared-catalog fixture. */
export function tinyBackendCatalogFixture() {
  return structuredClone(verifiedTinyBackendCatalogFixturePrototype);
}

export function tinyEnterpriseBackendCatalogFixture() {
  const model = tinyBackendCatalogFixture();
  const governance = model.initialPolicy.governance;
  if (governance === undefined) throw new Error("expected default studio governance");
  model.initialPolicy.minimumPosture = "enterprise";
  governance.supportedClis = ["codex"];
  return model;
}

function sourceInputsForOrganizationManifestV1(manifestBytes: string) {
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
                kind: "organization-manifest" as const,
                sourceId: source.id,
                sourceRevisionId: source.revision.id,
                inputFormat: "organization-authoring-manifest/v1" as const,
                digest: source.revision.contentDigest,
                byteLength,
                bytesBase64,
              },
            ],
          ],
    ),
  );
}

/**
 * Test-only generic baseline. Organization declaration and fresh witness
 * assemblies still pass through their production compilers and opaque custody.
 */
export function prepareTinyWorkbenchCatalogV1(
  _catalog?: unknown,
  options: Pick<
    PrepareWorkbenchCatalogOptionsV1,
    "organizationManifestBytes" | "freshOrganizationPreparations"
  > = {},
): PreparedWorkbenchCatalogV1 {
  const manifests = options.organizationManifestBytes ?? [];
  const fresh = options.freshOrganizationPreparations ?? [];
  for (const preparation of fresh) {
    if (consumeFreshOrganizationPreparationV1(preparation) === undefined)
      throw new TypeError("fixture fresh preparation custody is unavailable");
  }
  const model = tinyBackendCatalogFixture();
  const bundle = extendCatalogBundleWithOrganizationInputsV1(
    model.workbenchBundle,
    manifests,
    fresh,
  );
  const sourceInputs = Object.assign(
    {},
    ...manifests.map(sourceInputsForOrganizationManifestV1),
    ...fresh.map((preparation) => {
      const source = freshOrganizationPreparationSourceInputsV1(preparation);
      if (source === undefined)
        throw new TypeError("fixture fresh source input custody is unavailable");
      return source;
    }),
  );
  return {
    catalog: model.catalog as unknown as PreparedWorkbenchCatalogV1["catalog"],
    bundle,
    bindings: {
      ...model.workbenchBindings,
      ...Object.fromEntries(
        Object.keys(bundle.assets)
          .filter((assetId) => model.workbenchBindings[assetId] === undefined)
          .map((assetId) => [assetId, { kind: "intent" }]),
      ),
    },
    sourceInputs,
  };
}
