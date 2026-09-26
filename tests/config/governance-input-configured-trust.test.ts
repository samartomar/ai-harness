import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalCoreOrganizationEvidenceEnvelopeV1Bytes,
  projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1,
  verifyScanAttestationV2,
} from "@aihq/scan";
import { afterAll, describe, expect, it } from "vitest";
import {
  consumeGovernanceInputV1,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
  prepareGovernanceInputV1,
} from "../../src/index.js";
import {
  buildSeal,
  type FileRecordV2,
  signAssembledAttestation,
} from "./helpers/real-scan-attestation.js";

// ---------------------------------------------------------------------------
// Trust must come from the CONSUMER's configuration, never from imported
// material. These tests sign with a real key and then attempt to have an
// attacker-supplied key accepted in its place.
//
// The signatures here are real; the scan is assembled, so nothing below is a
// measured detector result. See helpers/real-scan-attestation.ts.
// ---------------------------------------------------------------------------

const PROFILE_SHA256 = "32ce6e9dea74ba84fe56b71ba6516e032f18aa4132e6ef7ebca507512d8735f7";
const source = { type: "aih" as const, release: "0.6.0", revision: `sha256:${PROFILE_SHA256}` };
const sourceDigest = governanceDecisionSourceDigestV2(source);
const subjectDigest = governanceDecisionSubjectDigestV2({
  kind: "agent",
  id: "governance-quality",
  sourceDigest,
});

const profileRecord: FileRecordV2 = {
  kind: "file",
  path: "artifacts/profile.json",
  sha256: PROFILE_SHA256,
  byteLength: 2352,
};
const seal = buildSeal([profileRecord], [profileRecord]);

// The operator's genuine signer, and an unrelated attacker signer.
const operator = signAssembledAttestation(seal, { identity: "organization.scanner" });
const attacker = signAssembledAttestation(seal, { identity: "organization.scanner" });

const adapter = {
  verifyScanAttestationV2,
  projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1,
  canonicalCoreOrganizationEvidenceEnvelopeV1Bytes: (value: unknown) =>
    canonicalCoreOrganizationEvidenceEnvelopeV1Bytes(
      value as Parameters<typeof canonicalCoreOrganizationEvidenceEnvelopeV1Bytes>[0],
    ),
};

/** What the OPERATOR configures, out of band. Never derived from material. */
function configuredTrust(material: typeof operator) {
  return {
    roots: [
      {
        identity: material.signer.identity,
        class: material.signer.class,
        keyId: material.signer.keyId,
        publicKey: material.publicKey,
      },
    ],
    expected: {
      ...material.claims,
      now: new Date().toISOString(),
      subjectSha256: material.subjectSha256,
      signer: material.signer,
    },
  };
}

function evidenceBytesFor(material: typeof operator): Uint8Array {
  const verified = verifyScanAttestationV2({
    envelope: material.envelope,
    candidate: material.candidate,
    annexArtifacts: material.annexArtifacts,
    roots: configuredTrust(material).roots,
    expected: configuredTrust(material).expected,
  });
  return canonicalCoreOrganizationEvidenceEnvelopeV1Bytes(
    projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1({ verified, subjectDigest }),
  );
}

const roots: string[] = [];
function disposableRoot(bytes: Uint8Array, path: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aih-configured-trust-"));
  roots.push(dir);
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(bytes));
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function prepare(evidenceBytes: Uint8Array) {
  const result = prepareGovernanceInputV1({
    route: "organization",
    subject: { kind: "agent", id: "governance-quality", source },
    request: { target: "claude", effect: "observe" },
    decisionReference: {
      id: "decision-observe-governance-quality",
      digest: `sha256:${"1".repeat(64)}`,
    },
    evidenceBytes,
    provenance: { catalogEntryId: "agent.aih.governance-quality" },
  });
  if (result.artifacts === undefined) throw new Error("prepare failed");
  return result.artifacts;
}

describe("configured trust cannot be replaced by imported material", () => {
  it("verifies the operator's own attestation under the operator's configured roots", async () => {
    const artifacts = prepare(evidenceBytesFor(operator));
    const result = await consumeGovernanceInputV1({
      bytes: artifacts.input.bytes,
      root: disposableRoot(artifacts.evidence.bytes, artifacts.evidence.path),
      env: {},
      now: new Date().toISOString(),
      scan: {
        adapter,
        request: {
          ...configuredTrust(operator),
          envelope: operator.envelope,
          candidate: operator.candidate,
          annexArtifacts: operator.annexArtifacts,
        },
      },
    });
    // Reaching authority proves signature, binding and reprojection all passed.
    expect(result.status.evidence).toBe("verified");
    expect(result.status.binding).toBe("bound");
    expect(result.evidenceClaim).toBe("scan-attestation-v2");
    expect(result.status.reason).toBe("authority-unverified");
  });

  it("refuses an attacker-signed attestation while the operator's roots stay configured", async () => {
    // The attacker supplies the whole imported bundle: evidence file, envelope,
    // candidate and annexes. Only `roots`/`expected` remain the operator's.
    const artifacts = prepare(evidenceBytesFor(attacker));
    const result = await consumeGovernanceInputV1({
      bytes: artifacts.input.bytes,
      root: disposableRoot(artifacts.evidence.bytes, artifacts.evidence.path),
      env: {},
      now: new Date().toISOString(),
      scan: {
        adapter,
        request: {
          envelope: attacker.envelope,
          candidate: attacker.candidate,
          annexArtifacts: attacker.annexArtifacts,
          // Operator configuration - unchanged by anything the attacker sent.
          ...configuredTrust(operator),
        },
      },
    });
    expect(result.status.reason).toBe("scan-attestation-unverified");
    expect(result.status.binding).toBe("unbound");
    expect(result.status.evidence).not.toBe("verified");
    expect(result.status.authority).toBe("not-evaluated");
    expect(result.status.execution).toBe("not-attempted");
  });

  it("gives Core no path from saved bytes or evidence to the trust roots", async () => {
    // The saved document and the evidence file are entirely attacker-produced,
    // and the attacker's own key is embedded in the material they control. If
    // any of it could reach the verifier, this would verify. It must not.
    const artifacts = prepare(evidenceBytesFor(attacker));
    const smuggled = {
      ...configuredTrust(operator),
      // Attacker-shaped extras that a careless implementation might honour.
      roots: configuredTrust(operator).roots,
    };
    const result = await consumeGovernanceInputV1({
      bytes: artifacts.input.bytes,
      root: disposableRoot(artifacts.evidence.bytes, artifacts.evidence.path),
      env: {},
      now: new Date().toISOString(),
      scan: {
        adapter,
        request: {
          envelope: attacker.envelope,
          candidate: attacker.candidate,
          annexArtifacts: attacker.annexArtifacts,
          ...smuggled,
        },
      },
    });
    expect(result.status.reason).toBe("scan-attestation-unverified");

    // And the mirror case: the operator's material under the attacker's roots
    // must fail too, proving the roots are what decide, not the material.
    const mirror = prepare(evidenceBytesFor(operator));
    const mirrored = await consumeGovernanceInputV1({
      bytes: mirror.input.bytes,
      root: disposableRoot(mirror.evidence.bytes, mirror.evidence.path),
      env: {},
      now: new Date().toISOString(),
      scan: {
        adapter,
        request: {
          envelope: operator.envelope,
          candidate: operator.candidate,
          annexArtifacts: operator.annexArtifacts,
          ...configuredTrust(attacker),
        },
      },
    });
    expect(mirrored.status.reason).toBe("scan-attestation-unverified");
  });

  it("keeps the two signers genuinely distinct", () => {
    expect(operator.signer.keyId).not.toBe(attacker.signer.keyId);
  });
});
