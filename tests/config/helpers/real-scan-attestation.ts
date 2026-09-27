/**
 * Builds genuinely signed ScanAttestationV2 material using only @aihq/scan's
 * public exports, so tests can exercise real signature verification.
 *
 * The scan itself is assembled here: no detector runs, so nothing this helper
 * produces is a measured scan result. It proves cryptographic integration only.
 */
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  AI_HARNESS_DECISION_V2_SCHEMA_SHA256,
  AI_HARNESS_STRICT_V2_COMMIT,
  createScanCandidateV2,
  ed25519KeyIdV2,
  signScanCandidateV2,
} from "@aihq/scan";

const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Code-unit canonical JSON, byte-identical to Scan's canonicalStrictJsonBytesV1. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => ordinal(a, b))
      .map(([k, c]) => `${JSON.stringify(k)}:${stableJson(c)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface FileRecordV2 {
  readonly kind: "file";
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export function buildSeal(entries: readonly FileRecordV2[], selected: readonly FileRecordV2[]) {
  const sourceTreeSha256 = sha(stableJson({ protocol: "SourceTreeV2", entries }));
  const selectedClosureSha256 = sha(stableJson({ protocol: "SelectedClosureV2", files: selected }));
  return {
    protocol: "SourceSealV2" as const,
    algorithm: "code-unit-canonical-json-v1" as const,
    entries: [...entries],
    selectedClosurePaths: selected.map((file) => file.path),
    selectedFiles: [...selected],
    sourceTreeSha256,
    selectedClosureSha256,
    sealedSnapshotSha256: sha(
      stableJson({ protocol: "SealedSnapshotV2", sourceTreeSha256, selectedClosureSha256 }),
    ),
  };
}

export interface SignedMaterial {
  readonly envelope: unknown;
  readonly candidate: unknown;
  readonly annexArtifacts: readonly { descriptorId: string; bytes: Buffer }[];
  readonly signer: { identity: string; class: "organization"; keyId: string };
  readonly publicKey: KeyObject;
  readonly claims: Record<string, unknown>;
  readonly subjectSha256: string;
}

/** Signs an assembled candidate over `seal` with a fresh Ed25519 key pair. */
export function signAssembledAttestation(
  seal: ReturnType<typeof buildSeal>,
  options: { identity?: string; now?: number } = {},
): SignedMaterial {
  const keyPair = generateKeyPairSync("ed25519");
  const keyId = ed25519KeyIdV2(keyPair.publicKey);
  const annexArtifacts = [
    { descriptorId: "annex.cisco-raw", bytes: Buffer.from("raw", "utf8") },
    { descriptorId: "annex.provenance", bytes: Buffer.from("provenance", "utf8") },
    { descriptorId: "annex.sbom", bytes: Buffer.from("sbom", "utf8") },
  ];

  const detector: Record<string, unknown> = {
    adapterCapability: "cisco-oci-v1",
    detectorId: "detector.cisco",
    analyzerIdentity: "native.0123456789ab",
    oci: {
      logicalReference: `local.invalid/scanner@sha256:${sha("manifest")}`,
      manifestDigestSha256: `sha256:${sha("manifest")}`,
      configDigestSha256: `sha256:${sha("config")}`,
    },
    adapter: { identity: "adapter.0123456789ab", sha256: sha("adapter") },
    observationConfigurationSha256: sha("configuration"),
    executionProfileSha256: sha("execution"),
    supportedPlatform: { os: "linux", architecture: "amd64" },
    sbom: {
      mediaType: "application/spdx+json",
      sha256: sha(annexArtifacts[2]?.bytes ?? Buffer.alloc(0)),
      state: "digest-bound-unverified",
    },
    provenance: {
      mediaType: "application/vnd.in-toto+json",
      sha256: sha(annexArtifacts[1]?.bytes ?? Buffer.alloc(0)),
      state: "digest-bound-unverified",
    },
  };

  const sourceSealV1 = {
    protocol: "SourceSealV1",
    sourceTreeSha256: sha("v1-source"),
    selectedClosureSha256: sha("v1-closure"),
    sealedSnapshotSha256: sha("v1-snapshot"),
  };
  const rawFacts = [
    { rawOccurrenceFingerprint: `raw-occurrence-v1:${sha("fact")}`, multiplicity: 1 },
  ];
  const rawCoverage = [
    { coverageKind: "selected-closure", coverageSha256: sourceSealV1.selectedClosureSha256 },
  ];
  const relevantFactsSha256 = sha(
    stableJson({ domain: "aih.cisco.oci-candidate.relevant-facts-v1", sourceSeal: sourceSealV1 }),
  );
  const detectorPlatform = { os: "linux", architecture: "amd64", relevantFactsSha256 };

  const manifestDetectorInput = {
    detectorId: detector.detectorId,
    analyzerIdentity: detector.analyzerIdentity,
    ociImage: {
      reference: (detector.oci as { logicalReference: string }).logicalReference,
      sha256: (detector.oci as { manifestDigestSha256: string }).manifestDigestSha256.slice(
        "sha256:".length,
      ),
    },
    adapter: detector.adapter,
    observationConfigurationSha256: detector.observationConfigurationSha256,
    executionProfileSha256: detector.executionProfileSha256,
    supportedPlatforms: [detector.supportedPlatform],
    sbom: {
      mediaType: (detector.sbom as { mediaType: string }).mediaType,
      sha256: (detector.sbom as { sha256: string }).sha256,
    },
    provenance: {
      mediaType: (detector.provenance as { mediaType: string }).mediaType,
      sha256: (detector.provenance as { sha256: string }).sha256,
    },
  };
  const manifestEntry = {
    ...manifestDetectorInput,
    scannerManifestEntrySha256: sha(
      stableJson({ domain: "aih.scanner-manifest-v1.entry", entry: manifestDetectorInput }),
    ),
  };
  detector.scannerManifestEntrySha256 = manifestEntry.scannerManifestEntrySha256;

  const observationKeyInput = {
    protocol: "ObservationKeyV1",
    sourceSeal: sourceSealV1,
    nativeAnalyzerIdentity: detector.analyzerIdentity,
    observationConfigurationSha256: detector.observationConfigurationSha256,
    platform: detectorPlatform,
    scannerManifestEntrySha256: detector.scannerManifestEntrySha256,
  };
  const observationKeySha256 = sha(
    stableJson({ domain: "aih.observation-key-v1", key: observationKeyInput }),
  );
  const observationSetSha256 = sha(
    stableJson({
      domain: "aih.observation-set-v1",
      observationKeySha256,
      facts: rawFacts,
      coverage: rawCoverage,
    }),
  );

  detector.sourceSealV1 = sourceSealV1;
  detector.platform = detectorPlatform;
  detector.observation = {
    keySha256: observationKeySha256,
    setSha256: observationSetSha256,
    facts: rawFacts,
    coverage: rawCoverage,
  };
  detector.broker = {
    identity: "broker.0123456789ab",
    sarifSha256: sha("sarif"),
    enforcementState: "unverified",
    policyDigestSha256: sha(
      stableJson({
        domain: "aih.cisco.oci-candidate.broker-binding-v1",
        brokerIdentity: "broker.0123456789ab",
        scannerManifestEntrySha256: detector.scannerManifestEntrySha256,
        sarifSha256: sha("sarif"),
      }),
    ),
    appliedFactsSha256: sha(
      stableJson({
        domain: "aih.cisco.oci-candidate.applied-facts-v1",
        facts: rawFacts,
        coverage: rawCoverage,
      }),
    ),
  };

  const candidate = createScanCandidateV2({
    protocol: "ScanCandidateV2",
    coreContract: {
      commit: AI_HARNESS_STRICT_V2_COMMIT,
      decisionSchemaSha256: AI_HARNESS_DECISION_V2_SCHEMA_SHA256,
    },
    subject: { name: "source-tree", digest: { sha256: seal.sourceTreeSha256 } },
    sourceSeals: { before: seal, after: seal },
    observation: { keySha256: observationKeySha256, setSha256: observationSetSha256 },
    scanner: {
      manifestSha256: sha(
        stableJson({
          domain: "aih.scanner-manifest-v1.aggregate",
          protocol: "ScannerManifestV1",
          detectors: [manifestEntry],
        }),
      ),
      runtimeSha256: sha(
        stableJson({ domain: "aih.cisco.capture-v2.runtime", detector: manifestEntry }),
      ),
      configurationSha256: detector.observationConfigurationSha256,
      detector,
    },
    platform: { os: "linux", architecture: "amd64" },
    coverage: { kind: "selected-closure", sha256: seal.selectedClosureSha256, complete: true },
    annexes: annexArtifacts.map(({ descriptorId, bytes }) => ({
      descriptorId,
      sha256: sha(bytes),
      byteLength: bytes.byteLength,
    })),
    cleanup: { outcome: "completed" },
    scan: { outcome: "succeeded" },
  });

  const nowMs = options.now ?? Date.now();
  const claims = {
    repository: "aihq/scan",
    workflow: ".github/workflows/evidence.yml",
    issuer: "https://token.actions.githubusercontent.com",
    sourceRef: "refs/heads/main",
    commit: AI_HARNESS_STRICT_V2_COMMIT,
    environment: "production",
    runId: "123",
    runAttempt: 1,
    signedAt: new Date(nowMs - 60_000).toISOString(),
    expiresAt: new Date(nowMs + 23 * 60 * 60 * 1000).toISOString(),
  };
  const signer = {
    identity: options.identity ?? "organization.scanner",
    class: "organization" as const,
    keyId,
  };
  const envelope = signScanCandidateV2({
    candidate,
    signer: { ...signer, privateKey: keyPair.privateKey },
    claims,
    annexArtifacts,
  });

  return {
    envelope,
    candidate,
    annexArtifacts,
    signer,
    publicKey: keyPair.publicKey,
    claims,
    subjectSha256: seal.sourceTreeSha256,
  };
}
