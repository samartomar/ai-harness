/**
 * The generic organization input contract.
 *
 * An application compiles a caller's selections and choices into deterministic
 * bytes (`prepareGovernanceInputV1`), and any installed consumer re-derives the
 * same verdict from exactly those bytes (`consumeGovernanceInputV1`) without the
 * authoring application. Nothing here executes an effect or manufactures
 * authority: Core derives every identity, and a saved document is a claim that
 * consumption must independently reproduce.
 *
 * Scan owns verification of its own attestation format; Core owns binding the
 * facts that verification returns to the selected subject and the authorized
 * decision. Core therefore never imports Scan — the caller injects Scan's public
 * functions plus explicitly configured trust and verification inputs, and Core
 * uses only the freshly verified result.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { type Cli, SUPPORTED_CLIS } from "../internals/clis.js";
import type { PlanContext } from "../internals/plan.js";
import { defaultRunner } from "../internals/proc.js";
import { makeHostAdapter } from "../platform/detect.js";
import { verifyPolicyAuthorityReceipt } from "./authority.js";
import { custodyOrganizationEvidenceV1 } from "./evidence-custody-v1.js";
import {
  type GovernanceDecisionSourceV2,
  GovernanceDecisionSourceV2Schema,
  type GovernanceDecisionV2,
  governanceDecisionDigestV2,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "./governance-decision-v2.js";
import {
  organizationEvidenceEnvelopeDigestV1,
  parseOrganizationEvidenceEnvelopeV1Bytes,
  verifyOrganizationQualificationV1,
} from "./qualification-v1.js";
import { resolveObservedEffect } from "./upstream-observation-receipt-v1.js";

export const GOVERNANCE_INPUT_V1_FORMAT = "aih-governance-input";
/** Bound the portable document before decoding hostile input. */
export const MAX_GOVERNANCE_INPUT_BYTES_V1 = 8_192;

const EFFECTS = ["configure", "install", "observe", "use"] as const;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const BARE_SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9-]{0,63}$/;

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Code-unit canonical JSON; the same algorithm the evidence envelope uses. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => ordinalCompare(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// --------------------------------------------------------------------------
// Refusals and statuses
// --------------------------------------------------------------------------

/** Closed, public-safe refusal category; never carries verifier output or a filesystem path. */
export type GovernanceInputRefusalV1 =
  // structure
  | "unknown-contract-version"
  | "malformed-bytes"
  | "oversize-bytes"
  | "non-canonical-bytes"
  | "invalid-input"
  | "derived-digest-mismatch"
  | "unsupported-target"
  | "unsupported-effect"
  // evidence
  | "invalid-evidence-path"
  | "unsafe-evidence-custody"
  | "evidence-unavailable"
  | "evidence-changed"
  | "evidence-digest-mismatch"
  | "evidence-subject-mismatch"
  | "evidence-reprojection-mismatch"
  // binding
  | "scan-verification-unavailable"
  | "scan-attestation-unverified"
  | "seal-digest-recomputation-mismatch"
  | "seal-toctou-mismatch"
  | "subject-digest-absent-from-sealed-closure"
  | "subject-digest-covered-but-not-selected"
  | "missing-repository-commit-provenance-record"
  | "missing-tarball-sha512-record"
  | "missing-distribution-file-record"
  | "missing-manifest-document-record"
  | "binding-claim-contradicted"
  // authority
  | "authority-unverified"
  | "authority-version"
  | "authority-not-current"
  | "decision-missing-or-mismatch"
  | "decision-rejected"
  | "decision-revoked"
  | "decision-not-current"
  | "decision-scope-mismatch"
  | "qualification-unverified"
  | "observation-missing";

/**
 * Five independent axes. `structure`, `evidence`, `binding`, `authority`, `plan`
 * and `execution` are never collapsed into one verdict: "compiled", "verified",
 * "approved" and "executed" stay different words.
 */
export interface GovernanceInputStatusV1 {
  readonly structure: "valid" | "invalid";
  readonly evidence: "verified" | "unverified" | "not-evaluated";
  /** A saved artifact may only ever claim a binding; solely consumption may confirm one. */
  readonly binding: "bound" | "claimed" | "mismatched" | "unbound" | "not-evaluated";
  readonly authority: "verified" | "unverified" | "not-evaluated";
  readonly plan: "prepared" | "refused" | "not-evaluated";
  /** v1 never executes an effect. */
  readonly execution: "not-attempted";
  readonly outcome: "prepared" | "partial" | "refused";
  readonly reason?: GovernanceInputRefusalV1;
}

export interface GovernanceInputDiagnosticV1 {
  readonly code: GovernanceInputRefusalV1;
  readonly field: string;
  readonly detail: string;
}

function diagnostic(
  code: GovernanceInputRefusalV1,
  field: string,
  detail: string,
): GovernanceInputDiagnosticV1 {
  return { code, field, detail };
}

// --------------------------------------------------------------------------
// Document
// --------------------------------------------------------------------------

const digestSchema = z.string().regex(SHA256, "must be a sha256 digest");
const stableIdSchema = z.string().regex(ID, "must be a bounded stable identifier");
const relativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value === value.trim() &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "must be a bounded root-relative path",
  );

const subjectSchema = z
  .object({
    kind: z.enum(["tool", "skill", "agent", "mcp", "package", "profile"]),
    id: stableIdSchema,
    source: GovernanceDecisionSourceV2Schema,
    sourceDigest: digestSchema,
    subjectDigest: digestSchema,
  })
  .strict();

/**
 * `bindingClaim` reproduces what the authoring application observed. It is a
 * reproduction aid only: consumption recomputes the binding from freshly
 * verified facts and refuses when the saved claim disagrees. A claim can never
 * upgrade a consume-time refusal.
 */
export const GovernanceInputV1Schema = z
  .object({
    bindingClaim: z
      .object({
        matchedPath: relativePathSchema,
        selectedClosureSha256: z.string().regex(BARE_SHA256),
        sourceTreeSha256: z.string().regex(BARE_SHA256),
      })
      .strict()
      .optional(),
    decisionReference: z.object({ digest: digestSchema, id: stableIdSchema }).strict(),
    evidence: z.object({ digest: digestSchema, path: relativePathSchema }).strict(),
    format: z.literal(GOVERNANCE_INPUT_V1_FORMAT),
    provenance: z
      .object({
        catalogEntryId: z.string().min(1).max(200).optional(),
        catalogIndexDigest: digestSchema.optional(),
        route: z.enum(["catalog", "organization"]),
      })
      .strict(),
    request: z
      .object({
        effect: z.enum(EFFECTS),
        target: z.enum(SUPPORTED_CLIS),
      })
      .strict(),
    subject: subjectSchema,
    version: z.literal(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const sourceDigest = governanceDecisionSourceDigestV2(value.subject.source);
    if (value.subject.sourceDigest !== sourceDigest) {
      ctx.addIssue({ code: "custom", message: "sourceDigest must bind the exact source" });
    }
    if (
      value.subject.subjectDigest !==
      governanceDecisionSubjectDigestV2({
        kind: value.subject.kind,
        id: value.subject.id,
        sourceDigest,
      })
    ) {
      ctx.addIssue({ code: "custom", message: "subjectDigest must bind the exact subject" });
    }
  });

export type GovernanceInputV1 = z.infer<typeof GovernanceInputV1Schema>;

export function canonicalGovernanceInputV1(value: GovernanceInputV1): string {
  return stableJson(value);
}

export function governanceInputDigestV1(value: GovernanceInputV1): string {
  return `sha256:${sha256Hex(`${GOVERNANCE_INPUT_V1_FORMAT}/v1\0${canonicalGovernanceInputV1(value)}`)}`;
}

/**
 * Parses only canonical UTF-8 JSON. Reformatting, duplicate members, a trailing
 * newline, a byte-order mark, and any unknown member all fail closed.
 */
export function parseGovernanceInputV1Bytes(bytes: Uint8Array): GovernanceInputV1 | undefined {
  if (bytes.byteLength > MAX_GOVERNANCE_INPUT_BYTES_V1) return undefined;
  let text: string;
  let raw: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = GovernanceInputV1Schema.safeParse(raw);
  if (!parsed.success || text !== canonicalGovernanceInputV1(parsed.data)) return undefined;
  return parsed.data;
}

// --------------------------------------------------------------------------
// Subject-to-content binding
// --------------------------------------------------------------------------

/**
 * The evidence kind Scan's projection emits. An envelope carrying this kind
 * claims verified scanner evidence, so consumption must verify the attestation
 * before it may treat that evidence as verified — whatever route the saved
 * document describes.
 */
export const SCAN_ATTESTATION_EVIDENCE_KIND_V1 = "scan-attestation-v2";

/** True when the envelope claims verified scanner evidence. */
export function claimsScanEvidenceV1(envelope: { evidence: { kind: string } }): boolean {
  return envelope.evidence.kind === SCAN_ATTESTATION_EVIDENCE_KIND_V1;
}

export type SubjectContentBindingRefusalV1 = Extract<
  GovernanceInputRefusalV1,
  | "seal-digest-recomputation-mismatch"
  | "seal-toctou-mismatch"
  | "subject-digest-absent-from-sealed-closure"
  | "subject-digest-covered-but-not-selected"
  | "missing-repository-commit-provenance-record"
  | "missing-tarball-sha512-record"
  | "missing-distribution-file-record"
  | "missing-manifest-document-record"
  | "invalid-input"
>;

export type SubjectContentBindingV1 =
  | {
      readonly status: "bound";
      readonly matchedPath: string;
      readonly matchedSha256: string;
      readonly selectedClosureSha256: string;
      readonly sourceTreeSha256: string;
    }
  | { readonly status: "unbound"; readonly reason: SubjectContentBindingRefusalV1 }
  | { readonly status: "mismatched"; readonly reason: SubjectContentBindingRefusalV1 };

const sealFileSchema = z
  .object({
    kind: z.literal("file"),
    path: z.string().min(1),
    sha256: z.string().regex(BARE_SHA256),
    byteLength: z.number().int().nonnegative(),
  })
  .strict();
const sealDirectorySchema = z
  .object({ kind: z.literal("directory"), path: z.string().min(1) })
  .strict();
const sealSchema = z
  .object({
    protocol: z.literal("SourceSealV2"),
    algorithm: z.literal("code-unit-canonical-json-v1"),
    entries: z.array(z.union([sealFileSchema, sealDirectorySchema])).min(1),
    selectedClosurePaths: z.array(z.string().min(1)).min(1),
    selectedFiles: z.array(sealFileSchema).min(1),
    sourceTreeSha256: z.string().regex(BARE_SHA256),
    selectedClosureSha256: z.string().regex(BARE_SHA256),
    sealedSnapshotSha256: z.string().regex(BARE_SHA256),
  })
  .strict();

/**
 * The digest a source identity commits to, or the exact record the identity
 * would need before a binding is even possible. The seal retains
 * `path + sha256 + byteLength` and never file contents, so Core cannot
 * re-derive a digest in another scheme — an identity in another scheme names a
 * missing provenance record rather than an impossible source type.
 */
function identityContentDigest(
  source: GovernanceDecisionSourceV2,
): { digest: string } | { missing: SubjectContentBindingRefusalV1 } {
  switch (source.type) {
    case "aih":
      return { digest: source.revision.slice("sha256:".length) };
    case "pypi":
      return { digest: source.sha256.slice("sha256:".length) };
    case "remote":
      return { digest: source.contentDigest.slice("sha256:".length) };
    case "oci":
      return { digest: source.manifestDigest.slice("sha256:".length) };
    case "github":
      // A git object id is sha1 over `blob <len>\0` + content and also covers
      // tree structure and modes, none of which the seal retains.
      return { missing: "missing-repository-commit-provenance-record" };
    case "npm":
      return { missing: "missing-tarball-sha512-record" };
  }
}

/**
 * Binds a subject's source identity to the content a scan actually covered.
 *
 * `expected` must come from freshly verified attestation facts, never from a
 * caller's saved document: Core recomputes every seal digest from the seal's own
 * records and requires them to equal those verified facts before any lookup.
 */
export function verifySubjectContentBindingV1(input: {
  readonly source: unknown;
  readonly seal: unknown;
  readonly expected: { readonly sourceTreeSha256: string; readonly selectedClosureSha256: string };
}): SubjectContentBindingV1 {
  const source = GovernanceDecisionSourceV2Schema.safeParse(input.source);
  const seal = sealSchema.safeParse(input.seal);
  if (!source.success || !seal.success) return { status: "unbound", reason: "invalid-input" };
  if (
    !BARE_SHA256.test(input.expected.sourceTreeSha256) ||
    !BARE_SHA256.test(input.expected.selectedClosureSha256)
  )
    return { status: "unbound", reason: "invalid-input" };

  const records = seal.data;
  const sourceTreeSha256 = sha256Hex(
    stableJson({ protocol: "SourceTreeV2", entries: records.entries }),
  );
  const selectedClosureSha256 = sha256Hex(
    stableJson({ protocol: "SelectedClosureV2", files: records.selectedFiles }),
  );
  const sealedSnapshotSha256 = sha256Hex(
    stableJson({ protocol: "SealedSnapshotV2", sourceTreeSha256, selectedClosureSha256 }),
  );
  if (
    sourceTreeSha256 !== records.sourceTreeSha256 ||
    selectedClosureSha256 !== records.selectedClosureSha256 ||
    sealedSnapshotSha256 !== records.sealedSnapshotSha256 ||
    sourceTreeSha256 !== input.expected.sourceTreeSha256 ||
    selectedClosureSha256 !== input.expected.selectedClosureSha256
  )
    return { status: "mismatched", reason: "seal-digest-recomputation-mismatch" };

  const identity = identityContentDigest(source.data);
  if ("missing" in identity) return { status: "unbound", reason: identity.missing };

  const selected = records.selectedFiles.find((file) => file.sha256 === identity.digest);
  if (selected !== undefined) {
    return {
      status: "bound",
      matchedPath: selected.path,
      matchedSha256: selected.sha256,
      selectedClosureSha256,
      sourceTreeSha256,
    };
  }
  const covered = records.entries.some(
    (entry) => entry.kind === "file" && entry.sha256 === identity.digest,
  );
  return {
    status: "unbound",
    reason: covered
      ? "subject-digest-covered-but-not-selected"
      : "subject-digest-absent-from-sealed-closure",
  };
}

// --------------------------------------------------------------------------
// Compile / save
// --------------------------------------------------------------------------

export interface PrepareGovernanceInputV1Input {
  readonly route: "catalog" | "organization";
  /** Catalog-provided or organization-provided identity; Core derives both digests. */
  readonly subject: {
    readonly kind: GovernanceInputV1["subject"]["kind"];
    readonly id: string;
    readonly source: unknown;
  };
  readonly request: { readonly target: string; readonly effect: string };
  readonly decisionReference: { readonly id: string; readonly digest: string };
  /** Exactly the canonical organization evidence envelope bytes. */
  readonly evidenceBytes: Uint8Array;
  readonly evidencePath?: string;
  readonly bindingClaim?: {
    readonly matchedPath: string;
    readonly selectedClosureSha256: string;
    readonly sourceTreeSha256: string;
  };
  readonly provenance?: {
    readonly catalogEntryId?: string;
    readonly catalogIndexDigest?: string;
  };
}

export interface GovernanceInputArtifactV1 {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export interface PrepareGovernanceInputV1Result {
  readonly status: GovernanceInputStatusV1;
  readonly artifacts?: {
    readonly input: GovernanceInputArtifactV1;
    readonly evidence: GovernanceInputArtifactV1;
  };
  readonly diagnostics: readonly GovernanceInputDiagnosticV1[];
}

export const DEFAULT_GOVERNANCE_EVIDENCE_PATH_V1 = ".aih/evidence/organization-evidence.json";

function invalidPrepare(
  diagnostics: readonly GovernanceInputDiagnosticV1[],
): PrepareGovernanceInputV1Result {
  return {
    status: {
      structure: "invalid",
      evidence: "not-evaluated",
      binding: "not-evaluated",
      authority: "not-evaluated",
      plan: "not-evaluated",
      execution: "not-attempted",
      outcome: "refused",
      reason: diagnostics[0]?.code ?? "invalid-input",
    },
    diagnostics,
  };
}

/**
 * Deterministic compile/save. Pure: no filesystem, no network, no authority, no
 * effect. Core derives every identity from the caller's selections, so a caller
 * cannot assert a digest it did not earn.
 */
export function prepareGovernanceInputV1(
  input: PrepareGovernanceInputV1Input,
): PrepareGovernanceInputV1Result {
  const diagnostics: GovernanceInputDiagnosticV1[] = [];
  const source = GovernanceDecisionSourceV2Schema.safeParse(input.subject?.source);
  if (!source.success) {
    diagnostics.push(
      diagnostic("invalid-input", "subject.source", "source identity is not an exact V2 source"),
    );
    return invalidPrepare(diagnostics);
  }
  if (!SUPPORTED_CLIS.includes(input.request?.target as Cli)) {
    diagnostics.push(
      diagnostic("unsupported-target", "request.target", "target is not a supported code target"),
    );
  }
  if (!(EFFECTS as readonly string[]).includes(input.request?.effect)) {
    diagnostics.push(
      diagnostic("unsupported-effect", "request.effect", "effect is not a governed effect"),
    );
  }
  if (diagnostics.length > 0) return invalidPrepare(diagnostics);

  const sourceDigest = governanceDecisionSourceDigestV2(source.data);
  const subjectDigest = governanceDecisionSubjectDigestV2({
    kind: input.subject.kind,
    id: input.subject.id,
    sourceDigest,
  });

  const envelope = parseOrganizationEvidenceEnvelopeV1Bytes(input.evidenceBytes);
  if (envelope === undefined) {
    diagnostics.push(
      diagnostic("malformed-bytes", "evidenceBytes", "evidence is not a canonical V1 envelope"),
    );
    return invalidPrepare(diagnostics);
  }
  if (envelope.subjectDigest !== subjectDigest) {
    diagnostics.push(
      diagnostic(
        "evidence-subject-mismatch",
        "evidence.subjectDigest",
        "evidence does not describe the selected subject",
      ),
    );
    return invalidPrepare(diagnostics);
  }

  const document: GovernanceInputV1 = {
    ...(input.bindingClaim === undefined ? {} : { bindingClaim: input.bindingClaim }),
    decisionReference: {
      digest: input.decisionReference?.digest ?? "",
      id: input.decisionReference?.id ?? "",
    },
    evidence: {
      digest: organizationEvidenceEnvelopeDigestV1(envelope),
      path: input.evidencePath ?? DEFAULT_GOVERNANCE_EVIDENCE_PATH_V1,
    },
    format: GOVERNANCE_INPUT_V1_FORMAT,
    provenance: {
      ...(input.provenance?.catalogEntryId === undefined
        ? {}
        : { catalogEntryId: input.provenance.catalogEntryId }),
      ...(input.provenance?.catalogIndexDigest === undefined
        ? {}
        : { catalogIndexDigest: input.provenance.catalogIndexDigest }),
      route: input.route,
    },
    request: {
      effect: input.request.effect as GovernanceInputV1["request"]["effect"],
      target: input.request.target as Cli,
    },
    subject: {
      kind: input.subject.kind,
      id: input.subject.id,
      source: source.data,
      sourceDigest,
      subjectDigest,
    },
    version: 1,
  };

  const validated = GovernanceInputV1Schema.safeParse(document);
  if (!validated.success) {
    diagnostics.push(
      diagnostic("invalid-input", "document", "prepared document failed its own contract"),
    );
    return invalidPrepare(diagnostics);
  }
  const canonical = canonicalGovernanceInputV1(validated.data);
  const bytes = Buffer.from(canonical, "utf8");
  if (bytes.byteLength > MAX_GOVERNANCE_INPUT_BYTES_V1) {
    diagnostics.push(diagnostic("oversize-bytes", "document", "document exceeds the byte ceiling"));
    return invalidPrepare(diagnostics);
  }

  return {
    status: {
      structure: "valid",
      evidence: "unverified",
      binding: input.bindingClaim === undefined ? "not-evaluated" : "claimed",
      authority: "not-evaluated",
      plan: "not-evaluated",
      execution: "not-attempted",
      outcome: "prepared",
    },
    artifacts: {
      input: {
        path: "governance-input.json",
        bytes,
        digest: governanceInputDigestV1(validated.data),
      },
      evidence: {
        path: validated.data.evidence.path,
        bytes: Buffer.from(input.evidenceBytes),
        digest: validated.data.evidence.digest,
      },
    },
    diagnostics,
  };
}

// --------------------------------------------------------------------------
// Independent consume
// --------------------------------------------------------------------------

/**
 * Scan's public functions, injected by the consumer. Core never imports Scan:
 * Scan owns verification of its own format, Core owns binding the verified facts
 * to the selected subject and the authorized decision.
 *
 * Core states only that it passes `unknown`. A consumer holding Scan's concrete
 * types narrows at its own seam, e.g.
 * `(value) => canonicalCoreOrganizationEvidenceEnvelopeV1Bytes(value as CoreOrganizationEvidenceEnvelopeV1)`.
 */
export interface ScanVerificationAdapterV1 {
  readonly verifyScanAttestationV2: (input: unknown) => unknown;
  readonly projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1: (input: unknown) => unknown;
  readonly canonicalCoreOrganizationEvidenceEnvelopeV1Bytes: (value: unknown) => Uint8Array;
}

/**
 * The original attestation, its required supporting artifacts, and explicitly
 * configured trust and verification inputs. Trust never comes from the imported
 * file alone: `roots` and `expected` are supplied by the consumer's own
 * configuration and are what make the verification meaningful.
 */
export interface ScanVerificationRequestV1 {
  readonly envelope: unknown;
  readonly candidate: unknown;
  readonly roots: unknown;
  readonly expected: unknown;
  readonly annexArtifacts: unknown;
  readonly seenReplayIdentities?: unknown;
}

export interface ConsumeGovernanceInputV1Input {
  readonly bytes: Uint8Array;
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now?: string;
  readonly scan?: {
    readonly adapter: ScanVerificationAdapterV1;
    readonly request: ScanVerificationRequestV1;
  };
}

export interface ConsumeGovernanceInputV1Result {
  readonly status: GovernanceInputStatusV1;
  readonly subjectDigest?: string;
  readonly decisionDigest?: string;
  readonly evidenceDigest?: string;
  /**
   * What the evidence envelope claimed to be. `scan-attestation-v2` is reported
   * only once the attestation actually verified; an organization assertion is
   * never reported as verified scanner evidence.
   */
  readonly evidenceClaim?: "scan-attestation-v2" | "organization-assertion";
  readonly matchedPath?: string;
  readonly authorityTransport?: "github-attestation" | "policy-file";
  readonly diagnostics: readonly GovernanceInputDiagnosticV1[];
}

function refuse(
  status: Omit<GovernanceInputStatusV1, "outcome" | "execution">,
  diagnostics: readonly GovernanceInputDiagnosticV1[],
  extra: Omit<ConsumeGovernanceInputV1Result, "status" | "diagnostics"> = {},
): ConsumeGovernanceInputV1Result {
  return {
    status: { ...status, execution: "not-attempted", outcome: "refused" },
    diagnostics,
    ...extra,
  };
}

interface VerifiedScanFacts {
  readonly subjectSha256: string;
  readonly coverageSha256: string;
  readonly seal: unknown;
}

function verifiedScanFacts(verified: unknown): VerifiedScanFacts | undefined {
  if (typeof verified !== "object" || verified === null) return undefined;
  const facts = (verified as { facts?: unknown }).facts;
  if (typeof facts !== "object" || facts === null) return undefined;
  const typed = facts as {
    subject?: { sha256?: unknown };
    coverage?: { sha256?: unknown };
    sourceSeals?: { before?: unknown; after?: unknown };
  };
  const subjectSha256 = typed.subject?.sha256;
  const coverageSha256 = typed.coverage?.sha256;
  const seal = typed.sourceSeals?.before;
  if (typeof subjectSha256 !== "string" || typeof coverageSha256 !== "string") return undefined;
  if (stableJson(seal) !== stableJson(typed.sourceSeals?.after)) return undefined;
  return { subjectSha256, coverageSha256, seal };
}

function planContext(root: string, env: NodeJS.ProcessEnv): PlanContext {
  const run = defaultRunner;
  return {
    root,
    contextDir: ".ai-context",
    apply: false,
    verify: true,
    json: true,
    run,
    host: makeHostAdapter({ run, env }),
    env,
    options: {},
  };
}

/**
 * Re-derives the whole verdict from exactly the saved bytes. Every identity is
 * recomputed, the scan attestation is verified afresh through the caller's
 * configured trust inputs, the organization evidence is reprojected from that
 * verified result and required to match the saved bytes, and only then are
 * authority and qualification consulted. No effect is ever executed.
 */
export async function consumeGovernanceInputV1(
  input: ConsumeGovernanceInputV1Input,
): Promise<ConsumeGovernanceInputV1Result> {
  const notEvaluated = {
    evidence: "not-evaluated",
    binding: "not-evaluated",
    authority: "not-evaluated",
    plan: "not-evaluated",
  } as const;

  const document = parseGovernanceInputV1Bytes(input.bytes);
  if (document === undefined) {
    // Separate an unknown contract version from ordinary malformation so the
    // fail-closed version refusal is visible rather than folded into parsing.
    let reason: GovernanceInputRefusalV1 = "malformed-bytes";
    if (input.bytes.byteLength > MAX_GOVERNANCE_INPUT_BYTES_V1) reason = "oversize-bytes";
    else {
      try {
        const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes)) as {
          format?: unknown;
          version?: unknown;
        };
        if (raw?.format !== GOVERNANCE_INPUT_V1_FORMAT || raw?.version !== 1)
          reason = "unknown-contract-version";
        else reason = "non-canonical-bytes";
      } catch {
        reason = "malformed-bytes";
      }
    }
    return refuse({ structure: "invalid", ...notEvaluated, reason }, [
      diagnostic(reason, "bytes", "saved document did not survive its own contract"),
    ]);
  }

  const subjectDigest = document.subject.subjectDigest;
  const base = { structure: "valid" as const, ...notEvaluated };

  // --- evidence custody, then reprojection from the same verified result ----
  const custody = custodyOrganizationEvidenceV1(input.root, document.evidence.path);
  if ("problem" in custody) {
    return refuse({ ...base, evidence: "unverified", reason: custody.problem }, [
      diagnostic(custody.problem, "evidence.path", "evidence file custody failed"),
    ]);
  }
  const envelope = parseOrganizationEvidenceEnvelopeV1Bytes(custody.evidence.bytes);
  if (envelope === undefined) {
    return refuse({ ...base, evidence: "unverified", reason: "malformed-bytes" }, [
      diagnostic("malformed-bytes", "evidence", "evidence file is not a canonical V1 envelope"),
    ]);
  }
  const evidenceDigest = organizationEvidenceEnvelopeDigestV1(envelope);
  if (evidenceDigest !== document.evidence.digest) {
    return refuse({ ...base, evidence: "unverified", reason: "evidence-digest-mismatch" }, [
      diagnostic(
        "evidence-digest-mismatch",
        "evidence.digest",
        "evidence bytes are not the saved bytes",
      ),
    ]);
  }
  if (envelope.subjectDigest !== subjectDigest) {
    return refuse({ ...base, evidence: "unverified", reason: "evidence-subject-mismatch" }, [
      diagnostic(
        "evidence-subject-mismatch",
        "evidence.subjectDigest",
        "evidence does not describe the selected subject",
      ),
    ]);
  }

  // --- binding, from freshly verified scan facts only -----------------------
  //
  // What must be verified follows the evidence being claimed, never the saved
  // route label. `provenance.route` is descriptive metadata: relabelling
  // organization scan evidence as a catalog selection removes nothing, because
  // the requirement is read from the evidence envelope itself.
  let binding: SubjectContentBindingV1 | undefined;
  let verified: unknown;
  if (claimsScanEvidenceV1(envelope)) {
    if (input.scan === undefined) {
      return refuse(
        {
          ...base,
          binding: "unbound",
          evidence: "unverified",
          reason: "scan-verification-unavailable",
        },
        [
          diagnostic(
            "scan-verification-unavailable",
            "evidence.kind",
            "evidence claims verified scanner evidence, which requires a configured scan verification adapter and trust inputs",
          ),
        ],
        { subjectDigest, evidenceDigest },
      );
    }
    try {
      verified = input.scan.adapter.verifyScanAttestationV2({
        envelope: input.scan.request.envelope,
        candidate: input.scan.request.candidate,
        roots: input.scan.request.roots,
        expected: input.scan.request.expected,
        annexArtifacts: input.scan.request.annexArtifacts,
        ...(input.scan.request.seenReplayIdentities === undefined
          ? {}
          : { seenReplayIdentities: input.scan.request.seenReplayIdentities }),
      });
    } catch {
      return refuse(
        { ...base, binding: "unbound", reason: "scan-attestation-unverified" },
        [
          diagnostic(
            "scan-attestation-unverified",
            "scan.request",
            "attestation did not verify against the configured trust and verification inputs",
          ),
        ],
        { subjectDigest },
      );
    }
    const facts = verifiedScanFacts(verified);
    if (facts === undefined) {
      return refuse(
        { ...base, binding: "mismatched", reason: "seal-toctou-mismatch" },
        [
          diagnostic(
            "seal-toctou-mismatch",
            "scan.verified.facts",
            "verified facts did not expose a single consistent sealed closure",
          ),
        ],
        { subjectDigest },
      );
    }
    binding = verifySubjectContentBindingV1({
      source: document.subject.source,
      seal: facts.seal,
      expected: {
        sourceTreeSha256: facts.subjectSha256,
        selectedClosureSha256: facts.coverageSha256,
      },
    });
    if (binding.status !== "bound") {
      return refuse(
        { ...base, binding: binding.status, reason: binding.reason },
        [
          diagnostic(
            binding.reason,
            "subject.source",
            "the selected subject's source identity is not proven present in the scanned closure",
          ),
        ],
        { subjectDigest },
      );
    }
    if (
      document.bindingClaim !== undefined &&
      (document.bindingClaim.matchedPath !== binding.matchedPath ||
        document.bindingClaim.selectedClosureSha256 !== binding.selectedClosureSha256 ||
        document.bindingClaim.sourceTreeSha256 !== binding.sourceTreeSha256)
    ) {
      return refuse(
        { ...base, binding: "mismatched", reason: "binding-claim-contradicted" },
        [
          diagnostic(
            "binding-claim-contradicted",
            "bindingClaim",
            "the saved claim disagrees with the independently recomputed binding",
          ),
        ],
        { subjectDigest },
      );
    }
  }
  if (verified !== undefined && input.scan !== undefined) {
    let reprojected: Uint8Array | undefined;
    try {
      reprojected = input.scan.adapter.canonicalCoreOrganizationEvidenceEnvelopeV1Bytes(
        input.scan.adapter.projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1({
          verified,
          subjectDigest,
        }),
      );
    } catch {
      reprojected = undefined;
    }
    if (
      reprojected === undefined ||
      !Buffer.from(reprojected).equals(Buffer.from(custody.evidence.bytes))
    ) {
      return refuse(
        {
          ...base,
          binding: "bound",
          evidence: "unverified",
          reason: "evidence-reprojection-mismatch",
        },
        [
          diagnostic(
            "evidence-reprojection-mismatch",
            "evidence",
            "evidence reprojected from the verified attestation does not equal the saved evidence",
          ),
        ],
        {
          subjectDigest,
          evidenceDigest,
          ...(binding?.status === "bound" ? { matchedPath: binding.matchedPath } : {}),
        },
      );
    }
  }

  const evidenceBase = {
    structure: "valid" as const,
    evidence: "verified" as const,
    binding: binding?.status === "bound" ? ("bound" as const) : ("not-evaluated" as const),
    authority: "not-evaluated" as const,
    plan: "not-evaluated" as const,
  };
  const found = {
    subjectDigest,
    evidenceDigest,
    evidenceClaim: claimsScanEvidenceV1(envelope)
      ? ("scan-attestation-v2" as const)
      : ("organization-assertion" as const),
    ...(binding?.status === "bound" ? { matchedPath: binding.matchedPath } : {}),
  };

  // --- authority ------------------------------------------------------------
  const ctx = planContext(input.root, input.env);
  const authority = await verifyPolicyAuthorityReceipt(ctx);
  if (authority.authority === undefined) {
    return refuse(
      { ...evidenceBase, authority: "unverified", reason: "authority-unverified" },
      [
        diagnostic(
          "authority-unverified",
          "authority",
          "no verified organization authority is available",
        ),
      ],
      found,
    );
  }
  if (authority.authority.receipt.version !== 3) {
    return refuse(
      { ...evidenceBase, authority: "unverified", reason: "authority-version" },
      [
        diagnostic(
          "authority-version",
          "authority.receipt.version",
          "authority receipt is not version 3",
        ),
      ],
      found,
    );
  }
  const authorityTransport = authority.authority.source;
  if (!custody.evidence.unchanged()) {
    return refuse(
      {
        ...evidenceBase,
        authority: "verified",
        evidence: "unverified",
        reason: "evidence-changed",
      },
      [diagnostic("evidence-changed", "evidence", "evidence bytes changed during verification")],
      { ...found, ...(authorityTransport === undefined ? {} : { authorityTransport }) },
    );
  }
  const decision: GovernanceDecisionV2 | undefined = authority.authority.receipt.decisions.find(
    (candidate) =>
      candidate.id === document.decisionReference.id &&
      governanceDecisionDigestV2(candidate) === document.decisionReference.digest,
  );
  const withAuthority = {
    ...found,
    ...(authorityTransport === undefined ? {} : { authorityTransport }),
    ...(decision === undefined ? {} : { decisionDigest: governanceDecisionDigestV2(decision) }),
  };
  if (decision === undefined) {
    return refuse(
      { ...evidenceBase, authority: "verified", reason: "decision-missing-or-mismatch" },
      [
        diagnostic(
          "decision-missing-or-mismatch",
          "decisionReference",
          "the referenced decision is absent from the verified authority",
        ),
      ],
      withAuthority,
    );
  }
  if (decision.subject.subjectDigest !== subjectDigest) {
    return refuse(
      { ...evidenceBase, authority: "verified", reason: "decision-scope-mismatch" },
      [
        diagnostic(
          "decision-scope-mismatch",
          "decisionReference",
          "the authorized decision does not cover the selected subject",
        ),
      ],
      withAuthority,
    );
  }

  const now = input.now ?? new Date().toISOString();
  const qualification = verifyOrganizationQualificationV1({
    authority: authority.authority,
    bytes: custody.evidence.bytes,
    decisionReference: {
      id: document.decisionReference.id,
      digest: document.decisionReference.digest,
    },
    effect: document.request.effect,
    now,
    subject: decision.subject,
    supportedTargets: SUPPORTED_CLIS,
    target: document.request.target,
  });
  if (qualification === undefined) {
    return refuse(
      {
        ...evidenceBase,
        authority: "verified",
        plan: "refused",
        reason: "qualification-unverified",
      },
      [
        diagnostic(
          "qualification-unverified",
          "qualification",
          "evidence and decision did not mint a current qualification",
        ),
      ],
      withAuthority,
    );
  }

  // --- plan: resolve the effect without executing it ------------------------
  const effective = resolveObservedEffect({
    authority: authority.authority,
    decisionReference: {
      id: document.decisionReference.id,
      digest: document.decisionReference.digest,
    },
    qualification,
    subject: decision.subject,
    target: document.request.target,
    effect: document.request.effect,
    supportedTargets: SUPPORTED_CLIS,
    now,
    expectedVerifier: { id: "governance-input", version: "1", digest: `sha256:${"0".repeat(64)}` },
    expectedInstalled: { id: "governance-input", digest: `sha256:${"0".repeat(64)}` },
    expectedIntegration: { mode: "upstream-managed", owner: "governance-input", version: "1" },
  });
  if (effective.state !== "observation-missing") {
    const reason = (
      [
        "authority-not-current",
        "decision-rejected",
        "decision-revoked",
        "decision-not-current",
        "decision-scope-mismatch",
      ] as const
    ).includes(effective.state as never)
      ? (effective.state as GovernanceInputRefusalV1)
      : "qualification-unverified";
    return refuse(
      { ...evidenceBase, authority: "verified", plan: "refused", reason },
      [diagnostic(reason, "plan", "effect resolution refused")],
      withAuthority,
    );
  }

  return {
    status: {
      structure: "valid",
      evidence: "verified",
      binding: evidenceBase.binding,
      authority: "verified",
      plan: "prepared",
      execution: "not-attempted",
      outcome: "partial",
      reason: "observation-missing",
    },
    diagnostics: [],
    ...withAuthority,
  };
}
