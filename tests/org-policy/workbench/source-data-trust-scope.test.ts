import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../../src/contract/strict-json-v1.js";
import {
  applyWorkbenchSourceDataV1,
  extractWorkbenchSourceDataV1,
  importWorkbenchSourceDataWithProofsV1,
} from "../../../src/org-policy/workbench/core/source-data.js";
import { packagedPreparedWorkbenchCatalogV1 } from "../../../src/org-policy/workbench/prepared-catalog.js";

// This test isolates local receipt policy binding, not the separately tested raw verifier.
vi.mock("../../../src/org-policy/workbench/core/source-data-scanner.js", () => ({
  prepareSourceDataScannerRuntimeFactsV1: vi.fn(async (bundle: { evidence: unknown }) => ({
    evidence: bundle.evidence,
  })),
}));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("keeps unrelated trust additions local but rejects changed or revoked applicable authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "aih-trust-scope-"));
  roots.push(root);
  const store = join(root, "store");
  mkdirSync(store);
  vi.stubEnv("AIH_WORKBENCH_VERIFIER_HOME", join(root, "verifier"));
  const authority = (sources: string[]) => {
    const pair = generateKeyPairSync("ed25519");
    return {
      pair,
      policy: {
        keyId: createHash("sha256")
          .update(pair.publicKey.export({ format: "der", type: "spki" }))
          .digest("hex"),
        publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
        role: "workbench-source-data/v1",
        sources,
      },
    };
  };
  const signer = authority(["source:mattpocock"]);
  const unrelated = authority(["source:ponytail"]);
  const trust = { version: 1, authorities: [signer.policy] };
  const writeTrust = (value: unknown) =>
    writeFileSync(join(store, "trust.json"), JSON.stringify(value));
  writeTrust(trust);
  const base = packagedPreparedWorkbenchCatalogV1();
  const payload = {
    version: "workbench-source-data/v1",
    compatibility: "core-workbench-data/v1",
    sequence: 1,
    previousDigest: null,
    issuedAt: "2026-09-09T00:00:00.000Z",
    expiresAt: "2026-09-10T00:00:00.000Z",
    sourceBundle: extractWorkbenchSourceDataV1(base.bundle, "source:mattpocock"),
    scanner: { fixture: "policy-binding-only" },
  };
  const bytes = canonicalStrictJsonBytesV1({
    version: "signed-workbench-source-data/v1",
    keyId: signer.policy.keyId,
    payload,
    signature: sign(null, canonicalStrictJsonBytesV1(payload), signer.pair.privateKey).toString(
      "base64",
    ),
  }).toString("utf8");
  const now = "2026-09-09T01:00:00.000Z";
  await importWorkbenchSourceDataWithProofsV1(store, bytes, { sourceRoot: root, now });
  writeTrust({
    version: 1,
    authorities: [
      { ...signer.policy, sources: ["source:mattpocock", "source:ecc"] },
      unrelated.policy,
    ],
  });
  expect(() => applyWorkbenchSourceDataV1(base, { root: store, now })).not.toThrow();
  writeTrust({
    version: 1,
    authorities: [
      { ...signer.policy, scannerPublisherCommits: ["9".repeat(40)] },
      unrelated.policy,
    ],
  });
  expect(() => applyWorkbenchSourceDataV1(base, { root: store, now })).toThrow();
  writeTrust({
    version: 1,
    authorities: [{ ...signer.policy, sources: ["source:ecc"] }, unrelated.policy],
  });
  expect(() => applyWorkbenchSourceDataV1(base, { root: store, now })).toThrow();
}, 30_000);
