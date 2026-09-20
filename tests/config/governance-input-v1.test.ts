import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  canonicalGovernanceInputV1,
  canonicalOrganizationEvidenceEnvelopeV1,
  consumeGovernanceInputV1,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
  parseGovernanceInputV1Bytes,
  prepareGovernanceInputV1,
  type ScanVerificationAdapterV1,
  verifySubjectContentBindingV1,
} from "../../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures.
//
// The subject identity and the matched content digest are the real published
// @aihq/catalog values for agent.aih.governance-quality. The seal records and
// the signature transport are synthetic unit-test evidence: Scan does not
// publicly export its candidate builders, so these tests exercise Core's own
// obligations (recomputation, binding, reprojection, refusals) through a
// contract-faithful adapter. Real verifyScanAttestationV2 integration is
// proven in acceptance against installed tarballs.
// ---------------------------------------------------------------------------

const PROFILE_SHA256 = "32ce6e9dea74ba84fe56b71ba6516e032f18aa4132e6ef7ebca507512d8735f7";
const OTHER_SHA256 = "a".repeat(64);

const source = {
  type: "aih" as const,
  release: "0.6.0",
  revision: `sha256:${PROFILE_SHA256}`,
};
const sourceDigest = governanceDecisionSourceDigestV2(source);
const subjectDigest = governanceDecisionSubjectDigestV2({
  kind: "agent",
  id: "governance-quality",
  sourceDigest,
});

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
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
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type FileRecord = { kind: "file"; path: string; sha256: string; byteLength: number };

/** Builds a seal whose three digests are genuinely recomputed from its records. */
function seal(entries: readonly FileRecord[], selected: readonly FileRecord[]) {
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

const profileRecord: FileRecord = {
  kind: "file",
  path: "artifacts/profile.json",
  sha256: PROFILE_SHA256,
  byteLength: 2352,
};
const otherRecord: FileRecord = {
  kind: "file",
  path: "artifacts/other.json",
  sha256: OTHER_SHA256,
  byteLength: 10,
};

const CLAIMS = { signedAt: "2026-09-20T00:00:00.000Z", expiresAt: "2026-09-21T00:00:00.000Z" };

/** A verified result shaped exactly like VerifiedScanAttestationV2's facts. */
function verifiedResult(sealValue: ReturnType<typeof seal>) {
  return {
    facts: {
      envelopeValid: true,
      signer: { identity: "organization.scanner", class: "organization", keyId: "ed25519:test" },
      scan: { outcome: "succeeded" },
      payloadSha256: sha("payload"),
      evidenceDigestSha256: sha("evidence"),
      candidateSha256: sha("candidate"),
      subject: { name: "source-tree", sha256: sealValue.sourceTreeSha256 },
      sourceSeals: { before: sealValue, after: sealValue },
      claims: CLAIMS,
      coverage: {
        kind: "selected-closure",
        sha256: sealValue.selectedClosureSha256,
        complete: true,
      },
      annexDescriptors: [],
    },
  };
}

/** Mirrors Scan's projection semantics closely enough to bind Core's reprojection check. */
function project(input: unknown): unknown {
  const { verified, subjectDigest: digest } = input as {
    verified: ReturnType<typeof verifiedResult>;
    subjectDigest: string;
  };
  const facts = verified.facts;
  const artifactDigests = [
    ...new Set([
      `sha256:${facts.evidenceDigestSha256}`,
      `sha256:${facts.candidateSha256}`,
      `sha256:${facts.payloadSha256}`,
      `sha256:${facts.subject.sha256}`,
      `sha256:${facts.sourceSeals.before.sourceTreeSha256}`,
      `sha256:${facts.sourceSeals.before.selectedClosureSha256}`,
      `sha256:${facts.sourceSeals.before.sealedSnapshotSha256}`,
    ]),
  ].sort(ordinal);
  return {
    format: "aih-organization-evidence" as const,
    version: 1 as const,
    subjectDigest: digest,
    evidence: {
      kind: "scan-attestation-v2",
      id: "scanner-evidence-v2",
      summary:
        "Verified scanner evidence only; not qualification, admission, approval, finding disposition, or effect authority.",
      payloadDigest: `sha256:${facts.payloadSha256}`,
      artifactDigests,
    },
    attestor: `scanner-${sha(facts.signer.keyId).slice(0, 56)}`,
    issuedAt: facts.claims.signedAt,
    notBefore: facts.claims.signedAt,
    expiresAt: facts.claims.expiresAt,
  };
}

function adapter(
  options: { verify?: (input: unknown) => unknown } = {},
): ScanVerificationAdapterV1 {
  return {
    verifyScanAttestationV2:
      options.verify ??
      (() => {
        throw new TypeError("invalid ScanAttestationV2: untrusted signer");
      }),
    projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1: project,
    canonicalCoreOrganizationEvidenceEnvelopeV1Bytes: (value) =>
      Buffer.from(stableJson(value), "utf8"),
  };
}

const TRUST_INPUTS = {
  envelope: { protocol: "ScanAttestationV2" },
  candidate: { protocol: "ScanCandidateV2" },
  roots: [{ identity: "organization.scanner", keyId: "ed25519:test" }],
  expected: { now: "2026-09-20T00:30:00.000Z", subjectSha256: "configured-by-consumer" },
  annexArtifacts: [],
};

const roots: string[] = [];
function disposableRoot(evidenceBytes?: Uint8Array, evidencePath?: string): string {
  const root = mkdtempSync(join(tmpdir(), "aih-governance-input-"));
  roots.push(root);
  if (evidenceBytes !== undefined && evidencePath !== undefined) {
    const target = join(root, evidencePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(evidenceBytes));
  }
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const boundSeal = seal([profileRecord, otherRecord], [profileRecord]);
const evidenceEnvelope = project({
  verified: verifiedResult(boundSeal),
  subjectDigest,
}) as Parameters<typeof canonicalOrganizationEvidenceEnvelopeV1>[0];
const evidenceBytes = Buffer.from(
  canonicalOrganizationEvidenceEnvelopeV1(evidenceEnvelope),
  "utf8",
);

function prepared(
  overrides: { bindingClaim?: Parameters<typeof prepareGovernanceInputV1>[0]["bindingClaim"] } = {},
) {
  return prepareGovernanceInputV1({
    route: "organization",
    subject: { kind: "agent", id: "governance-quality", source },
    request: { target: "claude", effect: "observe" },
    decisionReference: {
      id: "decision-observe-governance-quality",
      digest: `sha256:${"1".repeat(64)}`,
    },
    evidenceBytes,
    bindingClaim: overrides.bindingClaim ?? {
      matchedPath: "artifacts/profile.json",
      selectedClosureSha256: boundSeal.selectedClosureSha256,
      sourceTreeSha256: boundSeal.sourceTreeSha256,
    },
    provenance: { catalogEntryId: "agent.aih.governance-quality" },
  });
}

async function consume(
  sealValue: ReturnType<typeof seal>,
  options: { bytes?: Uint8Array; verify?: (input: unknown) => unknown } = {},
) {
  const result = prepared();
  const artifacts = result.artifacts;
  if (artifacts === undefined) throw new Error("prepare failed");
  const root = disposableRoot(artifacts.evidence.bytes, artifacts.evidence.path);
  return consumeGovernanceInputV1({
    bytes: options.bytes ?? artifacts.input.bytes,
    root,
    env: {},
    now: "2026-09-20T00:30:00.000Z",
    scan: {
      adapter: adapter({ verify: options.verify ?? (() => verifiedResult(sealValue)) }),
      request: TRUST_INPUTS,
    },
  });
}

describe("governance input document", () => {
  it("prepares deterministic canonical bytes and derives every identity", () => {
    const first = prepared();
    const second = prepared();
    expect(first.status.outcome).toBe("prepared");
    expect(first.status.structure).toBe("valid");
    expect(first.status.execution).toBe("not-attempted");
    // A saved artifact may only ever claim a binding.
    expect(first.status.binding).toBe("claimed");
    expect(first.status.authority).toBe("not-evaluated");
    const bytes = first.artifacts?.input.bytes;
    expect(Buffer.from(bytes as Uint8Array)).toEqual(
      Buffer.from(second.artifacts?.input.bytes as Uint8Array),
    );
    const parsed = parseGovernanceInputV1Bytes(bytes as Uint8Array);
    expect(parsed?.subject.sourceDigest).toBe(sourceDigest);
    expect(parsed?.subject.subjectDigest).toBe(subjectDigest);
  });

  it("fails closed on unknown versions, reformatting and oversize bytes", () => {
    const canonical = canonicalGovernanceInputV1(
      parseGovernanceInputV1Bytes(prepared().artifacts?.input.bytes as Uint8Array) as never,
    );
    for (const text of [
      "{",
      `${canonical}\n`,
      canonical.replace('"version":1', '"version":2'),
      JSON.stringify(JSON.parse(canonical), null, 2),
    ]) {
      expect(parseGovernanceInputV1Bytes(Buffer.from(text, "utf8"))).toBeUndefined();
    }
    expect(parseGovernanceInputV1Bytes(Buffer.alloc(8_193))).toBeUndefined();
  });

  it("refuses evidence that does not describe the selected subject", () => {
    const wrong = project({
      verified: verifiedResult(boundSeal),
      subjectDigest: `sha256:${"9".repeat(64)}`,
    });
    const result = prepareGovernanceInputV1({
      route: "organization",
      subject: { kind: "agent", id: "governance-quality", source },
      request: { target: "claude", effect: "observe" },
      decisionReference: { id: "decision-x", digest: `sha256:${"1".repeat(64)}` },
      evidenceBytes: Buffer.from(canonicalOrganizationEvidenceEnvelopeV1(wrong as never), "utf8"),
    });
    expect(result.status.outcome).toBe("refused");
    expect(result.status.reason).toBe("evidence-subject-mismatch");
    expect(result.artifacts).toBeUndefined();
  });
});

describe("subject to content binding", () => {
  const expected = {
    sourceTreeSha256: boundSeal.sourceTreeSha256,
    selectedClosureSha256: boundSeal.selectedClosureSha256,
  };

  it("binds an aih source identity to a record in the selected closure", () => {
    const binding = verifySubjectContentBindingV1({ source, seal: boundSeal, expected });
    expect(binding).toMatchObject({
      status: "bound",
      matchedPath: "artifacts/profile.json",
      matchedSha256: PROFILE_SHA256,
    });
  });

  it("refuses when the file is in the tree but absent from the selected closure", () => {
    const covered = seal([profileRecord, otherRecord], [otherRecord]);
    expect(
      verifySubjectContentBindingV1({
        source,
        seal: covered,
        expected: {
          sourceTreeSha256: covered.sourceTreeSha256,
          selectedClosureSha256: covered.selectedClosureSha256,
        },
      }),
    ).toEqual({ status: "unbound", reason: "subject-digest-covered-but-not-selected" });
  });

  it("refuses a valid seal for different content", () => {
    const different = seal([otherRecord], [otherRecord]);
    expect(
      verifySubjectContentBindingV1({
        source,
        seal: different,
        expected: {
          sourceTreeSha256: different.sourceTreeSha256,
          selectedClosureSha256: different.selectedClosureSha256,
        },
      }),
    ).toEqual({ status: "unbound", reason: "subject-digest-absent-from-sealed-closure" });
  });

  it("refuses fabricated records whose own digests were all recomputed", () => {
    // Internally consistent, but not the closure the verified facts committed to.
    const fabricated = seal([profileRecord], [profileRecord]);
    expect(verifySubjectContentBindingV1({ source, seal: fabricated, expected })).toEqual({
      status: "mismatched",
      reason: "seal-digest-recomputation-mismatch",
    });
  });

  it("refuses a seal whose stored digests do not match its own records", () => {
    const tampered = { ...boundSeal, selectedClosureSha256: OTHER_SHA256 };
    expect(verifySubjectContentBindingV1({ source, seal: tampered, expected })).toEqual({
      status: "mismatched",
      reason: "seal-digest-recomputation-mismatch",
    });
  });

  it("names the missing provenance record for github and npm identities", () => {
    expect(
      verifySubjectContentBindingV1({
        source: {
          type: "github",
          repository: "example/repo",
          commit: "0".repeat(40),
          path: "SKILL.md",
        },
        seal: boundSeal,
        expected,
      }),
    ).toEqual({ status: "unbound", reason: "missing-repository-commit-provenance-record" });
    expect(
      verifySubjectContentBindingV1({
        source: {
          type: "npm",
          registry: "https://registry.npmjs.org/",
          package: "example",
          version: "1.0.0",
          integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        },
        seal: boundSeal,
        expected,
      }),
    ).toEqual({ status: "unbound", reason: "missing-tarball-sha512-record" });
  });
});

describe("independent consumption", () => {
  it("refuses when the attestation does not verify against configured trust inputs", async () => {
    const result = await consume(boundSeal, {
      verify: () => {
        throw new TypeError("invalid ScanAttestationV2: untrusted signer");
      },
    });
    expect(result.status.outcome).toBe("refused");
    expect(result.status.reason).toBe("scan-attestation-unverified");
    expect(result.status.binding).toBe("unbound");
    expect(result.status.authority).toBe("not-evaluated");
  });

  it("refuses a valid attestation covering different content", async () => {
    const different = seal([otherRecord], [otherRecord]);
    const result = await consume(different);
    expect(result.status.reason).toBe("subject-digest-absent-from-sealed-closure");
    expect(result.status.binding).toBe("unbound");
  });

  it("refuses when the matched file is covered but not in the selected closure", async () => {
    const covered = seal([profileRecord, otherRecord], [otherRecord]);
    const result = await consume(covered);
    expect(result.status.reason).toBe("subject-digest-covered-but-not-selected");
  });

  it("refuses a saved binding claim that contradicts the recomputed binding", async () => {
    const result = prepared({
      bindingClaim: {
        matchedPath: "artifacts/somewhere-else.json",
        selectedClosureSha256: boundSeal.selectedClosureSha256,
        sourceTreeSha256: boundSeal.sourceTreeSha256,
      },
    });
    const artifacts = result.artifacts;
    if (artifacts === undefined) throw new Error("prepare failed");
    const root = disposableRoot(artifacts.evidence.bytes, artifacts.evidence.path);
    const consumed = await consumeGovernanceInputV1({
      bytes: artifacts.input.bytes,
      root,
      env: {},
      now: "2026-09-20T00:30:00.000Z",
      scan: {
        adapter: adapter({ verify: () => verifiedResult(boundSeal) }),
        request: TRUST_INPUTS,
      },
    });
    expect(consumed.status.reason).toBe("binding-claim-contradicted");
    expect(consumed.status.binding).toBe("mismatched");
  });

  it("refuses when the organization route has no configured scan verification", async () => {
    const result = prepared();
    const artifacts = result.artifacts;
    if (artifacts === undefined) throw new Error("prepare failed");
    const root = disposableRoot(artifacts.evidence.bytes, artifacts.evidence.path);
    const consumed = await consumeGovernanceInputV1({
      bytes: artifacts.input.bytes,
      root,
      env: {},
      now: "2026-09-20T00:30:00.000Z",
    });
    expect(consumed.status.reason).toBe("scan-verification-unavailable");
  });

  it("refuses evidence that the verified attestation does not reproject to", async () => {
    const result = prepared();
    const artifacts = result.artifacts;
    if (artifacts === undefined) throw new Error("prepare failed");
    const root = disposableRoot(artifacts.evidence.bytes, artifacts.evidence.path);
    const consumed = await consumeGovernanceInputV1({
      bytes: artifacts.input.bytes,
      root,
      env: {},
      now: "2026-09-20T00:30:00.000Z",
      scan: {
        adapter: {
          ...adapter({ verify: () => verifiedResult(boundSeal) }),
          // A verified result that reprojects to something other than the saved bytes.
          projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1: (value) => {
            const projected = project(value) as { evidence: { payloadDigest: string } };
            return {
              ...projected,
              evidence: { ...projected.evidence, payloadDigest: `sha256:${OTHER_SHA256}` },
            };
          },
        },
        request: TRUST_INPUTS,
      },
    });
    expect(consumed.status.reason).toBe("evidence-reprojection-mismatch");
    expect(consumed.status.evidence).toBe("unverified");
  });

  it("refuses malformed and unknown-version saved bytes before anything else", async () => {
    const unknown = Buffer.from(
      JSON.stringify({ format: "aih-governance-input", version: 2 }),
      "utf8",
    );
    expect((await consume(boundSeal, { bytes: unknown })).status.reason).toBe(
      "unknown-contract-version",
    );
    expect((await consume(boundSeal, { bytes: Buffer.from("{", "utf8") })).status.reason).toBe(
      "malformed-bytes",
    );
  });

  it("refuses through Scan's real verifier when the attestation is not genuine", async () => {
    // Wires Core to @aihq/scan's actual public verifyScanAttestationV2 rather
    // than the contract stub, so the adapter seam is proven real. The trust
    // inputs are configured here, not taken from the imported file.
    const scan = await import("@aihq/scan");
    const result = prepared();
    const artifacts = result.artifacts;
    if (artifacts === undefined) throw new Error("prepare failed");
    const root = disposableRoot(artifacts.evidence.bytes, artifacts.evidence.path);
    const consumed = await consumeGovernanceInputV1({
      bytes: artifacts.input.bytes,
      root,
      env: {},
      now: "2026-09-20T00:30:00.000Z",
      scan: {
        adapter: {
          verifyScanAttestationV2: scan.verifyScanAttestationV2,
          projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1:
            scan.projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1,
          // Core states only that it passes unknown; the consumer, which knows
          // the concrete Scan types, narrows at its own seam.
          canonicalCoreOrganizationEvidenceEnvelopeV1Bytes: (value) =>
            scan.canonicalCoreOrganizationEvidenceEnvelopeV1Bytes(
              value as Parameters<typeof scan.canonicalCoreOrganizationEvidenceEnvelopeV1Bytes>[0],
            ),
        },
        request: TRUST_INPUTS,
      },
    });
    expect(consumed.status.reason).toBe("scan-attestation-unverified");
    expect(consumed.status.binding).toBe("unbound");
    expect(consumed.status.authority).toBe("not-evaluated");
  });

  it("clears structure, binding and evidence, then fails closed on absent authority", async () => {
    const result = await consume(boundSeal);
    // Reaching authority-unverified proves the document, the freshly recomputed
    // binding and the reprojected evidence all passed first.
    expect(result.status.structure).toBe("valid");
    expect(result.status.binding).toBe("bound");
    expect(result.status.evidence).toBe("verified");
    expect(result.status.authority).toBe("unverified");
    expect(result.status.reason).toBe("authority-unverified");
    expect(result.status.execution).toBe("not-attempted");
    expect(result.matchedPath).toBe("artifacts/profile.json");
    expect(result.subjectDigest).toBe(subjectDigest);
  });
});
