import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalCoreOrganizationEvidenceEnvelopeV1Bytes,
  projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1,
  verifyScanAttestationV2,
} from "@aihq/scan";
import { afterAll, describe, expect, it } from "vitest";
import {
  type AssessmentMaterialResolverV1,
  consumeGovernanceInputV1,
  type GovernanceInputV1,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
  prepareGovernanceInputV1,
  type ScanVerificationAdapterV1,
} from "../../src/index.js";
import {
  buildSeal,
  type FileRecordV2,
  type SignedMaterial,
  signAssembledAttestation,
} from "./helpers/real-scan-attestation.js";

// ---------------------------------------------------------------------------
// An application may hold the published assessment artifact rather than the
// scanned files themselves. Core then verifies those bytes against the identity
// in the SAVED subject and recomputes the declared relationship; it never falls
// back from one binding route to the other.
//
// The signatures below are real, over a fresh disposable Ed25519 key for a
// clearly fictional test organization. The scan is assembled from the recorded
// capture's own file records, so nothing here is a measured detector result and
// the signer class label is never organizational approval.
// ---------------------------------------------------------------------------

const SIGNER_IDENTITY = "test-organization.scanner";
const MATERIAL_ROOT = "packs/governance-quality/aih-gov-doctor";

const fixtures = new URL(
  "../fixtures/governance-input/genuine-capture-20260921160506/",
  import.meta.url,
);
const assessmentBytes = readFileSync(new URL("assessment-profile.json", fixtures));

interface CaptureRecord {
  catalog: { subject: { source: { type: "aih"; release: string; revision: string } } };
  facts: {
    sourceSeals: {
      before: {
        selectedFiles: FileRecordV2[];
        sourceTreeSha256: string;
        selectedClosureSha256: string;
        sealedSnapshotSha256: string;
      };
    };
  };
}
const capture = JSON.parse(
  readFileSync(new URL("capture-facts.json", fixtures), "utf8"),
) as CaptureRecord;

const recorded = capture.facts.sourceSeals.before;
const records: FileRecordV2[] = recorded.selectedFiles.map((file) => ({
  kind: "file",
  path: file.path,
  sha256: file.sha256,
  byteLength: file.byteLength,
}));
const seal = buildSeal(records, records);
const genuineSource = capture.catalog.subject.source;
const identityDigest = genuineSource.revision;

const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function digestOf(name: string): string {
  const record = records.find((file) => file.path === name);
  if (record === undefined) throw new Error(`the recorded capture is missing ${name}`);
  return record.sha256;
}

/** A synthetic first-party qualification profile, valid but not the published one. */
function declaration(input: {
  files: readonly { digest: string; path: string }[];
  roots: readonly string[];
}): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      format: "aih-first-party-qualification-profile",
      material: {
        files: input.files,
        kind: "source-files",
        treeDigest: `sha256:${"7".repeat(64)}`,
      },
      scanner: { component: { paths: input.roots } },
      version: 1,
    })}\n`,
    "utf8",
  );
}

type AihSource = { readonly type: "aih"; readonly release: string; readonly revision: string };

function sourceDigestFor(source: AihSource): string {
  return governanceDecisionSourceDigestV2(source);
}
function subjectDigestFor(source: AihSource): string {
  return governanceDecisionSubjectDigestV2({
    kind: "agent",
    id: "governance-quality",
    sourceDigest: sourceDigestFor(source),
  });
}

const operator = signAssembledAttestation(seal, { identity: SIGNER_IDENTITY });
const attacker = signAssembledAttestation(seal, { identity: SIGNER_IDENTITY });

const adapter: ScanVerificationAdapterV1 = {
  verifyScanAttestationV2,
  projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1,
  canonicalCoreOrganizationEvidenceEnvelopeV1Bytes: (value: unknown) =>
    canonicalCoreOrganizationEvidenceEnvelopeV1Bytes(
      value as Parameters<typeof canonicalCoreOrganizationEvidenceEnvelopeV1Bytes>[0],
    ),
};

/** What the OPERATOR configures, out of band. Never derived from material. */
function configuredTrust(material: SignedMaterial) {
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

function evidenceBytesFor(material: SignedMaterial, subjectDigest: string): Uint8Array {
  const trust = configuredTrust(material);
  const verified = verifyScanAttestationV2({
    envelope: material.envelope,
    candidate: material.candidate,
    annexArtifacts: material.annexArtifacts,
    roots: trust.roots,
    expected: trust.expected,
  });
  return canonicalCoreOrganizationEvidenceEnvelopeV1Bytes(
    projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1({ verified, subjectDigest }),
  );
}

const roots: string[] = [];
function disposableRoot(bytes: Uint8Array, path: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aih-assessment-route-"));
  roots.push(dir);
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(bytes));
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

type BindingClaim = NonNullable<GovernanceInputV1["bindingClaim"]>;

interface ConsumeOptions {
  readonly source?: AihSource;
  readonly route?: "catalog" | "organization";
  readonly material?: SignedMaterial;
  readonly trust?: SignedMaterial;
  readonly adapter?: ScanVerificationAdapterV1;
  readonly assessment?: AssessmentMaterialResolverV1;
  readonly bindingClaim?: BindingClaim;
}

async function consume(options: ConsumeOptions = {}) {
  const material = options.material ?? operator;
  const source = options.source ?? genuineSource;
  const prepared = prepareGovernanceInputV1({
    route: options.route ?? "organization",
    subject: { kind: "agent", id: "governance-quality", source },
    request: { target: "claude", effect: "observe" },
    decisionReference: {
      id: "decision-observe-governance-quality",
      digest: `sha256:${"1".repeat(64)}`,
    },
    evidenceBytes: evidenceBytesFor(material, subjectDigestFor(source)),
    ...(options.bindingClaim === undefined ? {} : { bindingClaim: options.bindingClaim }),
    provenance: { catalogEntryId: "agent.aih.governance-quality.core-0-6-2" },
  });
  const artifacts = prepared.artifacts;
  if (artifacts === undefined) throw new Error("prepare failed");
  return consumeGovernanceInputV1({
    bytes: artifacts.input.bytes,
    root: disposableRoot(artifacts.evidence.bytes, artifacts.evidence.path),
    env: {},
    now: new Date().toISOString(),
    scan: {
      adapter: options.adapter ?? adapter,
      request: {
        ...configuredTrust(options.trust ?? material),
        envelope: material.envelope,
        candidate: material.candidate,
        annexArtifacts: material.annexArtifacts,
      },
    },
    ...(options.assessment === undefined ? {} : { assessment: options.assessment }),
  });
}

function recordingResolver(bytes: Uint8Array | undefined, options: { async?: boolean } = {}) {
  const calls: { identityDigest: string; subject: GovernanceInputV1["subject"] }[] = [];
  const resolver: AssessmentMaterialResolverV1 = {
    readAssessment: (request) => {
      calls.push(request);
      return options.async === true ? Promise.resolve(bytes) : bytes;
    },
  };
  return { calls, resolver };
}

describe("assessment material route", () => {
  it("rebuilds the recorded capture's seal from its own file records", () => {
    expect(seal.sourceTreeSha256).toBe(recorded.sourceTreeSha256);
    expect(seal.selectedClosureSha256).toBe(recorded.selectedClosureSha256);
    expect(seal.sealedSnapshotSha256).toBe(recorded.sealedSnapshotSha256);
  });

  it("binds the scanned material to the saved assessment identity", async () => {
    const { calls, resolver } = recordingResolver(assessmentBytes, { async: true });
    const result = await consume({ assessment: resolver });

    expect(result.status.structure).toBe("valid");
    expect(result.status.evidence).toBe("verified");
    expect(result.status.binding).toBe("bound");
    expect(result.bindingRoute).toBe("assessment-material");
    expect(result.evidenceClaim).toBe("scan-attestation-v2");
    // Reaching authority proves signature, binding and reprojection all passed.
    expect(result.status.authority).toBe("unverified");
    expect(result.status.reason).toBe("authority-unverified");
    expect(result.status.execution).toBe("not-attempted");
    expect(result.assessmentBinding?.materialRoot).toBe(MATERIAL_ROOT);
    expect(result.assessmentBinding?.itemCoverage.uncoveredPaths).toEqual(["aih-packs.json"]);
    expect(result.assessmentBinding?.itemCoverage.complete).toBe(false);
    // `matchedPath` stays a subject-content verdict; this route never sets it.
    expect(result.matchedPath).toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.identityDigest).toBe(identityDigest);
    expect(calls[0]?.subject).toEqual({
      kind: "agent",
      id: "governance-quality",
      source: genuineSource,
      sourceDigest: sourceDigestFor(genuineSource),
      subjectDigest: subjectDigestFor(genuineSource),
    });
  });

  it("keeps ordinary material verification when no resolver is supplied", async () => {
    const result = await consume();
    expect(result.status.reason).toBe("subject-digest-absent-from-sealed-closure");
    expect(result.status.binding).toBe("unbound");
    expect(result.bindingRoute).toBe("subject-content");
    expect(result.assessmentBinding).toBeUndefined();
  });

  it("refuses when the resolver cannot produce the published assessment", async () => {
    const absent = await consume({ assessment: recordingResolver(undefined).resolver });
    expect(absent.status.reason).toBe("assessment-unavailable");
    expect(absent.status.binding).toBe("unbound");
    expect(absent.bindingRoute).toBe("assessment-material");

    const threw = await consume({
      assessment: {
        readAssessment: () => {
          throw new Error("assessment store unavailable");
        },
      },
    });
    expect(threw.status.reason).toBe("assessment-unavailable");

    const rejected = await consume({
      assessment: { readAssessment: () => Promise.reject(new Error("assessment store offline")) },
    });
    expect(rejected.status.reason).toBe("assessment-unavailable");

    const notBytes = await consume({
      assessment: { readAssessment: () => "not the published bytes" as never },
    });
    expect(notBytes.status.reason).toBe("invalid-input");
    expect(notBytes.status.binding).toBe("unbound");
  });

  it("refuses a different published assessment under the saved identity", async () => {
    const swapped = declaration({
      files: [{ digest: `sha256:${digestOf("LICENSE")}`, path: "other/LICENSE" }],
      roots: ["other"],
    });
    const result = await consume({ assessment: recordingResolver(swapped).resolver });
    expect(result.status.reason).toBe("assessment-bytes-do-not-match-identity");
    expect(result.status.binding).toBe("unbound");
    expect(result.bindingRoute).toBe("assessment-material");
  });

  it("refuses an assessment whose declaration does not cover the sealed paths", async () => {
    const foreign = declaration({
      files: [{ digest: `sha256:${"3".repeat(64)}`, path: "elsewhere/NOTICE" }],
      roots: ["elsewhere"],
    });
    const source: AihSource = {
      type: "aih",
      release: "0.6.2",
      revision: `sha256:${sha(foreign)}`,
    };
    const result = await consume({ source, assessment: recordingResolver(foreign).resolver });
    expect(result.status.reason).toBe("sealed-path-not-declared");
    expect(result.status.binding).toBe("unbound");
    expect(result.bindingRoute).toBe("assessment-material");
  });

  it("reports the declared files a narrower capture never read", async () => {
    const partial = signAssembledAttestation(buildSeal(records, records.slice(0, 2)), {
      identity: SIGNER_IDENTITY,
    });
    const result = await consume({
      material: partial,
      assessment: recordingResolver(assessmentBytes).resolver,
    });
    expect(result.status.binding).toBe("bound");
    expect(result.assessmentBinding?.itemCoverage.complete).toBe(false);
    expect(result.assessmentBinding?.itemCoverage.uncoveredPaths).toEqual([
      "aih-packs.json",
      `${MATERIAL_ROOT}/profile.json`,
    ]);
    expect(result.assessmentBinding?.scannedMaterial.files.map((file) => file.path)).toEqual([
      "LICENSE",
      "SKILL.md",
    ]);
  });

  it("keeps the same binding when only the route label changes", async () => {
    const catalogLabelled = await consume({
      route: "catalog",
      assessment: recordingResolver(assessmentBytes).resolver,
    });
    const organizationLabelled = await consume({
      route: "organization",
      assessment: recordingResolver(assessmentBytes).resolver,
    });
    expect(catalogLabelled.status).toEqual(organizationLabelled.status);
    expect(catalogLabelled.assessmentBinding).toEqual(organizationLabelled.assessmentBinding);
    expect(catalogLabelled.bindingRoute).toBe("assessment-material");
  });

  it("refuses a saved binding claim on the assessment route", async () => {
    const result = await consume({
      assessment: recordingResolver(assessmentBytes).resolver,
      bindingClaim: {
        matchedPath: "profile.json",
        selectedClosureSha256: seal.selectedClosureSha256,
        sourceTreeSha256: seal.sourceTreeSha256,
      },
    });
    expect(result.status.binding).toBe("mismatched");
    expect(result.status.reason).toBe("binding-claim-contradicted");
    expect(result.bindingRoute).toBe("assessment-material");
  });

  it("refuses a tampered seal reported by a verified result", async () => {
    const tampered = { ...seal, selectedClosureSha256: "0".repeat(64) };
    const result = await consume({
      adapter: {
        ...adapter,
        verifyScanAttestationV2: () => ({
          facts: {
            subject: { name: "source-tree", sha256: seal.sourceTreeSha256 },
            coverage: {
              kind: "selected-closure",
              sha256: seal.selectedClosureSha256,
              complete: true,
            },
            sourceSeals: { before: tampered, after: tampered },
          },
        }),
      },
      assessment: recordingResolver(assessmentBytes).resolver,
    });
    expect(result.status.reason).toBe("seal-digest-recomputation-mismatch");
    expect(result.status.binding).toBe("mismatched");
    expect(result.bindingRoute).toBe("assessment-material");
  });

  it("never falls back to material verification when the assessment is unavailable", async () => {
    // This identity is a scanned file's digest, so the subject-content route
    // would bind it. Supplying a resolver chooses the route up front.
    const source: AihSource = {
      type: "aih",
      release: "0.6.2",
      revision: `sha256:${digestOf("profile.json")}`,
    };
    const material = await consume({ source });
    expect(material.status.binding).toBe("bound");
    expect(material.bindingRoute).toBe("subject-content");
    expect(material.matchedPath).toBe("profile.json");

    const result = await consume({ source, assessment: recordingResolver(undefined).resolver });
    expect(result.status.reason).toBe("assessment-unavailable");
    expect(result.status.binding).toBe("unbound");
    expect(result.bindingRoute).toBe("assessment-material");
  });

  it("never reaches the resolver when the attestation does not verify", async () => {
    const { calls, resolver } = recordingResolver(assessmentBytes);
    const result = await consume({ material: attacker, trust: operator, assessment: resolver });
    expect(result.status.reason).toBe("scan-attestation-unverified");
    expect(result.status.binding).toBe("unbound");
    expect(result.status.evidence).not.toBe("verified");
    expect(result.bindingRoute).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
