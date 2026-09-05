import { createHash } from "node:crypto";
import { policyStudioModel, type PolicyStudioModel } from "../src/org-policy/studio-model.js";
import type { AuthoringAssetV1, AuthoringCatalogBundleV1 } from "../src/org-policy/workbench/contracts.js";
import { canonicalStrictJsonSha256V1 } from "../src/contract/strict-json-v1.js";
const digest = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
export function syntheticWorkbenchModel(size: number): PolicyStudioModel {
  const model = policyStudioModel();
  const control = Object.values(model.workbenchBundle.assets).find(asset => asset.authoring.action === "select-control")!;
  const sources: AuthoringCatalogBundleV1["sources"] = { [control.sourceId]: model.workbenchBundle.sources[control.sourceId]! };
  for (const id of ["source:a", "source:b"]) sources[id] = {
    id, distributor: { kind: "organization", locator: id }, upstreamOrigin: { kind: "organization", locator: id },
    inputFormat: "organization-authoring-manifest/v1", revision: { id: "revision:1", contentDigest: digest(id) },
    compiler: { id: "organization-manifest", version: "1" },
  };
  const assets: AuthoringCatalogBundleV1["assets"] = {};
  const detailChunks: AuthoringCatalogBundleV1["detailChunks"] = {};
  function add(id: string, sourceId: string, action: AuthoringAssetV1["authoring"]["action"] = "record-selection") {
    const chunkId = "detail:" + id;
    const bytes = JSON.stringify({ id, note: "Offline fixture details", nested: { complete: true } });
    assets[id] = { id, sourceId, sourceRevisionId: "revision:1", contentDigest: digest(bytes),
      originalPath: "catalog.json", derivation: "organization-declaration", kind: action === "record-request" ? "mcp" : "skill",
      label: id, detailChunkId: chunkId, declaredHostCapabilities: [], authoring: { action, supportedTargets: [] } };
    detailChunks[chunkId] = { bytes, digest: digest(bytes) };
  }
  add("profile:alpha", "source:a"); add("profile:beta", "source:b");
  add("skill:root", "source:a"); add("skill:dependency", "source:b"); add("mcp:request", "source:a", "record-request");
  add("inspect-item", "source:a", "inspect-evidence"); add("approval-item", "source:a", "prepare-approval");
  for (let index = 8; index < size; index++) add("scale:" + String(index).padStart(6, "0"), index % 2 ? "source:a" : "source:b");
  assets[control.id] = control;
  detailChunks[control.detailChunkId] = model.workbenchBundle.detailChunks[control.detailChunkId]!;
  assets["profile:alpha"]!.exclusiveSlot = "methodology"; assets["profile:alpha"]!.methodologyKey = "alpha";
  assets["profile:beta"]!.exclusiveSlot = "methodology"; assets["profile:beta"]!.methodologyKey = "beta";
  const templates = Object.fromEntries([
    { id: "template:alpha", roots: ["profile:alpha", "skill:root"].map(assetId => ({ assetId, mode: "select" as const, includeOptionalMembers: false })), exclusions: [] },
    { id: "template:beta", roots: [{ assetId: "profile:beta", mode: "select" as const, includeOptionalMembers: false }], exclusions: [] },
  ].map(template => [template.id, { ...template, digest: "sha256:" + canonicalStrictJsonSha256V1(template) }]));
  const bundle: AuthoringCatalogBundleV1 = {
    version: "authoring-catalog-bundle/v1", sources, assets, groups: {}, relations: [{ kind: "requires", fromAssetId: "skill:root", toAssetId: "skill:dependency" }],
    templates, evidence: {}, provenance: { bundleDigest: digest("placeholder") }, detailChunks,
  };
  bundle.provenance.bundleDigest = "sha256:" + canonicalStrictJsonSha256V1({ ...bundle, provenance: {} });
  model.workbenchBindings = { [control.id]: model.workbenchBindings[control.id]! };
  for (const asset of Object.values(assets)) model.workbenchBindings[asset.id] ??= { kind: "intent" };
  model.workbenchBundle = bundle;
  return model;
}


/** Prepared display fixture; actual attestation custody has separate Core contract tests. */
export function syntheticEvidenceWorkbenchModel(): PolicyStudioModel {
  const model = syntheticWorkbenchModel(10);
  for (const [assetId, outcome] of [["mcp:request", "pass"], ["skill:root", "failed"]] as const) {
    const asset = model.workbenchBundle.assets[assetId];
    if (!asset) throw new Error("missing evidence fixture asset");
    const id = "evidence:" + assetId;
    model.workbenchBundle.evidence[id] = {
      id, projectionVersion: "evidence-summary/v1",
      subjects: [{ assetId, sourceId: asset.sourceId, sourceRevisionId: asset.sourceRevisionId, contentDigest: asset.contentDigest }],
      evidenceDigest: digest(id), coveredPaths: ["catalog.json"],
      verification: { state: "verified", verifiedAt: "2026-09-04T12:00:00Z", validUntil: "2026-09-04T13:00:00Z", contextDigest: digest("fixture-context") },
      scan: { outcome, coverage: "complete" }, qualification: { state: "unknown" }, findings: [],
    };
  }
  model.workbenchBundle.provenance.bundleDigest = "sha256:" + canonicalStrictJsonSha256V1({ ...model.workbenchBundle, provenance: {} });
  return model;
}
