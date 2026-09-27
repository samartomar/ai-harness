import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalCoreOrganizationEvidenceEnvelopeV1Bytes,
  projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1,
  verifyScanAttestationV2,
} from "@aihq/scan";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ConsumeGovernanceInputV1Result,
  canonicalOrganizationEvidenceEnvelopeV1,
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
  type ScanVerificationAdapterV1,
} from "../../src/index.js";
import {
  buildSeal,
  type FileRecordV2,
  type SignedMaterial,
  signAssembledAttestation,
} from "./helpers/real-scan-attestation.js";

// ---------------------------------------------------------------------------
// Consumption may observe that the files a verified scan sealed are installed
// at exact paths under one explicitly named installation root. Observation is
// not installation, application or execution: nothing is written, nothing is
// run, and incomplete item coverage stays a separate verdict.
//
// The signatures are real, over a fresh disposable Ed25519 key for a clearly
// fictional test organization, and the observed bytes are the genuine capture's
// own three files, committed beside the recorded seal they hash to. Nothing
// here is a measured detector result: no detector executes in any of these
// tests, and a verified signature would not establish that one had.
// ---------------------------------------------------------------------------

const SIGNER_IDENTITY = "test-organization.scanner";
const INSTALL_ROOT = "packs/governance-quality/aih-gov-doctor";
const OTHER_INSTALL_ROOT = ".claude/skills/aih-gov-doctor";
const MANIFEST_PATH = "governance/upstream-artifact-manifest.json";
const SOURCE_NAMES = ["LICENSE", "SKILL.md", "profile.json"] as const;
type SourceName = (typeof SOURCE_NAMES)[number];

const fixtures = new URL(
  "../fixtures/governance-input/genuine-capture-20260921160506/",
  import.meta.url,
);
const assessmentBytes = readFileSync(new URL("assessment-profile.json", fixtures));
const sourceBytes = new Map<SourceName, Buffer>(
  SOURCE_NAMES.map((name) => [name, readFileSync(new URL(`source/${name}`, fixtures))]),
);

function bytesOf(name: SourceName): Buffer {
  const bytes = sourceBytes.get(name);
  if (bytes === undefined) throw new Error(`the committed fixture is missing ${name}`);
  return bytes;
}

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

function scanEvidenceBytes(): Uint8Array {
  const trust = configuredTrust(operator);
  const verified = verifyScanAttestationV2({
    envelope: operator.envelope,
    candidate: operator.candidate,
    annexArtifacts: operator.annexArtifacts,
    roots: trust.roots,
    expected: trust.expected,
  });
  return canonicalCoreOrganizationEvidenceEnvelopeV1Bytes(
    projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1({ verified, subjectDigest }),
  );
}

function envelopeOf(bytes: Uint8Array): OrganizationEvidenceEnvelopeV1 {
  const envelope = parseOrganizationEvidenceEnvelopeV1Bytes(bytes);
  if (envelope === undefined) throw new Error("evidence bytes are not a canonical V1 envelope");
  return envelope;
}

const scanEvidence = scanEvidenceBytes();
const scanEnvelope = envelopeOf(scanEvidence);

/**
 * An attributable organization assertion carries no sealed closure at all, so
 * consumption can never observe installed files through it.
 */
const assertionEnvelope: OrganizationEvidenceEnvelopeV1 = {
  format: "aih-organization-evidence",
  version: 1,
  subjectDigest,
  evidence: {
    kind: "assessment",
    id: "organization-review",
    summary: "The organization reviewed this exact item; this assertion seals no scanned material.",
    payloadDigest: `sha256:${sha("organization review payload")}`,
    artifactDigests: [`sha256:${sha("organization review record")}`],
  },
  attestor: "organization-review-board",
  issuedAt: scanEnvelope.issuedAt,
  notBefore: scanEnvelope.notBefore,
  expiresAt: scanEnvelope.expiresAt,
};
const assertionEvidence = Buffer.from(
  canonicalOrganizationEvidenceEnvelopeV1(assertionEnvelope),
  "utf8",
);

// --- authority: an administrator-protected policy bundle outside the target --

const NOW = new Date();
const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
const ISSUED_AT = iso(-120_000);
const EXPIRES_AT = iso(12 * 60 * 60 * 1000);
const NOW_ISO = NOW.toISOString();

function decisionFor(input: {
  readonly id: string;
  readonly evidence: OrganizationEvidenceEnvelopeV1;
}): GovernanceDecisionV2 {
  const evidenceDigest = organizationEvidenceEnvelopeDigestV1(input.evidence);
  return {
    format: "aih-governance-decision",
    version: 2,
    id: input.id,
    qualificationBasis: {
      kind: "organization-qualified",
      evidenceDigest,
      attestor: input.evidence.attestor,
    },
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
      id: input.evidence.evidence.id,
      digest: evidenceDigest,
      attestor: input.evidence.attestor,
    },
    issuer: "platform-security",
    actor: "security-admin",
    reason: "The organization reviewed this exact assessment-bound material.",
    issuedAt: ISSUED_AT,
    notBefore: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    disposition: "approved",
    acceptedFindings: [],
    acceptedGaps: [],
    conditions: [],
  };
}

const assertionDecision = decisionFor({
  id: "decision-observe-assertion-material",
  evidence: assertionEnvelope,
});
const scannedDecision = decisionFor({
  id: "decision-observe-scanned-material",
  evidence: scanEnvelope,
});

const adminRoot = realpathSync.native(
  mkdtempSync(join(realpathSync.native(tmpdir()), "aih-observation-admin-")),
);
const policyPath = join(adminRoot, "policies", "policy-bundle.json");
mkdirSync(dirname(policyPath), { recursive: true });
writeFileSync(
  policyPath,
  JSON.stringify({
    schemaVersion: 2,
    bundleVersion: "2026.09.1",
    issuer: "Acme platform security",
    issuedAt: ISSUED_AT,
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
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
      targets: ["claude"],
      decisions: [assertionDecision, scannedDecision],
      decisionRevocations: [],
    },
  }),
);

// --- the installed material and its manifest --------------------------------

interface ManifestFile {
  readonly path: string;
  readonly sha256: string;
}

function manifestFiles(installRoot: string): ManifestFile[] {
  return SOURCE_NAMES.map((name) => ({
    path: `${installRoot}/${name}`,
    sha256: `sha256:${sealedRecord(name).sha256}`,
  }));
}

function manifestFor(options: {
  readonly installRoot: string;
  readonly decisionId?: string;
  readonly files?: readonly ManifestFile[];
}) {
  return {
    format: "aih-upstream-artifact-manifest" as const,
    version: 1 as const,
    decisionId: options.decisionId ?? scannedDecision.id,
    subject: { kind: "agent" as const, id: "governance-quality", sourceDigest, subjectDigest },
    target: "claude",
    effect: "observe" as const,
    integration: { owner: "organization-platform", version: "1.0.0" },
    files: options.files ?? manifestFiles(options.installRoot),
  };
}

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  rmSync(adminRoot, { recursive: true, force: true });
});

/** Every path under a root, with its bytes, so a write of any kind is visible. */
function treeOf(root: string): string[] {
  const entries: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : 1,
    )) {
      const absolute = join(directory, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        entries.push(`directory ${relative}`);
        walk(absolute, relative);
      } else {
        entries.push(`file ${relative} ${sha(readFileSync(absolute))}`);
      }
    }
  };
  walk(root, "");
  return entries;
}

/** The exact tree, and the administrator's policy file, as consumption found them. */
let planted: { root: string; tree: string[]; policy: string } = {
  root: "",
  tree: [],
  policy: "",
};

interface ConsumeOptions {
  readonly installRoot?: string;
  readonly manifestPath?: string;
  readonly manifestBytes?: Uint8Array;
  readonly manifestDecisionId?: string;
  readonly manifestFileList?: readonly ManifestFile[];
  /** Replaces what is installed at one sealed name; `null` installs nothing. */
  readonly installed?: Partial<Record<SourceName, Buffer | null>>;
  readonly afterInstall?: (root: string, installRoot: string) => void;
  readonly evidence?: "scan" | "assertion";
  readonly route?: "catalog" | "organization";
  /** `false` supplies no observation input at all. */
  readonly observation?: false | { readonly manifestPath?: string; readonly installRoot?: string };
}

async function consume(options: ConsumeOptions = {}): Promise<ConsumeGovernanceInputV1Result> {
  const installRoot = options.installRoot ?? INSTALL_ROOT;
  const manifestPath = options.manifestPath ?? MANIFEST_PATH;
  const assertion = options.evidence === "assertion";
  const evidenceBytes = assertion ? assertionEvidence : scanEvidence;
  const decision = assertion ? assertionDecision : scannedDecision;

  const prepared = prepareGovernanceInputV1({
    route: options.route ?? "organization",
    subject: { kind: "agent", id: "governance-quality", source: genuineSource },
    request: { target: "claude", effect: "observe" },
    decisionReference: { id: decision.id, digest: governanceDecisionDigestV2(decision) },
    evidenceBytes,
    provenance: { catalogEntryId: "agent.aih.governance-quality.core-0-6-2" },
  });
  const artifacts = prepared.artifacts;
  if (artifacts === undefined) throw new Error("prepare failed");

  const root = mkdtempSync(join(tmpdir(), "aih-observation-"));
  roots.push(root);
  const write = (relative: string, bytes: Uint8Array): void => {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(bytes));
  };
  write(artifacts.evidence.path, artifacts.evidence.bytes);
  write(
    manifestPath,
    options.manifestBytes ??
      Buffer.from(
        canonicalUpstreamArtifactManifestV1(
          manifestFor({
            installRoot,
            decisionId: options.manifestDecisionId ?? decision.id,
            ...(options.manifestFileList === undefined ? {} : { files: options.manifestFileList }),
          }),
        ),
        "utf8",
      ),
  );
  for (const name of SOURCE_NAMES) {
    const installed = options.installed?.[name];
    const bytes = installed === undefined ? bytesOf(name) : installed;
    if (bytes !== null) write(`${installRoot}/${name}`, bytes);
  }
  options.afterInstall?.(root, installRoot);
  planted = { root, tree: treeOf(root), policy: sha(readFileSync(policyPath)) };

  return consumeGovernanceInputV1({
    bytes: artifacts.input.bytes,
    root,
    env: { AIH_ORG_POLICY: policyPath },
    now: NOW_ISO,
    ...(assertion
      ? {}
      : {
          scan: {
            adapter,
            request: {
              ...configuredTrust(operator),
              envelope: operator.envelope,
              candidate: operator.candidate,
              annexArtifacts: operator.annexArtifacts,
            },
          },
        }),
    assessment: { readAssessment: () => assessmentBytes },
    ...(options.observation === false
      ? {}
      : { observation: { manifestPath, installRoot, ...options.observation } }),
  });
}

describe("consume-level observation", () => {
  it("hashes the committed source files to the recorded seal", () => {
    for (const name of SOURCE_NAMES) {
      const record = sealedRecord(name);
      expect(sha(bytesOf(name))).toBe(record.sha256);
      expect(bytesOf(name).byteLength).toBe(record.byteLength);
    }
    expect(SOURCE_NAMES.map((name) => sealedRecord(name).byteLength)).toEqual([598, 787, 1126]);
  });

  it("observes the sealed closure installed at exact paths under the named root", async () => {
    const result = await consume();

    expect(result.status.structure).toBe("valid");
    expect(result.status.evidence).toBe("verified");
    expect(result.status.binding).toBe("bound");
    expect(result.status.authority).toBe("verified");
    expect(result.status.plan).toBe("prepared");
    expect(result.status.execution).toBe("observed");
    expect(result.status.outcome).toBe("observed");
    expect(result.status.reason).toBeUndefined();
    expect(result.diagnostics).toEqual([]);

    expect(result.observation?.installRoot).toBe(INSTALL_ROOT);
    expect(result.observation?.observationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.observation?.observedAt).toBe(NOW_ISO);
    expect(Date.parse(result.observation?.validUntil ?? "")).toBeGreaterThan(NOW.getTime());
    expect(result.observation?.files).toEqual(
      SOURCE_NAMES.map((name) => ({
        sealedPath: name,
        observedPath: `${INSTALL_ROOT}/${name}`,
        sha256: sealedRecord(name).sha256,
        byteLength: sealedRecord(name).byteLength,
      })),
    );

    // An observed result is never a claim that the whole item was scanned.
    expect(result.assessmentBinding?.itemCoverage.uncoveredPaths).toEqual(["aih-packs.json"]);
    expect(result.assessmentBinding?.itemCoverage.complete).toBe(false);
  });

  it("writes nothing anywhere while observing", async () => {
    const result = await consume();
    expect(result.status.execution).toBe("observed");
    // The snapshot must actually describe the planted root, or it proves nothing.
    expect(planted.tree).toContain(
      `file ${MANIFEST_PATH} ${sha(readFileSync(join(planted.root, MANIFEST_PATH)))}`,
    );
    expect(planted.tree.length).toBeGreaterThan(SOURCE_NAMES.length);
    expect(treeOf(planted.root)).toEqual(planted.tree);
    expect(sha(readFileSync(policyPath))).toBe(planted.policy);

    // A refusal writes nothing either.
    const refused = await consume({ installed: { LICENSE: null } });
    expect(refused.status.execution).toBe("refused");
    expect(treeOf(planted.root)).toEqual(planted.tree);
    expect(sha(readFileSync(policyPath))).toBe(planted.policy);
  });

  it("observes the same closure under a different explicit mapping", async () => {
    const result = await consume({ installRoot: OTHER_INSTALL_ROOT });
    expect(result.status.execution).toBe("observed");
    expect(result.observation?.installRoot).toBe(OTHER_INSTALL_ROOT);
    expect(result.observation?.files.map((file) => file.observedPath)).toEqual(
      SOURCE_NAMES.map((name) => `${OTHER_INSTALL_ROOT}/${name}`),
    );
    // The declared material root of the published assessment is not the mapping.
    expect(result.assessmentBinding?.materialRoot).toBe(INSTALL_ROOT);
  });

  it("refuses sealed bytes installed under each other's names", async () => {
    const result = await consume({
      installed: { LICENSE: bytesOf("SKILL.md"), "SKILL.md": bytesOf("LICENSE") },
    });
    expect(result.status.reason).toBe("observed-file-mismatch");
    expect(result.status.execution).toBe("refused");
    expect(result.status.outcome).toBe("refused");
    expect(result.status.plan).toBe("prepared");
    expect(result.observation).toBeUndefined();
  });

  it("refuses a renamed file even when its bytes are the sealed bytes", async () => {
    const renamed = manifestFiles(INSTALL_ROOT).map((file) =>
      file.path.endsWith("/SKILL.md") ? { ...file, path: `${file.path}.txt` } : file,
    );
    const result = await consume({
      manifestFileList: renamed,
      installed: { "SKILL.md": null },
      afterInstall: (root, installRoot) =>
        writeFileSync(join(root, installRoot, "SKILL.md.txt"), bytesOf("SKILL.md")),
    });
    expect(result.status.reason).toBe("observation-path-mismatch");
    expect(result.status.execution).toBe("refused");
  });

  it("refuses a missing installed file", async () => {
    const result = await consume({ installed: { "profile.json": null } });
    expect(result.status.reason).toBe("observed-file-unavailable");
  });

  it("refuses duplicated manifest rows and shared file identities", async () => {
    // The v1 manifest grammar already forbids a duplicate row, so a duplicate
    // substitution is refused at manifest custody, before the path set is even
    // compared. The one-to-one comparison keeps its own duplicate guard.
    const [license, , profile] = manifestFiles(INSTALL_ROOT);
    if (license === undefined || profile === undefined) throw new Error("missing manifest rows");
    const duplicateRows = await consume({
      manifestBytes: Buffer.from(
        JSON.stringify({
          ...manifestFor({ installRoot: INSTALL_ROOT }),
          files: [license, license, profile],
        }),
        "utf8",
      ),
    });
    expect(duplicateRows.status.reason).toBe("observation-manifest-mismatch");

    const hardLinked = await consume({
      afterInstall: (root, installRoot) => {
        mkdirSync(join(root, "aliases"), { recursive: true });
        linkSync(join(root, installRoot, "LICENSE"), join(root, "aliases", "LICENSE"));
      },
    });
    expect(hardLinked.status.reason).toBe("observed-file-unsafe");
  });

  it("refuses one changed byte", async () => {
    const changed = Buffer.from(bytesOf("profile.json"));
    const last = changed.byteLength - 1;
    changed[last] = changed[last] === 32 ? 33 : 32;
    const result = await consume({ installed: { "profile.json": changed } });
    expect(result.status.reason).toBe("observed-file-mismatch");
  });

  it("refuses a symlinked installed file", async () => {
    let symlinked = true;
    const result = await consume({
      installed: { LICENSE: null },
      afterInstall: (root, installRoot) => {
        try {
          symlinkSync(
            join(root, installRoot, "profile.json"),
            join(root, installRoot, "LICENSE"),
            process.platform === "win32" ? "file" : undefined,
          );
        } catch {
          symlinked = false;
          writeFileSync(join(root, installRoot, "LICENSE"), bytesOf("LICENSE"));
        }
      },
    });
    if (!symlinked) {
      expect(result.status.execution).toBe("observed");
      return;
    }
    expect(result.status.reason).toBe("observed-file-unsafe");
  });

  it("refuses a manifest of another version as an unknown contract version", async () => {
    const canonical = canonicalUpstreamArtifactManifestV1(
      manifestFor({ installRoot: INSTALL_ROOT }),
    );
    expect(canonical).toContain('"version":1');
    for (const declared of [
      canonical.replace('"version":1', '"version":2'),
      canonical.replace(
        '"format":"aih-upstream-artifact-manifest"',
        '"format":"aih-upstream-artifact-manifest-v2"',
      ),
    ]) {
      expect(declared).not.toBe(canonical);
      const result = await consume({ manifestBytes: Buffer.from(declared, "utf8") });
      // The shared code is told apart from the saved document's own version
      // refusal by the field: the manifest path, never the saved bytes.
      expect(result.status.reason).toBe("unknown-contract-version");
      expect(result.status.execution).toBe("refused");
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "unknown-contract-version",
          field: "observation.manifestPath",
        }),
      ]);
    }
    // Deliberately, decoded JSON that declares no manifest contract is another contract.
    for (const text of ["{}", "[]", "null"]) {
      const other = await consume({ manifestBytes: Buffer.from(text, "utf8") });
      expect(other.status.reason, text).toBe("unknown-contract-version");
    }
    // Bytes that are not JSON, and a v1 manifest that breaks v1, keep the existing code.
    const noncanonical = JSON.stringify(JSON.parse(canonical), null, 2);
    for (const text of ["{", noncanonical]) {
      const broken = await consume({ manifestBytes: Buffer.from(text, "utf8") });
      expect(broken.status.reason).toBe("observation-manifest-mismatch");
      expect(broken.diagnostics).toEqual([
        expect.objectContaining({ code: "observation-manifest-mismatch", field: "observation" }),
      ]);
    }
  });

  it("refuses a manifest issued for another decision", async () => {
    const result = await consume({ manifestDecisionId: assertionDecision.id });
    expect(result.status.reason).toBe("observation-manifest-mismatch");
    expect(result.status.execution).toBe("refused");
  });

  it("refuses a manifest digest the seal does not record", async () => {
    const foreign = manifestFiles(INSTALL_ROOT).map((file) =>
      file.path.endsWith("/LICENSE") ? { ...file, sha256: `sha256:${sha("other bytes")}` } : file,
    );
    const result = await consume({ manifestFileList: foreign });
    expect(result.status.reason).toBe("observation-outside-sealed-closure");
  });

  it("refuses an observation over evidence that seals nothing", async () => {
    const result = await consume({ evidence: "assertion" });
    expect(result.evidenceClaim).toBe("organization-assertion");
    expect(result.status.reason).toBe("observation-outside-sealed-closure");
    expect(result.status.execution).toBe("refused");
  });

  it("refuses an installation mapping that is not a bounded root-relative directory", async () => {
    for (const installRoot of ["../x", "/packs", "C:/packs", "", MANIFEST_PATH]) {
      const result = await consume({ observation: { installRoot } });
      expect(result.status.reason).toBe("observation-mapping-invalid");
      expect(result.status.execution).toBe("refused");
    }
    // A mapping that would swallow the evidence or the manifest is not separate.
    const swallowed = await consume({
      manifestPath: `${INSTALL_ROOT}/manifest.json`,
      observation: { manifestPath: `${INSTALL_ROOT}/manifest.json` },
    });
    expect(swallowed.status.reason).toBe("observation-mapping-invalid");
  });

  it("stays exactly the prepared-plan result when no observation is requested", async () => {
    const result = await consume({ observation: false });
    expect(result.status).toEqual({
      structure: "valid",
      evidence: "verified",
      binding: "bound",
      authority: "verified",
      plan: "prepared",
      execution: "not-attempted",
      outcome: "partial",
      reason: "observation-missing",
    });
    expect(result.observation).toBeUndefined();
    expect(result.diagnostics).toEqual([]);

    const observed = await consume();
    expect(observed.subjectDigest).toBe(result.subjectDigest);
    expect(observed.decisionDigest).toBe(result.decisionDigest);
    expect(observed.evidenceDigest).toBe(result.evidenceDigest);
    expect(observed.assessmentBinding).toEqual(result.assessmentBinding);
  });

  it("keeps the same observation when only the route label changes", async () => {
    const catalogLabelled = await consume({ route: "catalog" });
    const organizationLabelled = await consume({ route: "organization" });
    expect(catalogLabelled.status).toEqual(organizationLabelled.status);
    expect(catalogLabelled.observation).toEqual(organizationLabelled.observation);
    expect(catalogLabelled.status.execution).toBe("observed");
  });
});
