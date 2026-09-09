import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
} from "../../../src/contract/strict-json-v1.js";
import { packagedScannerCollectionOverlayV1 } from "../../../src/org-policy/packaged-collection-evidence-v1.js";
import { policyStudioModel } from "../../../src/org-policy/studio-model.js";
import { prepareAuthoringSourcesForConsumptionV1 } from "../../../src/org-policy/workbench/core/authoring-sources.js";
import {
  applyWorkbenchSourceDataV1,
  extractWorkbenchSourceDataV1,
  importWorkbenchSourceDataV1,
  verifyWorkbenchSourceDataEnvelopeV1,
  verifyWorkbenchSourceDataV1,
} from "../../../src/org-policy/workbench/core/source-data.js";
import { compilePolicy } from "../../../src/org-policy/workbench/policy-compiler.js";
import { consumeWorkbenchPolicy } from "../../../src/org-policy/workbench/policy-consumption.js";
import {
  defaultPreparedWorkbenchCatalog,
  packagedPreparedWorkbenchCatalogV1,
} from "../../../src/org-policy/workbench/prepared-catalog.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../../src/org-policy/workbench/selection-engine.js";
import { evidenceDisplayFor } from "../../../src/org-policy/workbench/ui/evidence-display.js";

// Exercise the source-store contract against a fixed baseline. The packed
// browser journey covers the complete shipped initial-source artifact.
vi.mock("../../../src/org-policy/workbench/core/packaged-source-data-data.js", () => ({
  PACKAGED_WORKBENCH_SOURCE_DATA_V1: [],
}));

const roots: string[] = [];
const now = "2026-09-09T00:00:00.000Z";
const key = generateKeyPairSync("ed25519");
const publicKeyPem = key.publicKey.export({ format: "pem", type: "spki" }).toString();
const keyId = createHash("sha256")
  .update(key.publicKey.export({ format: "der", type: "spki" }))
  .digest("hex");
const trust = {
  version: 1,
  authorities: [
    { keyId, publicKeyPem, role: "workbench-source-data/v1", sources: ["source:mattpocock"] },
  ],
};
const base = packagedPreparedWorkbenchCatalogV1();
function bundle(sequence = 1, previousDigest: string | null = null) {
  const sourceBundle = extractWorkbenchSourceDataV1(base.bundle, "source:mattpocock");
  // Only data changes: the source pin and executable Core version are untouched.
  const asset = Object.values(sourceBundle.assets)[0]!;
  asset.label = `Data refresh ${sequence}`;
  sourceBundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...sourceBundle, provenance: {} })}`;
  return {
    version: "workbench-source-data/v1",
    compatibility: "core-workbench-data/v1",
    sequence,
    previousDigest,
    issuedAt: "2026-09-08T00:00:00.000Z",
    expiresAt: "2026-12-07T00:00:00.000Z",
    sourceBundle,
  };
}
function signed(payload: ReturnType<typeof bundle>, privateKey = key.privateKey) {
  return canonicalStrictJsonBytesV1({
    version: "signed-workbench-source-data/v1",
    keyId,
    payload,
    signature: sign(null, canonicalStrictJsonBytesV1(payload), privateKey).toString("base64"),
  }).toString("utf8");
}
function store() {
  const root = mkdtempSync(join(tmpdir(), "aih-source-data-test-"));
  roots.push(root);
  const verifier = `${root}-local-verifier`;
  roots.push(verifier);
  vi.stubEnv("AIH_WORKBENCH_VERIFIER_HOME", verifier);
  writeFileSync(join(root, "trust.json"), JSON.stringify(trust));
  return root;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("authenticated versioned Workbench source data", () => {
  it("admits only evidence-only updates for exact installed AIH inventory under an explicit source role", () => {
    const payload = {
      ...bundle(),
      updateKind: "evidence-only",
      sourceBundle: extractWorkbenchSourceDataV1(base.bundle, "source:aih-core"),
    };
    const aihTrust = {
      ...trust,
      authorities: [{ ...trust.authorities[0]!, sources: ["source:aih-core"] }],
    };
    expect(() => verifyWorkbenchSourceDataEnvelopeV1(signed(payload), aihTrust, now)).not.toThrow();
    expect(() => verifyWorkbenchSourceDataEnvelopeV1(signed(payload), trust, now)).toThrow();
    const unscoped = { ...payload };
    delete (unscoped as { updateKind?: string }).updateKind;
    expect(() => verifyWorkbenchSourceDataEnvelopeV1(signed(unscoped), aihTrust, now)).toThrow();
    for (const field of ["label", "authoring", "source-revision"]) {
      const changed = structuredClone(payload);
      const asset = Object.values(changed.sourceBundle.assets)[0]!;
      if (field === "label") asset.label = "external replacement";
      else if (field === "authoring")
        asset.authoring = { ...asset.authoring, action: "record-selection", supportedTargets: [] };
      else
        changed.sourceBundle.sources["source:aih-core"]!.revision.id = "package:@aihq/core@99.0.0";
      changed.sourceBundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...changed.sourceBundle, provenance: {} })}`;
      expect(() => verifyWorkbenchSourceDataEnvelopeV1(signed(changed), aihTrust, now)).toThrow();
    }
  });
  it("caps dated display at source expiry while preserving original Scanner report facts", () => {
    const root = store();
    const payload = bundle();
    payload.expiresAt = "2026-09-10T00:00:00.000Z";
    payload.sourceBundle.evidence = packagedScannerCollectionOverlayV1(payload.sourceBundle);
    payload.sourceBundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...payload.sourceBundle, provenance: {} })}`;
    importWorkbenchSourceDataV1(root, signed(payload), now);
    const displayed = applyWorkbenchSourceDataV1(base, { root, now: "2026-09-11T00:00:00.000Z" });
    const asset = displayed.bundle.assets["mattpocock/skill:tdd"]!;
    const summary = displayed.bundle.evidence[`evidence:${asset.id}`]!;
    expect(summary.verification.validUntil).toBe(payload.expiresAt);
    expect(summary.scan).toEqual(payload.sourceBundle.evidence[summary.id]!.scan);
    expect(summary.findings).toEqual(payload.sourceBundle.evidence[summary.id]!.findings);
    expect(evidenceDisplayFor(asset, [summary], Date.parse("2026-09-11T00:00:00.000Z")).state).toBe(
      "stale",
    );
  });
  it("rejects correctly signed fabricated Scanner custody and retains the active snapshot", () => {
    const root = store();
    const first = importWorkbenchSourceDataV1(root, signed(bundle()), now);
    const before = readFileSync(join(root, "active.json"), "utf8");
    const next = bundle(2, first.digest);
    const asset = Object.values(next.sourceBundle.assets)[0]!;
    const id = `evidence:${asset.id}`;
    next.sourceBundle.evidence[id] = {
      id,
      projectionVersion: "evidence-summary/v1",
      subjects: [
        {
          assetId: asset.id,
          sourceId: asset.sourceId,
          sourceRevisionId: asset.sourceRevisionId,
          contentDigest: asset.contentDigest,
        },
      ],
      evidenceDigest: `sha256:${"1".repeat(64)}`,
      coveredPaths: ["SKILL.md"],
      verification: {
        state: "verified",
        verifiedAt: "2026-09-08T00:00:00.000Z",
        validUntil: "2026-12-07T00:00:00.000Z",
        contextDigest: `sha256:${"2".repeat(64)}`,
      },
      scan: { outcome: "pass", coverage: "complete" },
      qualification: { state: "unknown" },
      findings: [],
    };
    next.sourceBundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...next.sourceBundle, provenance: {} })}`;
    expect(() => importWorkbenchSourceDataV1(root, signed(next), now)).toThrow(/Scanner/);
    expect(readFileSync(join(root, "active.json"), "utf8")).toBe(before);
  });
  it("uses the same default UI preparation and consumption path after a source pin update", () => {
    const root = store();
    vi.stubEnv("AIH_WORKBENCH_DATA", root);
    const initial = policyStudioModel();
    const first = importWorkbenchSourceDataV1(root, signed(bundle()), now);
    const oldPrepared = defaultPreparedWorkbenchCatalog();
    const saved = reduceWorkbenchAction(oldPrepared.bundle, createWorkbenchState(), {
      type: "select-root",
      assetId: "mattpocock/skill:tdd",
      origin: { kind: "administrator" },
    }).state;
    const oldPolicy = compilePolicy(
      { schemaVersion: 2, minimumPosture: "vibe", references: { repoContract: "repo" } },
      saved,
      oldPrepared.bundle,
      oldPrepared.bindings,
      "author",
      oldPrepared.sourceInputs,
    );
    expect(oldPolicy.accepted).toBe(true);
    const savedBytes = JSON.stringify(oldPolicy.policy);
    const next = bundle(2, first.digest);
    const source = next.sourceBundle.sources["source:mattpocock"]!;
    source.revision.id = "f".repeat(40);
    source.revision.contentDigest = `sha256:${"f".repeat(64)}`;
    for (const asset of Object.values(next.sourceBundle.assets)) {
      asset.sourceRevisionId = source.revision.id;
      asset.contentDigest = `sha256:${"e".repeat(64)}`;
    }
    next.sourceBundle.evidence = {};
    next.sourceBundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...next.sourceBundle, provenance: {} })}`;
    importWorkbenchSourceDataV1(root, signed(next), now);
    const updated = policyStudioModel();
    expect(updated.evidenceDelivery?.coreVersion).toBe(initial.evidenceDelivery?.coreVersion);
    expect(updated.workbenchBundle.sources["source:mattpocock"]!.revision.id).toBe(
      source.revision.id,
    );
    const asset = Object.values(next.sourceBundle.assets)[0]!;
    const state = createWorkbenchState();
    state.requests.push({
      assetId: asset.id,
      sourceId: asset.sourceId,
      sourceRevisionId: asset.sourceRevisionId,
      contentDigest: asset.contentDigest,
      origin: { kind: "administrator" },
    });
    const consumed = prepareAuthoringSourcesForConsumptionV1(
      state,
      undefined,
      defaultPreparedWorkbenchCatalog(),
    );
    expect(consumed.accepted, consumed.diagnostics.join("; ")).toBe(true);
    expect(consumed.prepared!.bundle.sources["source:mattpocock"]!.revision.id).toBe(
      source.revision.id,
    );
    state.requests[0]!.sourceRevisionId = base.bundle.sources["source:mattpocock"]!.revision.id;
    state.requests[0]!.contentDigest = base.bundle.assets[asset.id]!.contentDigest;
    const restored = prepareAuthoringSourcesForConsumptionV1(
      state,
      undefined,
      defaultPreparedWorkbenchCatalog(),
    );
    expect(restored.accepted).toBe(true);
    expect(restored.prepared!.bundle.sources["source:mattpocock"]!.revision.id).toBe(
      base.bundle.sources["source:mattpocock"]!.revision.id,
    );
    const oldConsumed = consumeWorkbenchPolicy(JSON.parse(savedBytes), createWorkbenchState());
    expect(oldConsumed.accepted, oldConsumed.diagnostics.join("; ")).toBe(true);
    expect(oldConsumed.requestedIntent).toEqual(["mattpocock/skill:tdd"]);
    expect(oldConsumed.selectedControls).toEqual([]);
    expect(JSON.stringify(oldPolicy.policy)).toBe(savedBytes);
    const historicalWorkbench = policyStudioModel(undefined, undefined, {
      initialPolicy: JSON.parse(savedBytes),
    });
    expect(historicalWorkbench.initialPolicy).toEqual(JSON.parse(savedBytes));
    expect(
      historicalWorkbench.workbenchBundle.assets["mattpocock/skill:tdd"]!.sourceRevisionId,
    ).toBe(base.bundle.sources["source:mattpocock"]!.revision.id);
  });
  it("refreshes one source without changing unrelated data or Core-owned bindings", () => {
    const root = store();
    const first = importWorkbenchSourceDataV1(root, signed(bundle()), now);
    const second = importWorkbenchSourceDataV1(root, signed(bundle(2, first.digest)), now);
    const prepared = applyWorkbenchSourceDataV1(base, { root, now });
    expect(prepared.bundle.sources).toEqual(base.bundle.sources);
    expect(prepared.bundle.assets[Object.keys(bundle().sourceBundle.assets)[0]!]!.label).toBe(
      "Data refresh 2",
    );
    const unrelated = Object.values(base.bundle.assets).find(
      (asset) => asset.sourceId === "source:ecc",
    )!;
    expect(unrelated).toBeDefined();
    expect(prepared.bundle.assets[unrelated.id]).toEqual(unrelated);
    expect(prepared.bindings).toEqual(base.bindings);
    expect(first.digest).not.toBe(second.digest);
  });
  it.each(["signature", "compatibility", "sequence", "source", "action", "domain", "evidence"])(
    "rejects %s changes and retains last-good bytes",
    (change) => {
      const root = store();
      const first = importWorkbenchSourceDataV1(root, signed(bundle()), now);
      const before = readFileSync(join(root, "active.json"), "utf8");
      const next = bundle(2, first.digest);
      if (change === "compatibility") next.compatibility = "core-workbench-data/v999";
      if (change === "sequence") next.sequence = 1;
      if (change === "domain") next.version = "aih-supported-qualification-receipt";
      if (change === "source") {
        next.sourceBundle.sources["source:mattpocock"]!.id = "source:evil";
      }
      if (change === "action")
        Object.assign(Object.values(next.sourceBundle.assets)[0]!.authoring, {
          action: "select-control",
          projectorId: "usage-hook",
          supportedTargets: ["claude"],
        });
      let bytes = signed(
        next,
        change === "signature" ? generateKeyPairSync("ed25519").privateKey : key.privateKey,
      );
      if (change === "evidence") {
        const envelope = JSON.parse(bytes);
        envelope.payload.sourceBundle.evidence = {};
        bytes = canonicalStrictJsonBytesV1(envelope).toString("utf8");
        if (Object.keys(next.sourceBundle.evidence).length === 0) {
          envelope.payload.sequence = 4;
          bytes = canonicalStrictJsonBytesV1(envelope).toString("utf8");
        }
      }
      expect(() => importWorkbenchSourceDataV1(root, bytes, now)).toThrow();
      expect(readFileSync(join(root, "active.json"), "utf8")).toBe(before);
    },
  );
  it("rejects hash-only records, embedded trust roots, wrong configured role, and expired updates", () => {
    expect(() => verifyWorkbenchSourceDataV1(JSON.stringify(bundle()), trust, now)).toThrow();
    expect(() =>
      verifyWorkbenchSourceDataV1(
        signed(bundle()),
        { ...trust, authorities: [{ ...trust.authorities[0], role: "catalog" }] },
        now,
      ),
    ).toThrow();
    const envelope = JSON.parse(signed(bundle()));
    envelope.trust = trust;
    expect(() =>
      verifyWorkbenchSourceDataV1(
        canonicalStrictJsonBytesV1(envelope).toString("utf8"),
        trust,
        now,
      ),
    ).toThrow();
    expect(() =>
      verifyWorkbenchSourceDataV1(signed(bundle()), trust, "2027-01-01T00:00:00.000Z"),
    ).toThrow();
  });

  it("opens dated source data without blocking unrelated authoring and retains exact saved pins", () => {
    const root = store();
    importWorkbenchSourceDataV1(root, signed(bundle()), now);
    const dated = applyWorkbenchSourceDataV1(base, { root, now: "2027-01-01T00:00:00.000Z" });
    const unrelated = Object.values(base.bundle.assets).find(
      (asset) => asset.sourceId === "source:aih-core",
    )!;
    expect(dated.bundle.assets[unrelated.id]).toEqual(unrelated);
    expect(dated.bundle.assets["mattpocock/skill:tdd"]).toBeDefined();
    const asset = base.bundle.assets["mattpocock/skill:tdd"]!;
    const retained = applyWorkbenchSourceDataV1(base, {
      root,
      now: "2027-01-01T00:00:00.000Z",
      pins: [
        {
          assetId: asset.id,
          sourceId: asset.sourceId,
          sourceRevisionId: asset.sourceRevisionId,
          contentDigest: asset.contentDigest,
        },
      ],
    });
    expect(retained.bundle.assets[asset.id]).toEqual(asset);
    const saved = reduceWorkbenchAction(base.bundle, createWorkbenchState(), {
      type: "select-root",
      assetId: asset.id,
      origin: { kind: "administrator" },
    }).state;
    const policy = compilePolicy(
      { schemaVersion: 2, minimumPosture: "vibe", references: { repoContract: "repo" } },
      saved,
      base.bundle,
      base.bindings,
      "author",
      base.sourceInputs,
    );
    expect(policy.accepted).toBe(true);
    vi.stubEnv("AIH_WORKBENCH_DATA", root);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"));
    expect(consumeWorkbenchPolicy(policy.policy!, createWorkbenchState()).accepted).toBe(true);
  });

  it("preserves mixed-source groups and relations for compatible data; rejects changed cross-source closure pins", () => {
    const root = store();
    const first = importWorkbenchSourceDataV1(root, signed(bundle()), now);
    const mixedBase = structuredClone(base);
    const external = "mattpocock/skill:tdd";
    const unrelated = Object.values(base.bundle.assets).find(
      (asset) => asset.sourceId === "source:ecc" && asset.authoring.action === "record-selection",
    )!;
    expect(unrelated).toBeDefined();
    mixedBase.bundle.groups["mixed:group"] = {
      id: "mixed:group",
      label: "Mixed",
      assetIds: [external, unrelated.id].sort(),
    };
    mixedBase.bundle.relations.push({
      fromAssetId: external,
      toAssetId: unrelated.id,
      kind: "requires",
    });
    mixedBase.bundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...mixedBase.bundle, provenance: {} })}`;
    const refreshed = applyWorkbenchSourceDataV1(mixedBase, { root, now });
    expect(refreshed.bundle.groups["mixed:group"]).toEqual(mixedBase.bundle.groups["mixed:group"]);
    expect(refreshed.bundle.relations).toContainEqual({
      fromAssetId: external,
      toAssetId: unrelated.id,
      kind: "requires",
    });
    const next = bundle(2, first.digest);
    next.sourceBundle.assets[external]!.contentDigest = `sha256:${"e".repeat(64)}`;
    next.sourceBundle.evidence = {};
    next.sourceBundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...next.sourceBundle, provenance: {} })}`;
    importWorkbenchSourceDataV1(root, signed(next), now);
    expect(() => applyWorkbenchSourceDataV1(mixedBase, { root, now })).toThrow(
      /cross-source closure/,
    );
  });
});
