import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const tinyPreparation = vi.hoisted(() => ({
  createBase: undefined as undefined | (() => unknown),
  prepare: undefined as undefined | ((options?: unknown) => unknown),
  useTiny: false,
}));

import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
} from "../../../src/contract/strict-json-v1.js";
import { packagedScannerCollectionOverlayV1 } from "../../../src/org-policy/packaged-collection-evidence-v1.js";
import { policyStudioModel } from "../../../src/org-policy/studio-model.js";
import {
  applyWorkbenchSourceDataV1,
  extractWorkbenchSourceDataV1,
  importWorkbenchSourceDataV1,
  verifyWorkbenchSourceDataEnvelopeV1,
} from "../../../src/org-policy/workbench/core/source-data.js";
import { compilePolicy } from "../../../src/org-policy/workbench/policy-compiler.js";
import { consumeWorkbenchPolicy } from "../../../src/org-policy/workbench/policy-consumption.js";
import { packagedPreparedWorkbenchCatalogV1 } from "../../../src/org-policy/workbench/prepared-catalog.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../../src/org-policy/workbench/selection-engine.js";
import { evidenceDisplayFor } from "../../../src/org-policy/workbench/ui/evidence-display.js";
import { VERSION } from "../../../src/version.js";
import { tinyStudioModel } from "../studio-test-fixture.js";
import {
  fixtureAssetId,
  fixtureSourceId,
  tinySourceDataPreparedCatalogV1,
} from "./source-data-test-fixture.js";

// Exercise the source-store contract against a fixed baseline. The packed
// browser journey covers the complete shipped initial-source artifact.
vi.mock("../../../src/org-policy/workbench/core/packaged-source-data-data.js", () => ({
  packagedWorkbenchSourceDataInputV1: () => [],
}));
// This file verifies source snapshots and saved pins. Its original Scanner
// reports remain real; unrelated package qualification receipts are not input.
vi.mock("../../../src/org-policy/workbench/core/catalog-qualification-data.js", () => ({
  catalogQualificationPackageInputV1: () => ({
    version: 1,
    records: [],
    bindings: [],
    projections: [],
  }),
}));
vi.mock("../../../src/org-policy/packaged-collection-evidence-data.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/org-policy/packaged-collection-evidence-data.js")
    >();
  return {
    ...actual,
    packagedScannerCollectionEvidenceInputV1: () =>
      tinyPreparation.useTiny ? [] : actual.packagedScannerCollectionEvidenceInputV1(),
  };
});

vi.mock("../../../src/org-policy/workbench/prepared-catalog.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/org-policy/workbench/prepared-catalog.js")>();
  const [sourceDataFixture, studioFixture] = await Promise.all([
    import("./source-data-test-fixture.js"),
    import("../studio-test-fixture.js"),
  ]);
  tinyPreparation.createBase = () => ({
    ...sourceDataFixture.tinySourceDataPreparedCatalogV1(),
    catalog: studioFixture.tinyStudioModel().catalog,
  });
  const tiny = () => {
    const create = tinyPreparation.createBase;
    if (create === undefined) throw new Error("fixture source baseline is unavailable");
    return create();
  };
  return {
    ...actual,
    defaultPreparedWorkbenchCatalog: () =>
      tinyPreparation.useTiny ? tiny() : actual.defaultPreparedWorkbenchCatalog(),
    packagedPreparedWorkbenchCatalogV1: () =>
      tinyPreparation.useTiny ? tiny() : actual.packagedPreparedWorkbenchCatalogV1(),
    prepareWorkbenchCatalog: (
      catalog: Parameters<typeof actual.prepareWorkbenchCatalog>[0],
      options?: Parameters<typeof actual.prepareWorkbenchCatalog>[1],
    ) => {
      if (!tinyPreparation.useTiny) return actual.prepareWorkbenchCatalog(catalog, options);
      const prepare = tinyPreparation.prepare;
      if (prepare === undefined) throw new Error("fixture source preparation is unavailable");
      return prepare(options) as ReturnType<typeof actual.prepareWorkbenchCatalog>;
    },
  };
});

vi.mock(
  "../../../src/org-policy/workbench/default-catalog-preassembly.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../src/org-policy/workbench/default-catalog-preassembly.js")
    >()),
    packagedDefaultCatalogPreassemblyCompanionV1: () => undefined,
  }),
);

const roots: string[] = [];
// Model one administrator verifier shared by independent project stores.
const verifierParent = mkdtempSync(join(tmpdir(), "aih-source-data-test-verifier-"));
const verifier = join(verifierParent, "home");
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
  vi.stubEnv("AIH_WORKBENCH_VERIFIER_HOME", verifier);
  writeFileSync(join(root, "trust.json"), JSON.stringify(trust));
  return root;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  tinyPreparation.prepare = undefined;
  tinyPreparation.useTiny = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => rmSync(verifierParent, { recursive: true, force: true }));
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
  it(
    "uses the same default UI preparation and consumption path after a source pin update",
    () => {
      tinyPreparation.useTiny = true;
      const studioPrepared = (): ReturnType<typeof tinySourceDataPreparedCatalogV1> => ({
        ...tinySourceDataPreparedCatalogV1(),
        catalog: tinyStudioModel().catalog as unknown as ReturnType<
          typeof tinySourceDataPreparedCatalogV1
        >["catalog"],
      });
      tinyPreparation.prepare = (options) =>
        applyWorkbenchSourceDataV1(studioPrepared(), {
          pins: (
            options as
              | {
                  sourceDataPins?: NonNullable<
                    Parameters<typeof applyWorkbenchSourceDataV1>[1]
                  >["pins"];
                }
              | undefined
          )?.sourceDataPins,
        });
      try {
        const root = store();
        vi.stubEnv("AIH_WORKBENCH_DATA", root);
        const tinyBase = tinySourceDataPreparedCatalogV1();
        const fixtureTrust = {
          ...trust,
          authorities: [{ ...trust.authorities[0]!, sources: [fixtureSourceId] }],
        };
        const fixtureBundle = (sequence = 1, previousDigest: string | null = null) => {
          const sourceBundle = extractWorkbenchSourceDataV1(tinyBase.bundle, fixtureSourceId);
          const asset = sourceBundle.assets[fixtureAssetId];
          if (asset === undefined) throw new Error("missing fixture source asset");
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
        };
        const signedFixture = (payload: ReturnType<typeof fixtureBundle>) =>
          canonicalStrictJsonBytesV1({
            version: "signed-workbench-source-data/v1",
            keyId,
            payload,
            signature: sign(null, canonicalStrictJsonBytesV1(payload), key.privateKey).toString(
              "base64",
            ),
          }).toString("utf8");
        writeFileSync(join(root, "trust.json"), JSON.stringify(fixtureTrust));
        const first = importWorkbenchSourceDataV1(root, signedFixture(fixtureBundle()), now);
        // Consumption rebuilds the saved pins from this Core catalog; it does not
        // consume an already-applied local snapshot. Keep the immutable package
        // baseline here so the test exercises the production reconstruction path
        // without separately reapplying the same source cache three times.
        const saved = reduceWorkbenchAction(tinyBase.bundle, createWorkbenchState(), {
          type: "select-root",
          assetId: fixtureAssetId,
          origin: { kind: "administrator" },
        }).state;
        const oldPolicy = compilePolicy(
          { schemaVersion: 2, minimumPosture: "vibe", references: { repoContract: "repo" } },
          saved,
          tinyBase.bundle,
          tinyBase.bindings,
          "author",
          tinyBase.sourceInputs,
        );
        expect(oldPolicy.accepted).toBe(true);
        const savedBytes = JSON.stringify(oldPolicy.policy);
        const next = fixtureBundle(2, first.digest);
        const source = next.sourceBundle.sources[fixtureSourceId]!;
        source.revision.id = "f".repeat(40);
        source.revision.contentDigest = `sha256:${"f".repeat(64)}`;
        for (const asset of Object.values(next.sourceBundle.assets)) {
          asset.sourceRevisionId = source.revision.id;
          asset.contentDigest = `sha256:${"e".repeat(64)}`;
        }
        next.sourceBundle.evidence = {};
        next.sourceBundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...next.sourceBundle, provenance: {} })}`;
        importWorkbenchSourceDataV1(root, signedFixture(next), now);
        const updated = policyStudioModel();
        expect(updated.evidenceDelivery?.coreVersion).toBe(VERSION);
        expect(updated.workbenchBundle.sources[fixtureSourceId]!.revision.id).toBe(
          source.revision.id,
        );
        const oldConsumed = consumeWorkbenchPolicy(
          JSON.parse(savedBytes),
          createWorkbenchState(),
          tinyBase,
        );
        expect(oldConsumed.accepted, oldConsumed.diagnostics.join("; ")).toBe(true);
        expect(oldConsumed.requestedIntent).toEqual([fixtureAssetId]);
        expect(JSON.stringify(oldPolicy.policy)).toBe(savedBytes);
        const historicalWorkbench = policyStudioModel(undefined, undefined, {
          initialPolicy: JSON.parse(savedBytes),
        });
        expect(historicalWorkbench.initialPolicy).toEqual(JSON.parse(savedBytes));
        expect(historicalWorkbench.workbenchBundle.assets[fixtureAssetId]!.sourceRevisionId).toBe(
          tinyBase.bundle.sources[fixtureSourceId]!.revision.id,
        );
      } finally {
        tinyPreparation.prepare = undefined;
        tinyPreparation.useTiny = false;
      }
    },
    undefined,
  );
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
});
