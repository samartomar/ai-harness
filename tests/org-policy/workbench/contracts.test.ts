import { expect, it } from "vitest";
import {
  AuthoringAssetV1Schema,
  type AuthoringCatalogBundleV1,
  AuthoringCatalogBundleV1Schema,
  assembleAuthoringAssetV1,
  CompilerAssetDeclarationV1Schema,
} from "../../../src/org-policy/workbench/contracts.js";
import { fixture } from "./authoring-fixture.js";

const digest = "sha256:" + "a".repeat(64);
function catalog() {
  const { bundle } = fixture();
  bundle.sources["source:test"] = {
    id: "source:test",
    distributor: { kind: "organization", locator: "acme/catalog" },
    upstreamOrigin: { kind: "organization", locator: "acme/catalog" },
    inputFormat: "synthetic/v1",
    revision: { id: "revision:1", contentDigest: digest },
    compiler: { id: "test", version: "1" },
  };
  for (const asset of Object.values(bundle.assets))
    bundle.detailChunks[asset.detailChunkId] = { bytes: "{}", digest };
  bundle.groups.group = { id: "group", label: "Group", assetIds: ["external", "other"] };
  bundle.templates.template = {
    id: "template",
    digest,
    roots: [{ assetId: "external", mode: "select", includeOptionalMembers: false }],
    exclusions: ["package"],
  };
  bundle.relations = [{ fromAssetId: "external", toAssetId: "other", kind: "requires" }];
  const asset = bundle.assets.external!;
  bundle.evidence.evidence = {
    id: "evidence",
    projectionVersion: "evidence-summary/v1",
    subjects: [
      {
        assetId: asset.id,
        sourceId: asset.sourceId,
        sourceRevisionId: asset.sourceRevisionId,
        contentDigest: asset.contentDigest,
      },
    ],
    evidenceDigest: digest,
    coveredPaths: ["catalog.json"],
    verification: { state: "missing" },
    scan: { outcome: "unknown", coverage: "none" },
    qualification: { state: "unknown" },
    findings: [],
  };
  return bundle;
}
it("accepts a tiny source-neutral catalog and rejects dangling, conflicting, unordered, and misbound references", () => {
  expect(AuthoringCatalogBundleV1Schema.safeParse(catalog()).success).toBe(true);
  const mutations: Array<(bundle: AuthoringCatalogBundleV1) => void> = [
    (b) => {
      b.sources["source:test"]!.id = "wrong";
    },
    (b) => {
      b.assets.external!.id = "wrong";
    },
    (b) => {
      b.assets.external!.sourceRevisionId = "wrong";
    },
    (b) => {
      delete b.detailChunks["detail:external"];
    },
    (b) => {
      b.groups.group!.assetIds = ["absent"];
    },
    (b) => {
      b.groups.group!.assetIds = ["other", "external"];
    },
    (b) => {
      b.groups.group!.assetIds = ["external", "external"];
    },
    (b) => {
      b.templates.template!.roots[0]!.assetId = "absent";
    },
    (b) => {
      b.templates.template!.exclusions = ["external"];
    },
    (b) => {
      b.templates.template!.roots.push({ ...b.templates.template!.roots[0]! });
    },
    (b) => {
      b.relations[0]!.toAssetId = "absent";
    },
    (b) => {
      b.relations[0]!.toAssetId = "request";
    },
    (b) => {
      b.relations[0]!.toAssetId = "external";
    },
    (b) => {
      b.relations.push({ ...b.relations[0]! });
    },
    (b) => {
      b.relations[0]!.membership = "optional";
    },
    (b) => {
      b.relations[0]!.kind = "member";
    },
    (b) => {
      b.evidence.evidence!.subjects[0]!.contentDigest = "sha256:" + "b".repeat(64);
    },
    (b) => {
      b.evidence.evidence!.coveredPaths = ["catalog.json", "catalog.json"];
    },
    (b) => {
      b.evidence.evidence!.verification = { state: "verified" };
    },
    (b) => {
      b.evidence.evidence!.verification = { state: "missing", verifiedAt: "2026-09-04T00:00:00Z" };
    },
    (b) => {
      b.evidence.evidence!.scan = { outcome: "pass", coverage: "partial" };
    },
    (b) => {
      b.assets.external!.label = "trusted\u202E";
    },
    (b) => {
      b.assets.external!.kind = "skill\u200B";
    },
    (b) => {
      b.groups.group!.label = "cafe\u0301";
    },
  ];
  for (const mutate of mutations) {
    const bundle = catalog();
    mutate(bundle);
    expect(AuthoringCatalogBundleV1Schema.safeParse(bundle).success).toBe(false);
  }
});
it("compiler declarations cannot mint Core actions and capability matching requires all immutable pins", () => {
  const asset = catalog().assets.tool!;
  const { authoring, ...declaration } = asset;
  expect(CompilerAssetDeclarationV1Schema.safeParse(asset).success).toBe(false);
  expect(CompilerAssetDeclarationV1Schema.safeParse(declaration).success).toBe(true);
  const capability = {
    assetId: asset.id,
    sourceId: asset.sourceId,
    sourceRevisionId: asset.sourceRevisionId,
    contentDigest: asset.contentDigest,
    ...authoring,
  };
  expect(assembleAuthoringAssetV1(declaration, [capability]).authoring).toEqual(authoring);
  expect(
    assembleAuthoringAssetV1(declaration, [{ ...capability, sourceRevisionId: "different" }])
      .authoring,
  ).toEqual({ action: "record-request", supportedTargets: [] });
  expect(() => assembleAuthoringAssetV1(declaration, [capability, capability])).toThrow(
    "ambiguous Core authoring capability",
  );
  expect(
    AuthoringAssetV1Schema.safeParse({
      ...asset,
      authoring: { action: "select-control", supportedTargets: [] },
    }).success,
  ).toBe(false);
  expect(
    AuthoringAssetV1Schema.safeParse({
      ...asset,
      authoring: { ...authoring, supportedTargets: ["codex", "claude"] },
    }).success,
  ).toBe(false);
  expect(
    AuthoringAssetV1Schema.safeParse({
      ...asset,
      authoring: { ...authoring, supportedTargets: ["codex", "codex"] },
    }).success,
  ).toBe(false);
  expect(
    AuthoringAssetV1Schema.safeParse({
      ...asset,
      authoring: { ...authoring, action: "record-request" },
    }).success,
  ).toBe(false);
});
