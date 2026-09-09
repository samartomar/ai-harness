import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ verify: vi.fn() }));
// GitHub is the external transport boundary. Scanner verification and local custody stay real.
vi.mock(
  "../../../src/org-policy/workbench/core/source-data-qualification.js",
  async (importActual) => ({
    ...(await importActual<
      typeof import("../../../src/org-policy/workbench/core/source-data-qualification.js")
    >()),
    verifySourceDataArtifactWithGithubV1: transport.verify,
  }),
);

import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
} from "../../../src/contract/strict-json-v1.js";
import { importWorkbenchSourceDataWithProofsV1 } from "../../../src/org-policy/workbench/core/source-data.js";
import {
  prepareSourceDataScannerRuntimeDescriptorV1,
  prepareSourceDataScannerRuntimeFactsV1,
} from "../../../src/org-policy/workbench/core/source-data-scanner.js";
import {
  issuedAt,
  now,
  scannerOperationalFixtureV1,
  simulatedGithubAttestationForPublicationV1,
} from "./source-data-scanner-fixture.js";

const roots: string[] = [];

afterEach(() => {
  transport.verify.mockReset();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function snapshot(root: string) {
  return Object.fromEntries(
    readdirSync(root)
      .filter((name) => existsSync(join(root, name)))
      .sort()
      .map((name) => [name, readFileSync(join(root, name), "base64")]),
  );
}

function sealSourceBundle<T extends Record<string, unknown>>(bundle: T): T {
  const result = structuredClone(bundle);
  (result.provenance as { bundleDigest: string }).bundleDigest =
    `sha256:${canonicalStrictJsonSha256V1({ ...result, provenance: {} })}`;
  return result;
}

function signedEnvelope(
  sourceBundle: Record<string, unknown>,
  scanner: unknown,
  signer: { privateKey: KeyObject },
  keyId: string,
) {
  const payload = {
    version: "workbench-source-data/v1" as const,
    compatibility: "core-workbench-data/v1" as const,
    sequence: 1,
    previousDigest: null,
    issuedAt,
    expiresAt: "2026-09-03T13:29:00.000Z",
    sourceBundle,
    scanner,
  };
  return canonicalStrictJsonBytesV1({
    version: "signed-workbench-source-data/v1",
    keyId,
    payload,
    signature: sign(null, canonicalStrictJsonBytesV1(payload), signer.privateKey).toString(
      "base64",
    ),
  }).toString("utf8");
}

it("does not mint an ECC custody descriptor from a verified collection Scanner proof", async () => {
  const fixture = scannerOperationalFixtureV1("collection");
  roots.push(fixture.root);
  transport.verify.mockImplementation((bytes: Uint8Array) =>
    simulatedGithubAttestationForPublicationV1(fixture.attestationResult, bytes),
  );

  await expect(
    prepareSourceDataScannerRuntimeDescriptorV1(
      fixture.bundle,
      fixture.proof,
      fixture.root,
      issuedAt,
      [fixture.proof.publisherCommit as string],
      now,
    ),
  ).resolves.toBeUndefined();
  expect(transport.verify).toHaveBeenCalledOnce();
});

it("rejects signed source and published-catalog Scanner binding drift without changing active custody", async () => {
  const fixture = scannerOperationalFixtureV1("ecc");
  roots.push(fixture.root);
  const root = mkdtempSync(join(tmpdir(), "aih-source-scanner-negative-"));
  roots.push(root);
  const store = join(root, "store");
  const verifier = join(root, "verifier");
  mkdirSync(store);
  vi.stubEnv("AIH_WORKBENCH_VERIFIER_HOME", verifier);
  transport.verify.mockImplementation((bytes: Uint8Array) =>
    simulatedGithubAttestationForPublicationV1(fixture.attestationResult, bytes),
  );

  const facts = await prepareSourceDataScannerRuntimeFactsV1(
    fixture.bundle,
    fixture.proof,
    fixture.root,
    issuedAt,
    [fixture.proof.publisherCommit as string],
    now,
  );
  const sourceBundle = sealSourceBundle({ ...fixture.bundle, evidence: facts.evidence });
  const sourceId = Object.keys(sourceBundle.sources)[0];
  if (sourceId === undefined) throw new Error("fixture source missing");
  const signer = generateKeyPairSync("ed25519");
  const keyId = createHash("sha256")
    .update(signer.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  writeFileSync(
    join(store, "trust.json"),
    JSON.stringify({
      version: 1,
      authorities: [
        {
          keyId,
          publicKeyPem: signer.publicKey.export({ format: "pem", type: "spki" }).toString(),
          role: "workbench-source-data/v1",
          sources: [sourceId],
          scannerPublisherCommits: [fixture.proof.publisherCommit],
          catalogPublisherCommits: ["c".repeat(40)],
        },
      ],
    }),
  );
  const envelope = signedEnvelope(sourceBundle, fixture.proof, signer, keyId);
  await expect(
    importWorkbenchSourceDataWithProofsV1(store, envelope, { sourceRoot: fixture.root, now }),
  ).resolves.toMatchObject({ sourceId });
  const beforeStore = snapshot(store);
  const beforeVerifier = snapshot(verifier);

  const changedSource = structuredClone(sourceBundle);
  const source = changedSource.sources[sourceId];
  if (source === undefined) throw new Error("fixture source missing");
  source.upstreamOrigin.locator = "https://github.com/fixture/other";
  await expect(
    importWorkbenchSourceDataWithProofsV1(
      store,
      signedEnvelope(sealSourceBundle(changedSource), fixture.proof, signer, keyId),
      { sourceRoot: fixture.root, now },
    ),
  ).rejects.toThrow("Workbench source data: independent Scanner proof or source binding rejected");
  expect(snapshot(store)).toEqual(beforeStore);
  expect(snapshot(verifier)).toEqual(beforeVerifier);

  const changedCatalogProof = structuredClone(fixture.proof);
  (changedCatalogProof.publishedCatalog as { pinnedSha: string }).pinnedSha = "b".repeat(40);
  await expect(
    importWorkbenchSourceDataWithProofsV1(
      store,
      signedEnvelope(sourceBundle, changedCatalogProof, signer, keyId),
      { sourceRoot: fixture.root, now },
    ),
  ).rejects.toThrow("Workbench source data: independent Scanner proof or source binding rejected");
  expect(snapshot(store)).toEqual(beforeStore);
  expect(snapshot(verifier)).toEqual(beforeVerifier);
});
