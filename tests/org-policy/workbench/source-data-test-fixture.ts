import { createHash } from "node:crypto";
import { canonicalStrictJsonSha256V1 } from "../../../src/contract/strict-json-v1.js";
import { verifyAuthoringCatalogBundleIntegrityV1 } from "../../../src/org-policy/workbench/catalog-integrity.js";
import type { WorkbenchPolicyBindingsV1 } from "../../../src/org-policy/workbench/compile-policy.js";
import {
  type AuthoringCatalogBundleV1,
  parseAuthoringCatalogBundleV1,
} from "../../../src/org-policy/workbench/contracts.js";
import type { PreparedWorkbenchCatalogV1 } from "../../../src/org-policy/workbench/prepared-catalog.js";

export const fixtureSourceId = "source:fixture-skills";
export const fixtureChangedAssetId = "fixture/skill:changed";
export const fixtureAssetId = "fixture/skill:source-data";
export const fixtureUnrelatedSourceId = "source:fixture-baseline";
export const fixtureUnrelatedAssetId = "fixture/baseline:unrelated";

const digest = (value: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function sealedBundle(): AuthoringCatalogBundleV1 {
  const changedDetail = JSON.stringify({ id: fixtureChangedAssetId, prepared: "fixture" });
  const externalDetail = JSON.stringify({ id: fixtureAssetId, prepared: "fixture" });
  const unrelatedDetail = JSON.stringify({ id: fixtureUnrelatedAssetId, prepared: "fixture" });
  const bare = {
    version: "authoring-catalog-bundle/v1" as const,
    sources: {
      [fixtureSourceId]: {
        id: fixtureSourceId,
        distributor: { kind: "git" as const, locator: "https://github.com/fixture/skills" },
        upstreamOrigin: { kind: "git" as const, locator: "https://github.com/fixture/skills" },
        inputFormat: "pinned-skill-collection/v1",
        revision: { id: "a".repeat(40), contentDigest: digest("fixture source revision") },
        compiler: { id: "pinned-skill-collection", version: "1" },
      },
      [fixtureUnrelatedSourceId]: {
        id: fixtureUnrelatedSourceId,
        distributor: { kind: "git" as const, locator: "https://github.com/fixture/baseline" },
        upstreamOrigin: { kind: "git" as const, locator: "https://github.com/fixture/baseline" },
        inputFormat: "pinned-baseline/v1",
        revision: { id: "b".repeat(40), contentDigest: digest("fixture unrelated revision") },
        compiler: { id: "pinned-baseline", version: "1" },
      },
    },
    assets: {
      [fixtureChangedAssetId]: {
        id: fixtureChangedAssetId,
        sourceId: fixtureSourceId,
        sourceRevisionId: "a".repeat(40),
        contentDigest: digest("fixture changed asset"),
        originalPath: "skills/changed/SKILL.md",
        derivation: "upstream" as const,
        kind: "skill",
        label: "Fixture changed skill",
        detailChunkId: "detail:fixture-changed",
        declaredHostCapabilities: [],
        authoring: { action: "record-selection" as const, supportedTargets: [] },
      },
      [fixtureAssetId]: {
        id: fixtureAssetId,
        sourceId: fixtureSourceId,
        sourceRevisionId: "a".repeat(40),
        contentDigest: digest("fixture source asset"),
        originalPath: "skills/source-data/SKILL.md",
        derivation: "upstream" as const,
        kind: "skill",
        label: "Fixture source-data skill",
        detailChunkId: "detail:fixture-source-data",
        declaredHostCapabilities: [],
        authoring: { action: "record-selection" as const, supportedTargets: [] },
      },
      [fixtureUnrelatedAssetId]: {
        id: fixtureUnrelatedAssetId,
        sourceId: fixtureUnrelatedSourceId,
        sourceRevisionId: "b".repeat(40),
        contentDigest: digest("fixture unrelated asset"),
        originalPath: "baseline/unrelated.md",
        derivation: "upstream" as const,
        kind: "baseline",
        label: "Fixture unrelated baseline",
        detailChunkId: "detail:fixture-unrelated",
        declaredHostCapabilities: [],
        authoring: { action: "record-selection" as const, supportedTargets: [] },
      },
    },
    groups: {},
    relations: [],
    templates: {},
    evidence: {},
    detailChunks: {
      "detail:fixture-changed": { bytes: changedDetail, digest: digest(changedDetail) },
      "detail:fixture-source-data": { bytes: externalDetail, digest: digest(externalDetail) },
      "detail:fixture-unrelated": { bytes: unrelatedDetail, digest: digest(unrelatedDetail) },
    },
  };
  const bundle = parseAuthoringCatalogBundleV1({
    ...bare,
    provenance: {
      bundleDigest: `sha256:${canonicalStrictJsonSha256V1({ ...bare, provenance: {} })}`,
    },
  });
  verifyAuthoringCatalogBundleIntegrityV1(bundle);
  return bundle;
}

const prototype: PreparedWorkbenchCatalogV1 = {
  catalog: {} as PreparedWorkbenchCatalogV1["catalog"],
  bundle: sealedBundle(),
  bindings: {
    [fixtureChangedAssetId]: { kind: "intent" },
    [fixtureAssetId]: { kind: "intent" },
    [fixtureUnrelatedAssetId]: { kind: "intent" },
  } satisfies WorkbenchPolicyBindingsV1,
  sourceInputs: {},
};

/** Test-only sealed catalog for source-store state transitions. */
export function tinySourceDataPreparedCatalogV1(): PreparedWorkbenchCatalogV1 {
  return structuredClone(prototype);
}
