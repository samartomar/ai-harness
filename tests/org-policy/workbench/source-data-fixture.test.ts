import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
} from "../../../src/contract/strict-json-v1.js";
import {
  applyWorkbenchSourceDataV1,
  extractWorkbenchSourceDataV1,
  importWorkbenchSourceDataV1,
  readWorkbenchSourceDataFileV1,
  verifyWorkbenchSourceDataV1,
} from "../../../src/org-policy/workbench/core/source-data.js";
import {
  fixtureAssetId,
  fixtureChangedAssetId,
  fixtureSourceId,
  fixtureUnrelatedAssetId,
  tinySourceDataPreparedCatalogV1,
} from "./source-data-test-fixture.js";

vi.mock("../../../src/org-policy/workbench/prepared-catalog.js", async () => {
  const fixture = await import("./source-data-test-fixture.js");
  return { packagedPreparedWorkbenchCatalogV1: fixture.tinySourceDataPreparedCatalogV1 };
});
vi.mock("../../../src/org-policy/workbench/core/packaged-source-data-data.js", () => ({
  packagedWorkbenchSourceDataInputV1: () => [],
}));

const roots: string[] = [];
// Model one administrator verifier shared by independent project stores.
const verifierParent = mkdtempSync(join(tmpdir(), "aih-source-data-fixture-verifier-"));
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
    { keyId, publicKeyPem, role: "workbench-source-data/v1", sources: [fixtureSourceId] },
  ],
};
const authority = trust.authorities[0];
if (authority === undefined) throw new Error("missing fixture authority");
const base = tinySourceDataPreparedCatalogV1();

function bundle(sequence = 1, previousDigest: string | null = null) {
  const sourceBundle = extractWorkbenchSourceDataV1(base.bundle, fixtureSourceId);
  const asset = sourceBundle.assets[fixtureChangedAssetId];
  if (asset === undefined) throw new Error("missing fixture source asset");
  asset.label = `Data refresh ${sequence}`;
  sourceBundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({
    ...sourceBundle,
    provenance: {},
  })}`;
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
  const root = mkdtempSync(join(tmpdir(), "aih-source-data-fixture-"));
  roots.push(root);
  vi.stubEnv("AIH_WORKBENCH_VERIFIER_HOME", verifier);
  writeFileSync(join(root, "trust.json"), JSON.stringify(trust));
  return root;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => rmSync(verifierParent, { recursive: true, force: true }));

describe("authenticated versioned Workbench source data with a sealed fixture baseline", () => {
  it("reads bounded exact UTF-8 source bytes and rejects directories, empty or malformed files", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-source-file-"));
    roots.push(root);
    const path = join(root, "source.json");
    writeFileSync(path, "{}", "utf8");
    expect(readWorkbenchSourceDataFileV1(path, 2)).toBe("{}");
    expect(() => readWorkbenchSourceDataFileV1(path, 1)).toThrow();
    expect(() => readWorkbenchSourceDataFileV1(root)).toThrow();
    writeFileSync(path, Buffer.from([0xff]));
    expect(() => readWorkbenchSourceDataFileV1(path)).toThrow();
    writeFileSync(path, "");
    expect(() => readWorkbenchSourceDataFileV1(path)).toThrow();
  });

  it("rejects correctly signed fabricated Scanner custody and retains the active snapshot", () => {
    const root = store();
    const first = importWorkbenchSourceDataV1(root, signed(bundle()), now);
    const before = readFileSync(join(root, "active.json"), "utf8");
    const next = bundle(2, first.digest);
    const asset = next.sourceBundle.assets[fixtureAssetId];
    if (asset === undefined) throw new Error("missing fixture source asset");
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
    next.sourceBundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({
      ...next.sourceBundle,
      provenance: {},
    })}`;
    expect(() => importWorkbenchSourceDataV1(root, signed(next), now)).toThrow(/Scanner/);
    expect(readFileSync(join(root, "active.json"), "utf8")).toBe(before);
  });

  it("refreshes one source without changing unrelated data or bindings", () => {
    const root = store();
    const first = importWorkbenchSourceDataV1(root, signed(bundle()), now);
    const second = importWorkbenchSourceDataV1(root, signed(bundle(2, first.digest)), now);
    const prepared = applyWorkbenchSourceDataV1(base, { root, now });
    expect(prepared.bundle.sources).toEqual(base.bundle.sources);
    expect(prepared.bundle.assets[fixtureChangedAssetId]?.label).toBe("Data refresh 2");
    expect(prepared.bundle.assets[fixtureUnrelatedAssetId]).toEqual(
      base.bundle.assets[fixtureUnrelatedAssetId],
    );
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
      const source = next.sourceBundle.sources[fixtureSourceId];
      const asset = next.sourceBundle.assets[fixtureAssetId];
      if (source === undefined || asset === undefined)
        throw new Error("missing fixture source data");
      if (change === "source") source.id = "source:evil";
      if (change === "action")
        Object.assign(asset.authoring, {
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
        { ...trust, authorities: [{ ...authority, role: "catalog" }] },
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
    expect(dated.bundle.assets[fixtureUnrelatedAssetId]).toEqual(
      base.bundle.assets[fixtureUnrelatedAssetId],
    );
    expect(dated.bundle.assets[fixtureAssetId]).toBeDefined();
    const asset = base.bundle.assets[fixtureAssetId];
    if (asset === undefined) throw new Error("missing fixture source asset");
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
  });

  it("preserves mixed-source groups and relations for compatible data; rejects changed cross-source closure pins", () => {
    const root = store();
    const first = importWorkbenchSourceDataV1(root, signed(bundle()), now);
    const mixedBase = structuredClone(base);
    mixedBase.bundle.groups["mixed:group"] = {
      id: "mixed:group",
      label: "Mixed",
      assetIds: [fixtureAssetId, fixtureUnrelatedAssetId].sort(),
    };
    mixedBase.bundle.relations.push({
      fromAssetId: fixtureAssetId,
      toAssetId: fixtureUnrelatedAssetId,
      kind: "requires",
    });
    mixedBase.bundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({
      ...mixedBase.bundle,
      provenance: {},
    })}`;
    const refreshed = applyWorkbenchSourceDataV1(mixedBase, { root, now });
    expect(refreshed.bundle.groups["mixed:group"]).toEqual(mixedBase.bundle.groups["mixed:group"]);
    expect(refreshed.bundle.relations).toContainEqual({
      fromAssetId: fixtureAssetId,
      toAssetId: fixtureUnrelatedAssetId,
      kind: "requires",
    });
    const next = bundle(2, first.digest);
    const changed = next.sourceBundle.assets[fixtureAssetId];
    if (changed === undefined) throw new Error("missing fixture source asset");
    changed.contentDigest = `sha256:${"e".repeat(64)}`;
    next.sourceBundle.evidence = {};
    next.sourceBundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({
      ...next.sourceBundle,
      provenance: {},
    })}`;
    importWorkbenchSourceDataV1(root, signed(next), now);
    expect(() => applyWorkbenchSourceDataV1(mixedBase, { root, now })).toThrow(
      /cross-source closure/,
    );
  });
});
