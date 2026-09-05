import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalStrictJsonSha256V1 } from "../../src/contract/strict-json-v1.js";
import { ECC_HOOK_PROFILES } from "../../src/org-policy/ecc-hook-controls.js";
import { POLICY_APPROVER_EMAIL_PATTERN } from "../../src/org-policy/ecc-mcp-approval.js";
import {
  DISPOSITIONABLE_POLICY_FINDING_CODES,
  FENCED_POLICY_PREREQUISITE_CODES,
  UNWAIVABLE_POLICY_DANGER_CODES,
} from "../../src/org-policy/finding-codes.js";
import { GovernanceDecisionV1Schema } from "../../src/org-policy/governance-decision-v1.js";
import {
  HTTPS_ORIGIN_ARGUMENT_PREFIXES,
  OrgPolicySchema,
  POLICY_HTTPS_ORIGIN_PATTERN,
  PolicyBundleSchema,
  parseOrgPolicy,
} from "../../src/org-policy/schema.js";
import type { PolicyStudioModel } from "../../src/org-policy/studio-model.js";
import { verifyAuthoringCatalogBundleIntegrityV1 } from "../../src/org-policy/workbench/catalog-integrity.js";
import type { WorkbenchPolicyBindingsV1 } from "../../src/org-policy/workbench/compile-policy.js";
import {
  type AuthoringCatalogBundleV1,
  parseAuthoringCatalogBundleV1,
} from "../../src/org-policy/workbench/contracts.js";

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

const fixtureAdoptionRecipe = {
  roles: [],
  sources: {
    eccMcpSelected: [],
    eccMcpDisabled: [],
    serenaAllowedTools: [],
    eccMcpCatalogIds: [],
    eccMcpCatalog: [],
    coreMcpIds: [],
  },
} as PolicyStudioModel["adoptionRecipe"];
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
} satisfies PolicyStudioModel["catalog"];
function createTinyStudioModelPrototype(): PolicyStudioModel {
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

    adoptionRecipe: fixtureAdoptionRecipe,
    schema: z.toJSONSchema(OrgPolicySchema, { io: "input" }) as Record<string, unknown>,
    protectedBundleSchema: z.toJSONSchema(PolicyBundleSchema, {
      io: "input",
    }) as Record<string, unknown>,
    decisionSchema: z.toJSONSchema(GovernanceDecisionV1Schema, {
      io: "input",
    }) as Record<string, unknown>,
    unwaivable: UNWAIVABLE_POLICY_DANGER_CODES,
    findings: {
      dispositionable: DISPOSITIONABLE_POLICY_FINDING_CODES,
      fenced: FENCED_POLICY_PREREQUISITE_CODES,
    },
    semantics: {
      httpsOriginArgumentPrefixes: HTTPS_ORIGIN_ARGUMENT_PREFIXES,
      httpsOriginPattern: POLICY_HTTPS_ORIGIN_PATTERN,
      approverEmailPattern: POLICY_APPROVER_EMAIL_PATTERN,
    },
  };
}

// Verify once before handing callers independently mutable fixtures.
const verifiedTinyStudioModelPrototype = createTinyStudioModelPrototype();

export function tinyStudioModel(): PolicyStudioModel {
  return structuredClone(verifiedTinyStudioModelPrototype);
}

export function tinyEnterpriseStudioModel(): PolicyStudioModel {
  const model = tinyStudioModel();
  const governance = model.initialPolicy.governance;
  if (governance === undefined) throw new Error("expected default studio governance");
  model.initialPolicy.minimumPosture = "enterprise";
  governance.supportedClis = ["codex"];
  return model;
}
