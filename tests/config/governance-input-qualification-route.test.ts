import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalCoreOrganizationEvidenceEnvelopeV1Bytes,
  projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1,
  verifyScanAttestationV2,
} from "@aihq/scan";
import { afterAll, describe, expect, it } from "vitest";
import {
  type AihSupportedQualificationReceiptV2,
  AihSupportedQualificationReceiptV2Schema,
  type CatalogQualificationPublisherV1,
  type ConsumeGovernanceInputV1Result,
  canonicalAihSupportedQualificationReceiptV2,
  canonicalUpstreamArtifactManifestV1,
  consumeGovernanceInputV1,
  type GovernanceDecisionV2,
  governanceDecisionDigestV2,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
  type OrganizationEvidenceEnvelopeV1,
  organizationEvidenceEnvelopeDigestV1,
  parseOrganizationEvidenceEnvelopeV1Bytes,
  prepareGovernanceInputV1,
  type QualificationAttestationVerifierV1,
  type QualificationMaterialResolverV1,
  type ScanVerificationAdapterV1,
} from "../../src/index.js";
import {
  buildSeal,
  type FileRecordV2,
  signAssembledAttestation,
} from "./helpers/real-scan-attestation.js";

// ---------------------------------------------------------------------------
// An application may hold a publisher's qualification receipt as BYTES and its
// own verifier for the outer attestation over exactly those bytes. Core then
// needs no fixed path, no environment variable and no `gh`, and it still never
// lowers the trust level: only the statement the injected verifier RETURNS is
// matched, against the publisher the operator pinned and against the bytes Core
// itself hashed. The organization's own decision stays mandatory.
//
// Everything below is disposable and fictional. The receipts are shaped exactly
// like Core's schema but are emitted by a local test publisher whose identity
// can never collide with the real catalog publisher, the signatures over the
// scan material are real but made with a fresh throwaway key, and the outer
// "attestation" is a synthetic statement handed to a matcher — no detector
// runs, nothing is signed by any authority, and none of it is qualification.
// ---------------------------------------------------------------------------

const SIGNER_IDENTITY = "test-organization.scanner";
const ENTRY_ID = "agent.aih.governance-quality.core-0-6-2";
const INSTALL_ROOT = "packs/governance-quality/aih-gov-doctor";
const MANIFEST_PATH = "governance/upstream-artifact-manifest.json";
const SOURCE_NAMES = ["LICENSE", "SKILL.md", "profile.json"] as const;
type SourceName = (typeof SOURCE_NAMES)[number];

/** A disposable publisher. Never `samartomar/aih-catalog`, never authoritative. */
const PUBLISHER: CatalogQualificationPublisherV1 = {
  repository: "test-organization/disposable-qualification-publisher",
  workflow:
    "test-organization/disposable-qualification-publisher/.github/workflows/disposable-catalog-v2.yml",
  ref: "refs/heads/main",
  issuer: "https://token.actions.githubusercontent.test",
  commit: "1f".repeat(20),
  subjectName: `${ENTRY_ID}.json`,
};

const fixtures = new URL(
  "../fixtures/governance-input/genuine-capture-20260921160506/",
  import.meta.url,
);
const assessmentBytes = readFileSync(new URL("assessment-profile.json", fixtures));
const sourceBytes = new Map<SourceName, Buffer>(
  SOURCE_NAMES.map((name) => [name, readFileSync(new URL(`source/${name}`, fixtures))]),
);

interface CaptureRecord {
  catalog: { subject: { source: { type: "aih"; release: string; revision: string } } };
  facts: { sourceSeals: { before: { selectedFiles: FileRecordV2[] } } };
}
const capture = JSON.parse(
  readFileSync(new URL("capture-facts.json", fixtures), "utf8"),
) as CaptureRecord;
const records: FileRecordV2[] = capture.facts.sourceSeals.before.selectedFiles.map((file) => ({
  kind: "file",
  path: file.path,
  sha256: file.sha256,
  byteLength: file.byteLength,
}));
const seal = buildSeal(records, records);
const genuineSource = capture.catalog.subject.source;
const sourceDigest = governanceDecisionSourceDigestV2(genuineSource);
const subjectDigest = governanceDecisionSubjectDigestV2({
  kind: "agent",
  id: "governance-quality",
  sourceDigest,
});

const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function sealedRecord(name: SourceName): FileRecordV2 {
  const record = records.find((file) => file.path === name);
  if (record === undefined) throw new Error(`the recorded capture is missing ${name}`);
  return record;
}
function bytesOf(name: SourceName): Buffer {
  const bytes = sourceBytes.get(name);
  if (bytes === undefined) throw new Error(`the committed fixture is missing ${name}`);
  return bytes;
}

// --- real scan material, projected into the organization evidence -----------

const operator = signAssembledAttestation(seal, { identity: SIGNER_IDENTITY });

const adapter: ScanVerificationAdapterV1 = {
  verifyScanAttestationV2,
  projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1,
  canonicalCoreOrganizationEvidenceEnvelopeV1Bytes: (value: unknown) =>
    canonicalCoreOrganizationEvidenceEnvelopeV1Bytes(
      value as Parameters<typeof canonicalCoreOrganizationEvidenceEnvelopeV1Bytes>[0],
    ),
};

/** What the OPERATOR configures, out of band. Never derived from material. */
const configuredTrust = {
  roots: [
    {
      identity: operator.signer.identity,
      class: operator.signer.class,
      keyId: operator.signer.keyId,
      publicKey: operator.publicKey,
    },
  ],
  expected: {
    ...operator.claims,
    now: new Date().toISOString(),
    subjectSha256: operator.subjectSha256,
    signer: operator.signer,
  },
};

const scanEvidence = canonicalCoreOrganizationEvidenceEnvelopeV1Bytes(
  projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1({
    verified: verifyScanAttestationV2({
      envelope: operator.envelope,
      candidate: operator.candidate,
      annexArtifacts: operator.annexArtifacts,
      roots: configuredTrust.roots,
      expected: configuredTrust.expected,
    }),
    subjectDigest,
  }),
);
const scanEnvelope: OrganizationEvidenceEnvelopeV1 = (() => {
  const envelope = parseOrganizationEvidenceEnvelopeV1Bytes(scanEvidence);
  if (envelope === undefined) throw new Error("evidence bytes are not a canonical V1 envelope");
  return envelope;
})();
const scanEvidenceDigest = organizationEvidenceEnvelopeDigestV1(scanEnvelope);

// --- the disposable publisher's receipts ------------------------------------

const NOW = new Date();
const NOW_ISO = NOW.toISOString();
const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
/** Receipt instants are canonical UTC seconds, exactly as the producer emits. */
const second = (offsetMs: number): string =>
  new Date(Math.floor((NOW.getTime() + offsetMs) / 1000) * 1000)
    .toISOString()
    .replace(".000Z", "Z");

// Publication precedes approval: the publisher's receipt is issued, then the
// organization's decision, then the authority receipt that carries it.
const HEAD_VALID_FROM = second(-600_000);
const RECEIPT_ISSUED_AT = second(-480_000);
const RECEIPT_NOT_BEFORE = second(-420_000);
const RECEIPT_EXPIRES_AT = second(12 * 60 * 60 * 1000);

const CATALOG_HEAD_DIGEST = `sha256:${sha("disposable catalog head v2")}`;
const PREVIOUS_HEAD_DIGEST = `sha256:${sha("disposable catalog head v1")}`;

type Basis = AihSupportedQualificationReceiptV2["qualificationBasis"];

function basisFor(memberSeed: string, subject: { kind: Basis["subjectKind"]; digest: string }) {
  return {
    kind: "aih-supported" as const,
    catalogSignerIdentity: "administrator:test-organization/disposable-catalog-v2",
    catalogDigest: `sha256:${sha("disposable catalog v2")}`,
    catalogHeadDigest: CATALOG_HEAD_DIGEST,
    catalogMemberDigest: `sha256:${sha(memberSeed)}`,
    subjectKind: subject.kind,
    subjectDigest: subject.digest,
  };
}

const SUPPORTED_BASIS = basisFor(`member:${ENTRY_ID}`, { kind: "agent", digest: subjectDigest });

function receiptFor(input: {
  readonly entryId?: string;
  readonly id?: string;
  readonly basis?: Basis;
}): AihSupportedQualificationReceiptV2 {
  const id = input.id ?? "governance-quality";
  const digest = governanceDecisionSubjectDigestV2({ kind: "agent", id, sourceDigest });
  const basis =
    input.basis ??
    (id === "governance-quality"
      ? SUPPORTED_BASIS
      : basisFor(`member:${id}`, { kind: "agent", digest }));
  return AihSupportedQualificationReceiptV2Schema.parse({
    format: "aih-supported-qualification-receipt",
    version: 2,
    organizationAdmission: "not-authoritative",
    entryId: input.entryId ?? ENTRY_ID,
    subject: { kind: "agent", id, source: genuineSource, sourceDigest, subjectDigest: digest },
    qualificationBasis: basis,
    catalogContinuity: {
      catalogHeadDigest: CATALOG_HEAD_DIGEST,
      previousCatalogHeadDigest: PREVIOUS_HEAD_DIGEST,
      sequence: 6,
      replayIdentity: `catalog-head:${CATALOG_HEAD_DIGEST.slice(7)}:${sha("disposable candidate")}`,
      signerKeyId: `ed25519:${sha("disposable signer key")}`,
      headValidFrom: HEAD_VALID_FROM,
      headValidUntil: RECEIPT_EXPIRES_AT,
    },
    issuedAt: RECEIPT_ISSUED_AT,
    notBefore: RECEIPT_NOT_BEFORE,
    expiresAt: RECEIPT_EXPIRES_AT,
  });
}

const bytesFor = (receipt: AihSupportedQualificationReceiptV2): Buffer =>
  Buffer.from(canonicalAihSupportedQualificationReceiptV2(receipt), "utf8");

const supportedReceipt = receiptFor({});
const supportedReceiptBytes = bytesFor(supportedReceipt);
const otherItemReceipt = receiptFor({
  entryId: "agent.aih.governance-doctor",
  id: "governance-doctor",
});
const otherItemReceiptBytes = bytesFor(otherItemReceipt);

/** A synthetic statement of exactly the shape a verified attestation returns. */
function statementFor(
  bytes: Uint8Array,
  publisher: CatalogQualificationPublisherV1 = PUBLISHER,
  overrides: { readonly digest?: string } = {},
): string {
  const workflowUri = `https://github.com/${publisher.workflow}@${publisher.ref}`;
  return JSON.stringify([
    {
      verificationResult: {
        signature: {
          certificate: {
            subjectAlternativeName: workflowUri,
            buildSignerURI: workflowUri,
            buildConfigURI: workflowUri,
            issuer: publisher.issuer,
            sourceRepositoryURI: `https://github.com/${publisher.repository}`,
            sourceRepositoryRef: publisher.ref,
            sourceRepositoryDigest: publisher.commit,
            runnerEnvironment: "github-hosted",
          },
        },
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [
            { name: publisher.subjectName, digest: { sha256: overrides.digest ?? sha(bytes) } },
          ],
        },
        verifiedTimestamps: [{ timestamp: iso(-30_000) }],
      },
    },
  ]);
}

// --- authority: an administrator-protected policy bundle outside the target --

const AUTHORITY_ISSUED_AT = iso(-180_000);
const AUTHORITY_EXPIRES_AT = iso(24 * 60 * 60 * 1000);

function decisionFor(input: {
  readonly id: string;
  readonly qualificationBasis: GovernanceDecisionV2["qualificationBasis"];
  readonly issuedAt?: string;
}): GovernanceDecisionV2 {
  return {
    format: "aih-governance-decision",
    version: 2,
    id: input.id,
    qualificationBasis: input.qualificationBasis,
    subject: {
      kind: "agent",
      id: "governance-quality",
      source: genuineSource,
      sourceDigest,
      subjectDigest,
    },
    targets: ["claude"],
    allowedEffects: ["observe"],
    policy: { id: "platform-policy", version: "2026.09", digest: `sha256:${sha("policy")}` },
    control: { id: "review-control", digest: `sha256:${sha("control")}` },
    evidence: {
      id: scanEnvelope.evidence.id,
      digest: scanEvidenceDigest,
      attestor: scanEnvelope.attestor,
    },
    issuer: "platform-security",
    actor: "security-admin",
    reason: "The organization reviewed this exact item against the publisher's qualification.",
    issuedAt: input.issuedAt ?? iso(-300_000),
    notBefore: iso(-240_000),
    expiresAt: AUTHORITY_EXPIRES_AT,
    disposition: "approved",
    acceptedFindings: [],
    acceptedGaps: [],
    conditions: [],
  };
}

const supportedDecision = decisionFor({
  id: "decision-observe-supported-material",
  qualificationBasis: SUPPORTED_BASIS,
});
const organizationDecision = decisionFor({
  id: "decision-observe-organization-material",
  qualificationBasis: {
    kind: "organization-qualified",
    evidenceDigest: scanEvidenceDigest,
    attestor: scanEnvelope.attestor,
  },
});
const otherBasisDecision = decisionFor({
  id: "decision-observe-supported-other-basis",
  qualificationBasis: basisFor("member:some-other-catalog-member", {
    kind: "agent",
    digest: subjectDigest,
  }),
});
const postDatedDecision = decisionFor({
  id: "decision-observe-supported-post-dated",
  qualificationBasis: SUPPORTED_BASIS,
  // Issued BEFORE the receipt: an older, dormant approval never activates when
  // publisher support appears later.
  issuedAt: second(-481_000),
});

/** The receipt requires its decisions ordinal-sorted and unique by id. */
const decisions = [
  supportedDecision,
  organizationDecision,
  otherBasisDecision,
  postDatedDecision,
].sort((left, right) => (left.id < right.id ? -1 : 1));

const adminRoot = realpathSync.native(
  mkdtempSync(join(realpathSync.native(tmpdir()), "aih-qualification-route-admin-")),
);
const policyPath = join(adminRoot, "policies", "policy-bundle.json");
mkdirSync(dirname(policyPath), { recursive: true });
writeFileSync(
  policyPath,
  JSON.stringify({
    schemaVersion: 2,
    bundleVersion: "2026.09.1",
    issuer: "Acme platform security",
    issuedAt: AUTHORITY_ISSUED_AT,
    policy: {
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "2026.09",
        catalog: { reviewed: [], custom: [] },
        supportedClis: ["claude"],
      },
    },
    authorityReceipt: {
      format: "aih-policy-authority-receipt",
      version: 3,
      issuerRepository: "acme/governance",
      issuedAt: AUTHORITY_ISSUED_AT,
      expiresAt: AUTHORITY_EXPIRES_AT,
      trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
      targets: ["claude"],
      decisions,
      decisionRevocations: [],
    },
  }),
);

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  rmSync(adminRoot, { recursive: true, force: true });
});

// --- consumption ------------------------------------------------------------

interface VerifierCall {
  readonly receiptSha256: string;
  readonly bytes: Uint8Array;
  readonly publisher: CatalogQualificationPublisherV1;
}

function recordingVerifier(
  statement: (bytes: Uint8Array) => unknown,
): QualificationAttestationVerifierV1 & { readonly calls: VerifierCall[] } {
  const calls: VerifierCall[] = [];
  return {
    calls,
    verifyReceiptAttestation: (request) => {
      calls.push({
        receiptSha256: request.receiptSha256,
        bytes: request.receiptBytes,
        publisher: request.publisher,
      });
      return statement(request.receiptBytes);
    },
  };
}

function recordingResolver(bytes: Uint8Array | undefined) {
  const calls: { entryId?: string; subject: { id: string } }[] = [];
  const resolver: QualificationMaterialResolverV1 = {
    readQualification: (request) => {
      calls.push({
        ...(request.entryId === undefined ? {} : { entryId: request.entryId }),
        subject: request.subject,
      });
      return Promise.resolve(bytes);
    },
  };
  return { calls, resolver };
}

interface ConsumeOptions {
  readonly decision?: GovernanceDecisionV2;
  readonly resolver?: QualificationMaterialResolverV1;
  readonly attestation?: QualificationAttestationVerifierV1;
  readonly publisher?: CatalogQualificationPublisherV1;
  /** `false` supplies no qualification inputs at all. */
  readonly qualification?: false;
  readonly observe?: boolean;
  readonly now?: string;
  readonly authority?: boolean;
}

async function consume(options: ConsumeOptions = {}): Promise<ConsumeGovernanceInputV1Result> {
  const decision = options.decision ?? supportedDecision;
  const prepared = prepareGovernanceInputV1({
    route: "catalog",
    subject: { kind: "agent", id: "governance-quality", source: genuineSource },
    request: { target: "claude", effect: "observe" },
    decisionReference: { id: decision.id, digest: governanceDecisionDigestV2(decision) },
    evidenceBytes: scanEvidence,
    provenance: { catalogEntryId: ENTRY_ID },
  });
  const artifacts = prepared.artifacts;
  if (artifacts === undefined) throw new Error("prepare failed");

  const root = mkdtempSync(join(tmpdir(), "aih-qualification-route-"));
  roots.push(root);
  const write = (relative: string, bytes: Uint8Array): void => {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(bytes));
  };
  write(artifacts.evidence.path, artifacts.evidence.bytes);
  if (options.observe === true) {
    write(
      MANIFEST_PATH,
      Buffer.from(
        canonicalUpstreamArtifactManifestV1({
          format: "aih-upstream-artifact-manifest",
          version: 1,
          decisionId: decision.id,
          subject: { kind: "agent", id: "governance-quality", sourceDigest, subjectDigest },
          target: "claude",
          effect: "observe",
          integration: { owner: "organization-platform", version: "1.0.0" },
          files: SOURCE_NAMES.map((name) => ({
            path: `${INSTALL_ROOT}/${name}`,
            sha256: `sha256:${sealedRecord(name).sha256}`,
          })),
        }),
        "utf8",
      ),
    );
    for (const name of SOURCE_NAMES) write(`${INSTALL_ROOT}/${name}`, bytesOf(name));
  }

  return consumeGovernanceInputV1({
    bytes: artifacts.input.bytes,
    root,
    env: options.authority === false ? {} : { AIH_ORG_POLICY: policyPath },
    now: options.now ?? NOW_ISO,
    scan: {
      adapter,
      request: {
        ...configuredTrust,
        envelope: operator.envelope,
        candidate: operator.candidate,
        annexArtifacts: operator.annexArtifacts,
      },
    },
    assessment: { readAssessment: () => assessmentBytes },
    ...(options.qualification === false
      ? {}
      : {
          qualification: {
            resolver: options.resolver ?? recordingResolver(supportedReceiptBytes).resolver,
            attestation: options.attestation ?? recordingVerifier((bytes) => statementFor(bytes)),
            publisher: options.publisher ?? PUBLISHER,
          },
        }),
    ...(options.observe === true
      ? { observation: { manifestPath: MANIFEST_PATH, installRoot: INSTALL_ROOT } }
      : {}),
  });
}

describe("aih-supported qualification route", () => {
  it("emits a receipt whose canonical bytes Core's own parser accepts", () => {
    // The fixture is the producer's shape, not a hand-waved object: it survives
    // the exported schema and the canonical-byte round trip.
    expect(supportedReceipt.qualificationBasis).toEqual(SUPPORTED_BASIS);
    expect(supportedReceipt.subject.subjectDigest).toBe(subjectDigest);
    expect(supportedReceiptBytes.byteLength).toBeLessThanOrEqual(5_970);
    expect(PUBLISHER.repository).not.toContain("samartomar");
  });

  it("reaches a prepared plan and an observed execution through the injected verifier", async () => {
    const { calls, resolver } = recordingResolver(supportedReceiptBytes);
    const attestation = recordingVerifier((bytes) => statementFor(bytes));
    const result = await consume({ resolver, attestation, observe: true });

    expect(result.status.structure).toBe("valid");
    expect(result.status.evidence).toBe("verified");
    expect(result.status.binding).toBe("bound");
    expect(result.status.authority).toBe("verified");
    expect(result.status.plan).toBe("prepared");
    expect(result.status.execution).toBe("observed");
    expect(result.status.outcome).toBe("observed");
    expect(result.qualificationRoute).toBe("aih-supported");
    expect(result.diagnostics).toEqual([]);
    expect(result.observation?.installRoot).toBe(INSTALL_ROOT);

    // Core asked for the saved item and handed the verifier exactly the bytes it
    // holds, by their own digest — never a statement the caller supplied.
    expect(calls).toEqual([
      { entryId: ENTRY_ID, subject: expect.objectContaining({ subjectDigest }) },
    ]);
    expect(attestation.calls).toHaveLength(1);
    expect(attestation.calls[0]?.receiptSha256).toBe(sha(supportedReceiptBytes));
    expect(
      Buffer.from(attestation.calls[0]?.bytes ?? new Uint8Array()).equals(supportedReceiptBytes),
    ).toBe(true);
    expect(attestation.calls[0]?.publisher).toEqual(PUBLISHER);
  });

  it("prepares a plan without an observation input, on the same route", async () => {
    const result = await consume();
    expect(result.status.plan).toBe("prepared");
    expect(result.status.outcome).toBe("partial");
    expect(result.status.reason).toBe("observation-missing");
    expect(result.qualificationRoute).toBe("aih-supported");
  });

  it("keeps the organization-qualified route untouched when no qualification is supplied", async () => {
    const result = await consume({
      decision: organizationDecision,
      qualification: false,
      observe: true,
    });
    expect(result.status.plan).toBe("prepared");
    expect(result.status.execution).toBe("observed");
    expect(result.status.outcome).toBe("observed");
    expect(result.status.reason).toBeUndefined();
    expect(result.qualificationRoute).toBe("organization-qualified");
  });

  it("refuses a decision of one kind offered the other kind's inputs", async () => {
    const missing = await consume({ qualification: false });
    expect(missing.status.reason).toBe("qualification-route-mismatch");
    expect(missing.status.plan).toBe("refused");
    expect(missing.qualificationRoute).toBe("aih-supported");

    const { calls, resolver } = recordingResolver(supportedReceiptBytes);
    const surplus = await consume({ decision: organizationDecision, resolver });
    expect(surplus.status.reason).toBe("qualification-route-mismatch");
    expect(surplus.status.plan).toBe("refused");
    expect(surplus.qualificationRoute).toBe("organization-qualified");
    // The route is refused before any receipt is read: no fallback either way.
    expect(calls).toEqual([]);
  });

  it("refuses when the resolver cannot produce the receipt", async () => {
    const absent = await consume({ resolver: recordingResolver(undefined).resolver });
    expect(absent.status.reason).toBe("qualification-receipt-unavailable");
    expect(absent.status.plan).toBe("refused");
    expect(absent.qualificationRoute).toBe("aih-supported");

    const threw = await consume({
      resolver: {
        readQualification: () => {
          throw new Error("receipt store unavailable");
        },
      },
    });
    expect(threw.status.reason).toBe("qualification-receipt-unavailable");

    const rejected = await consume({
      resolver: { readQualification: () => Promise.reject(new Error("receipt store offline")) },
    });
    expect(rejected.status.reason).toBe("qualification-receipt-unavailable");
  });

  it("refuses a receipt that describes another item", async () => {
    const result = await consume({ resolver: recordingResolver(otherItemReceiptBytes).resolver });
    expect(result.status.reason).toBe("qualification-receipt-subject-mismatch");
    expect(result.status.plan).toBe("refused");
  });

  it("refuses mutated, non-canonical or non-byte material", async () => {
    const mutated = Buffer.from(supportedReceiptBytes);
    mutated[mutated.indexOf(0x36)] = 0x37; // one hex digit of one digest
    const tampered = await consume({ resolver: recordingResolver(mutated).resolver });
    expect(tampered.status.reason).toBe("qualification-receipt-malformed");

    const trailingNewline = await consume({
      resolver: recordingResolver(Buffer.concat([supportedReceiptBytes, Buffer.from("\n")]))
        .resolver,
    });
    expect(trailingNewline.status.reason).toBe("qualification-receipt-malformed");

    const bom = await consume({
      resolver: recordingResolver(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), supportedReceiptBytes]),
      ).resolver,
    });
    expect(bom.status.reason).toBe("qualification-receipt-malformed");

    const notBytes = await consume({
      resolver: {
        readQualification: () =>
          canonicalAihSupportedQualificationReceiptV2(supportedReceipt) as never,
      },
    });
    expect(notBytes.status.reason).toBe("qualification-receipt-malformed");
  });

  it("refuses a receipt outside its own validity window", async () => {
    const expired = await consume({ now: iso(13 * 60 * 60 * 1000) });
    expect(expired.status.reason).toBe("qualification-receipt-not-current");
    expect(expired.status.plan).toBe("refused");

    const early = await consume({ now: iso(-450_000) });
    expect(early.status.reason).toBe("qualification-receipt-not-current");
  });

  it("refuses unless the injected verifier returns a matching statement", async () => {
    const silent = await consume({ attestation: { verifyReceiptAttestation: () => undefined } });
    expect(silent.status.reason).toBe("qualification-attestation-unverified");
    expect(silent.status.plan).toBe("refused");

    const threw = await consume({
      attestation: {
        verifyReceiptAttestation: () => {
          throw new Error("attestation store unavailable");
        },
      },
    });
    expect(threw.status.reason).toBe("qualification-attestation-unverified");

    const wrongDigest = await consume({
      attestation: recordingVerifier((bytes) =>
        statementFor(bytes, PUBLISHER, { digest: sha("some other bytes") }),
      ),
    });
    expect(wrongDigest.status.reason).toBe("qualification-attestation-unverified");

    for (const publisher of [
      { ...PUBLISHER, repository: "test-organization/another-publisher" },
      { ...PUBLISHER, ref: "refs/heads/release" },
      { ...PUBLISHER, issuer: "https://issuer.invalid" },
      { ...PUBLISHER, commit: "2e".repeat(20) },
    ] satisfies CatalogQualificationPublisherV1[]) {
      // The verifier returns a statement for ITS publisher; the operator pinned
      // another, so the pin decides.
      const result = await consume({
        attestation: recordingVerifier((bytes) => statementFor(bytes, publisher)),
      });
      expect(result.status.reason).toBe("qualification-attestation-unverified");
    }
  });

  it("never accepts a statement the verifier did not return for these bytes", async () => {
    // A verifier that ignores its input is exactly the caller-supplied-statement
    // case: Core hashes the bytes IT holds, so the mismatch is refused.
    const ignorant = await consume({
      attestation: { verifyReceiptAttestation: () => statementFor(otherItemReceiptBytes) },
    });
    expect(ignorant.status.reason).toBe("qualification-attestation-unverified");
    expect(ignorant.status.plan).toBe("refused");
  });

  it("accepts the statement as a decoded value as well as JSON text", async () => {
    const result = await consume({
      attestation: {
        verifyReceiptAttestation: (request) => JSON.parse(statementFor(request.receiptBytes)),
      },
    });
    expect(result.status.plan).toBe("prepared");
    expect(result.qualificationRoute).toBe("aih-supported");
  });

  it("refuses when the authorized decision does not carry the receipt's basis", async () => {
    const result = await consume({ decision: otherBasisDecision });
    expect(result.status.reason).toBe("qualification-unverified");
    expect(result.status.plan).toBe("refused");
    expect(result.qualificationRoute).toBe("aih-supported");
  });

  it("refuses a decision issued before the receipt it claims to rest on", async () => {
    const result = await consume({ decision: postDatedDecision });
    expect(result.status.reason).toBe("qualification-unverified");
    expect(result.status.plan).toBe("refused");
  });

  it("keeps the authority axis separate from the binding axis", async () => {
    const result = await consume({ authority: false });
    expect(result.status.authority).toBe("unverified");
    expect(result.status.reason).toBe("authority-unverified");
    expect(result.status.binding).toBe("bound");
    // The route is read from the authorized decision, so an unverified
    // authority never names one.
    expect(result.qualificationRoute).toBeUndefined();
  });
});
