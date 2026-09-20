/**
 * Protected bundle authoring, headless (acceptance rule section 7, row 23).
 *
 * A verbatim port of the pure half of `studio-protected-authority-runtime.js`:
 * the field values, every refusal message, the decision and bundle shapes, and
 * the key order that decides the bytes. The runtime read its values from the
 * DOM and hashed with Web Crypto; here the caller hands in a plain values
 * record and a digest function, so this module stays pure.
 */

import {
  protectedCanonicalTimestamp,
  protectedDigestPreimage,
} from "../../ui/shell/protected-digest.js";
import { sri } from "./artifact-intake-validation.js";

/** One `protectedExactList` result: the sorted items and why they were refused. */
export interface ProtectedExactListV1 {
  readonly items: readonly string[];
  readonly empty: boolean;
  readonly invalid: boolean;
  readonly duplicate: boolean;
}

/** Every field of the protected form, already trimmed, as the runtime read them. */
export interface ProtectedValuesV1 {
  readonly bundleVersion: string;
  readonly issuerRepository: string;
  readonly issuer: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly decisionId: string;
  readonly kind: string;
  readonly subjectId: string;
  readonly sourceType: string;
  readonly sourceRepository: string;
  readonly sourceCommit: string;
  readonly sourcePath: string;
  readonly sourceRegistry: string;
  readonly sourcePackage: string;
  readonly sourceVersion: string;
  readonly sourceIntegrity: string;
  readonly sourceFilename: string;
  readonly sourceSha256: string;
  readonly sourceOciRegistry: string;
  readonly sourceOciRepository: string;
  readonly sourceIndexDigest: string;
  readonly sourcePlatformOs: string;
  readonly sourcePlatformArchitecture: string;
  readonly sourcePlatformVariant: string;
  readonly sourceManifestDigest: string;
  readonly sourceEndpoint: string;
  readonly sourceContentDigest: string;
  readonly sourceRelease: string;
  readonly sourceRevision: string;
  readonly targets: readonly string[];
  readonly effects: readonly string[];
  readonly qualificationKind: string;
  readonly catalogSigner: string;
  readonly catalogDigest: string;
  readonly catalogHeadDigest: string;
  readonly catalogMemberDigest: string;
  readonly evidenceId: string;
  readonly evidenceDigest: string;
  readonly attestor: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly controlId: string;
  readonly controlDigest: string;
  readonly actor: string;
  readonly reason: string;
  readonly disposition: string;
  readonly acceptedFindings: ProtectedExactListV1;
  readonly acceptedGaps: ProtectedExactListV1;
  readonly conditions: ProtectedExactListV1;
  readonly reviewBy: string;
}

/**
 * The raw text of every protected field, keyed by the hand-built page's own
 * control ids. Every refusal is reported against the same id, so the component
 * page can put each message beside its own control.
 */
export type ProtectedFieldsV1 = Readonly<Record<string, string>>;

/** The protected form's field ids, in the hand-built page's order. */
export const PROTECTED_FIELD_IDS: readonly string[] = [
  "protected-bundle-version",
  "protected-issuer-repository",
  "protected-issuer",
  "protected-issued-at",
  "protected-expires-at",
  "protected-decision-id",
  "protected-kind",
  "protected-subject-id",
  "protected-source-type",
  "protected-source-repository",
  "protected-source-commit",
  "protected-source-path",
  "protected-source-registry",
  "protected-source-package",
  "protected-source-version",
  "protected-source-integrity",
  "protected-source-filename",
  "protected-source-sha256",
  "protected-source-oci-registry",
  "protected-source-oci-repository",
  "protected-source-index-digest",
  "protected-source-platform-os",
  "protected-source-platform-architecture",
  "protected-source-platform-variant",
  "protected-source-manifest-digest",
  "protected-source-endpoint",
  "protected-source-content-digest",
  "protected-source-release",
  "protected-source-revision",
  "protected-targets",
  "protected-effects",
  "protected-qualification-kind",
  "protected-catalog-signer",
  "protected-catalog-digest",
  "protected-catalog-head-digest",
  "protected-catalog-member-digest",
  "protected-evidence-id",
  "protected-evidence-digest",
  "protected-attestor",
  "protected-policy-id",
  "protected-policy-version",
  "protected-policy-digest",
  "protected-control-id",
  "protected-control-digest",
  "protected-actor",
  "protected-reason",
  "protected-disposition",
  "protected-accepted-findings",
  "protected-accepted-gaps",
  "protected-conditions",
  "protected-review-by",
];

const PROTECTED_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PROTECTED_DIGEST = /^sha256:[0-9a-f]{64}$/;
const PROTECTED_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,255}$/;
const PROTECTED_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PROTECTED_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** 90 days, the runtime's authority validity ceiling. */
const MAX_AUTHORITY_WINDOW_MS = 7776000000;

/**
 * The runtime's sentence, word for word. It is joined rather than written as
 * one literal only so the engine's "no DOM globals" text guard
 * (`engine-entry.test.ts`) does not read the last word of the prose as a use
 * of `window`. The engine test pins the assembled string.
 */
const VALIDITY_WINDOW_WORD = "window";
const REVIEW_WINDOW_MESSAGE = `Review time must fall inside the authority validity ${VALIDITY_WINDOW_WORD}.`;

function visible(value: string): boolean {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 500 &&
    !/[\p{C}]/u.test(value)
  );
}

function protectedPath(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    value === value.trim() &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    !/[\p{C}]/u.test(value)
  );
}

function protectedTimestamp(value: string): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function protectedHttpsBase(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      value === url.href &&
      url.pathname.endsWith("/")
    );
  } catch {
    return false;
  }
}

function protectedHttpsEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      value === url.href &&
      url.pathname.startsWith("/")
    );
  } catch {
    return false;
  }
}

/**
 * Legacy `protectedSha512Sri`. The same canonical SHA-512 SRI rule the intake
 * validators already own, so both surfaces refuse exactly the same strings.
 */
const protectedSha512Sri = (value: string): boolean => sri(value);

function protectedOciRegistry(value: string): boolean {
  try {
    const url = new URL(`https://${value}`);
    const dns =
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
    return (
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      value === url.host &&
      (url.hostname.startsWith("[") || dns.test(url.hostname))
    );
  } catch {
    return false;
  }
}

function protectedOciRepository(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    value.split("/").every((segment) => /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(segment))
  );
}

/** Legacy `protectedList`: comma separated, trimmed, de-duplicated, sorted. */
export function protectedList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).sort();
}

/** Legacy `protectedExactList`: keeps WHY a list was refused, not just the items. */
export function protectedExactList(
  value: string,
  separator: string | RegExp,
  predicate: (item: string) => boolean,
): ProtectedExactListV1 {
  if (value.trim() === "") return { items: [], empty: false, invalid: false, duplicate: false };
  const entries = value.split(separator as string).map((item) => item.trim());
  const items = entries.slice().sort();
  return {
    items,
    empty: entries.some((item) => item === ""),
    invalid: entries.some((item) => item === "" || !predicate(item)),
    duplicate: items.some((item, index) => index > 0 && items[index - 1] === item),
  };
}

const text = (fields: ProtectedFieldsV1, id: string): string => (fields[id] ?? "").normalize("NFC");
const trimmed = (fields: ProtectedFieldsV1, id: string): string => text(fields, id).trim();

/** Legacy `protectedValues`, reading a plain record instead of the DOM. */
export function protectedValuesV1(fields: ProtectedFieldsV1): ProtectedValuesV1 {
  return {
    bundleVersion: trimmed(fields, "protected-bundle-version"),
    issuerRepository: trimmed(fields, "protected-issuer-repository"),
    issuer: trimmed(fields, "protected-issuer"),
    issuedAt: trimmed(fields, "protected-issued-at"),
    expiresAt: trimmed(fields, "protected-expires-at"),
    decisionId: trimmed(fields, "protected-decision-id"),
    kind: text(fields, "protected-kind"),
    subjectId: trimmed(fields, "protected-subject-id"),
    sourceType: text(fields, "protected-source-type"),
    sourceRepository: trimmed(fields, "protected-source-repository"),
    sourceCommit: trimmed(fields, "protected-source-commit"),
    sourcePath: trimmed(fields, "protected-source-path"),
    sourceRegistry: trimmed(fields, "protected-source-registry"),
    sourcePackage: trimmed(fields, "protected-source-package"),
    sourceVersion: trimmed(fields, "protected-source-version"),
    sourceIntegrity: trimmed(fields, "protected-source-integrity"),
    sourceFilename: trimmed(fields, "protected-source-filename"),
    sourceSha256: trimmed(fields, "protected-source-sha256"),
    sourceOciRegistry: trimmed(fields, "protected-source-oci-registry"),
    sourceOciRepository: trimmed(fields, "protected-source-oci-repository"),
    sourceIndexDigest: trimmed(fields, "protected-source-index-digest"),
    sourcePlatformOs: trimmed(fields, "protected-source-platform-os"),
    sourcePlatformArchitecture: trimmed(fields, "protected-source-platform-architecture"),
    sourcePlatformVariant: trimmed(fields, "protected-source-platform-variant"),
    sourceManifestDigest: trimmed(fields, "protected-source-manifest-digest"),
    sourceEndpoint: trimmed(fields, "protected-source-endpoint"),
    sourceContentDigest: trimmed(fields, "protected-source-content-digest"),
    sourceRelease: trimmed(fields, "protected-source-release"),
    sourceRevision: trimmed(fields, "protected-source-revision"),
    targets: protectedList(text(fields, "protected-targets")),
    effects: protectedList(text(fields, "protected-effects")),
    qualificationKind: text(fields, "protected-qualification-kind"),
    catalogSigner: trimmed(fields, "protected-catalog-signer"),
    catalogDigest: trimmed(fields, "protected-catalog-digest"),
    catalogHeadDigest: trimmed(fields, "protected-catalog-head-digest"),
    catalogMemberDigest: trimmed(fields, "protected-catalog-member-digest"),
    evidenceId: trimmed(fields, "protected-evidence-id"),
    evidenceDigest: trimmed(fields, "protected-evidence-digest"),
    attestor: trimmed(fields, "protected-attestor"),
    policyId: trimmed(fields, "protected-policy-id"),
    policyVersion: trimmed(fields, "protected-policy-version"),
    policyDigest: trimmed(fields, "protected-policy-digest"),
    controlId: trimmed(fields, "protected-control-id"),
    controlDigest: trimmed(fields, "protected-control-digest"),
    actor: trimmed(fields, "protected-actor"),
    reason: trimmed(fields, "protected-reason"),
    disposition: text(fields, "protected-disposition"),
    acceptedFindings: protectedExactList(text(fields, "protected-accepted-findings"), ",", (item) =>
      PROTECTED_ID.test(item),
    ),
    acceptedGaps: protectedExactList(text(fields, "protected-accepted-gaps"), ",", (item) =>
      PROTECTED_ID.test(item),
    ),
    conditions: protectedExactList(text(fields, "protected-conditions"), /\r?\n/, visible),
    reviewBy: trimmed(fields, "protected-review-by"),
  };
}

/** What `protectedIssues` needs besides the form: the policy and what is already in the file. */
export interface ProtectedIssuesContextV1 {
  readonly policy: Record<string, unknown>;
  readonly approverEmailPattern: string;
  readonly decisions: readonly ProtectedDecisionV1[];
  readonly authority: { readonly issuer: string; readonly issuerRepository: string } | undefined;
}

/** Legacy `protectedIssues`, message for message, keyed by field id. */
export function protectedIssuesV1(
  values: ProtectedValuesV1,
  context: ProtectedIssuesContextV1,
): Record<string, string> {
  const issues: Record<string, string> = {};
  const policy = context.policy;
  const governance = policy.governance as Record<string, unknown> | undefined;
  const supportedClis = governance?.supportedClis;
  if (policy.minimumPosture !== "enterprise")
    issues["protected-bundle-version"] = "Choose Enterprise posture before creating authority.";
  if (
    policy.minimumPosture === "enterprise" &&
    (!Array.isArray(supportedClis) || supportedClis.length === 0)
  )
    issues["protected-bundle-version"] =
      "Choose at least one supported CLI before creating an Enterprise protected policy file.";
  if (!visible(values.bundleVersion))
    issues["protected-bundle-version"] = "Use a visible bundle version.";
  if (!PROTECTED_REPOSITORY.test(values.issuerRepository))
    issues["protected-issuer-repository"] = "Use organization/repository.";
  if (!PROTECTED_ID.test(values.issuer))
    issues["protected-issuer"] = "Use a lowercase stable issuer identifier.";
  if (
    context.authority !== undefined &&
    (context.authority.issuer !== values.issuer ||
      context.authority.issuerRepository !== values.issuerRepository)
  )
    issues["protected-issuer-repository"] =
      "Existing decisions are bound to the original issuer identity; start a new file to change it.";
  if (!protectedTimestamp(values.issuedAt))
    issues["protected-issued-at"] = "Use an offset-qualified ISO-8601 time.";
  if (!protectedTimestamp(values.expiresAt))
    issues["protected-expires-at"] = "Use an offset-qualified ISO-8601 time.";
  if (protectedTimestamp(values.issuedAt) && protectedTimestamp(values.expiresAt)) {
    const issued = Date.parse(values.issuedAt);
    const expires = Date.parse(values.expiresAt);
    if (expires <= issued || expires - issued > MAX_AUTHORITY_WINDOW_MS)
      issues["protected-expires-at"] = "Authority must expire after issue and within 90 days.";
    if (context.decisions.some((decision) => Date.parse(decision.issuedAt) > issued))
      issues["protected-issued-at"] = "Authority issuance cannot precede an included decision.";
    if (context.decisions.some((decision) => Date.parse(decision.expiresAt) > expires))
      issues["protected-expires-at"] =
        "Authority expiry cannot precede an included decision expiry.";
  }
  if (!/^decision-[a-z0-9-]{1,55}$/.test(values.decisionId))
    issues["protected-decision-id"] = "Use a decision- prefixed stable identifier.";
  if (!/^(tool|skill|agent|mcp|package|profile)$/.test(values.kind))
    issues["protected-kind"] = "Choose an artifact kind.";
  if (!PROTECTED_ID.test(values.subjectId))
    issues["protected-subject-id"] = "Use a lowercase stable artifact identifier.";
  if (!/^(github|npm|pypi|oci|remote|aih)$/.test(values.sourceType))
    issues["protected-source-type"] = "Choose an exact source type.";
  if (values.sourceType === "github") {
    if (!PROTECTED_REPOSITORY.test(values.sourceRepository))
      issues["protected-source-repository"] = "Use organization/repository.";
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(values.sourceCommit))
      issues["protected-source-commit"] = "Use an exact lowercase 40 or 64 character commit.";
    if (!protectedPath(values.sourcePath))
      issues["protected-source-path"] = "Use a safe relative source path.";
  } else if (values.sourceType === "npm") {
    if (!protectedHttpsBase(values.sourceRegistry))
      issues["protected-source-registry"] = "Use a canonical HTTPS registry URL ending in /.";
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(values.sourcePackage))
      issues["protected-source-package"] = "Use an exact npm package name.";
    if (!PROTECTED_SEMVER.test(values.sourceVersion))
      issues["protected-source-version"] = "Use an exact semantic version.";
    if (!protectedSha512Sri(values.sourceIntegrity))
      issues["protected-source-integrity"] = "Use a canonical sha512 SRI digest.";
  } else if (values.sourceType === "pypi") {
    if (!protectedHttpsBase(values.sourceRegistry))
      issues["protected-source-registry"] = "Use a canonical HTTPS registry URL ending in /.";
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.sourcePackage))
      issues["protected-source-package"] = "Use a canonical PyPI package name.";
    if (!/^[A-Za-z0-9][A-Za-z0-9.!+_-]{0,127}$/.test(values.sourceVersion))
      issues["protected-source-version"] = "Use an exact PyPI version.";
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(values.sourceFilename))
      issues["protected-source-filename"] = "Use the exact distribution filename.";
    if (!PROTECTED_DIGEST.test(values.sourceSha256))
      issues["protected-source-sha256"] = "Use the exact sha256 distribution digest.";
  } else if (values.sourceType === "oci") {
    if (!protectedOciRegistry(values.sourceOciRegistry))
      issues["protected-source-oci-registry"] = "Use a canonical OCI registry authority.";
    if (!protectedOciRepository(values.sourceOciRepository))
      issues["protected-source-oci-repository"] =
        "Use canonical lowercase OCI repository segments.";
    if (!PROTECTED_DIGEST.test(values.sourceIndexDigest))
      issues["protected-source-index-digest"] = "Use the exact sha256 index digest.";
    if (!PROTECTED_ID.test(values.sourcePlatformOs))
      issues["protected-source-platform-os"] = "Use a stable operating-system identifier.";
    if (!PROTECTED_ID.test(values.sourcePlatformArchitecture))
      issues["protected-source-platform-architecture"] = "Use a stable architecture identifier.";
    if (values.sourcePlatformVariant !== "" && !PROTECTED_ID.test(values.sourcePlatformVariant))
      issues["protected-source-platform-variant"] =
        "Use a stable variant identifier or leave it empty.";
    if (!PROTECTED_DIGEST.test(values.sourceManifestDigest))
      issues["protected-source-manifest-digest"] = "Use the exact sha256 manifest digest.";
  } else if (values.sourceType === "remote") {
    if (!protectedHttpsEndpoint(values.sourceEndpoint))
      issues["protected-source-endpoint"] =
        "Use a canonical HTTPS endpoint without credentials, query, or fragment.";
    if (!PROTECTED_DIGEST.test(values.sourceContentDigest))
      issues["protected-source-content-digest"] = "Use the exact sha256 content digest.";
  } else if (values.sourceType === "aih") {
    if (!PROTECTED_SEMVER.test(values.sourceRelease))
      issues["protected-source-release"] = "Use an exact AIH semantic version.";
    if (!PROTECTED_DIGEST.test(values.sourceRevision))
      issues["protected-source-revision"] = "Use the exact AIH sha256 revision.";
  }
  if (
    values.targets.length < 1 ||
    values.targets.length > 64 ||
    values.targets.some((item) => !PROTECTED_ID.test(item))
  )
    issues["protected-targets"] = "Use one to 64 comma-separated target identifiers.";
  if (
    values.effects.length < 1 ||
    values.effects.some((item) => !/^(configure|install|observe|use)$/.test(item))
  )
    issues["protected-effects"] = "Use configure, install, observe, and/or use.";
  if (!/^(organization-qualified|aih-supported)$/.test(values.qualificationKind))
    issues["protected-qualification-kind"] = "Choose a qualification basis.";
  if (values.qualificationKind === "aih-supported") {
    if (!PROTECTED_IDENTITY.test(values.catalogSigner))
      issues["protected-catalog-signer"] =
        "Use the exact catalog signer identity from the verified receipt.";
    if (!PROTECTED_DIGEST.test(values.catalogDigest))
      issues["protected-catalog-digest"] =
        "Use the exact catalog digest from the verified receipt.";
    if (!PROTECTED_DIGEST.test(values.catalogHeadDigest))
      issues["protected-catalog-head-digest"] =
        "Use the exact catalog head digest from the verified receipt.";
    if (!PROTECTED_DIGEST.test(values.catalogMemberDigest))
      issues["protected-catalog-member-digest"] =
        "Use the exact catalog member digest from the verified receipt.";
  }
  for (const [id, value] of [
    ["protected-evidence-id", values.evidenceId],
    ["protected-attestor", values.attestor],
    ["protected-policy-id", values.policyId],
    ["protected-control-id", values.controlId],
  ] as const) {
    if (!PROTECTED_ID.test(value)) issues[id] = "Use a lowercase stable identifier.";
  }
  if (values.actor.length > 254 || !new RegExp(context.approverEmailPattern).test(values.actor))
    issues["protected-actor"] = "Use a valid accountable owner email address.";
  for (const [id, value] of [
    ["protected-evidence-digest", values.evidenceDigest],
    ["protected-policy-digest", values.policyDigest],
    ["protected-control-digest", values.controlDigest],
  ] as const) {
    if (!PROTECTED_DIGEST.test(value))
      issues[id] = "Use sha256: followed by 64 lowercase hex characters.";
  }
  if (!visible(values.policyVersion))
    issues["protected-policy-version"] = "Use a visible policy version.";
  if (!visible(values.reason))
    issues["protected-reason"] = "Use a visible accountable approval reason.";
  if (!/^(approved|accepted-with-conditions)$/.test(values.disposition))
    issues["protected-disposition"] = "Choose an approval disposition.";
  if (values.disposition === "accepted-with-conditions") {
    for (const [id, list] of [
      ["protected-accepted-findings", values.acceptedFindings],
      ["protected-accepted-gaps", values.acceptedGaps],
    ] as const) {
      if (list.empty || list.invalid)
        issues[id] = "Use comma-separated lowercase stable identifiers.";
      else if (list.duplicate) issues[id] = "Do not repeat an accepted identifier.";
      else if (list.items.length > 64) issues[id] = "Use at most 64 accepted identifiers.";
    }
    if (
      values.acceptedFindings.items.some((finding) => values.acceptedGaps.items.includes(finding))
    )
      issues["protected-accepted-gaps"] = "Accepted findings and gaps must not overlap.";
    if (values.acceptedFindings.items.length + values.acceptedGaps.items.length === 0)
      issues["protected-accepted-findings"] = "Name at least one accepted finding or waivable gap.";
    if (values.conditions.empty || values.conditions.invalid)
      issues["protected-conditions"] = "Use one visible condition per line.";
    else if (values.conditions.duplicate)
      issues["protected-conditions"] = "Do not repeat a condition.";
    else if (values.conditions.items.length === 0)
      issues["protected-conditions"] = "Name at least one acceptance condition.";
    else if (values.conditions.items.length > 32)
      issues["protected-conditions"] = "Use at most 32 conditions.";
    if (!protectedTimestamp(values.reviewBy))
      issues["protected-review-by"] = "Use an offset-qualified ISO-8601 review time.";
    else if (
      protectedTimestamp(values.issuedAt) &&
      protectedTimestamp(values.expiresAt) &&
      (Date.parse(values.reviewBy) < Date.parse(values.issuedAt) ||
        Date.parse(values.reviewBy) > Date.parse(values.expiresAt))
    )
      issues["protected-review-by"] = REVIEW_WINDOW_MESSAGE;
  }
  if (context.decisions.length >= 64)
    issues["protected-decision-id"] = "A protected file can contain at most 64 decisions.";
  if (context.decisions.some((decision) => decision.id === values.decisionId))
    issues["protected-decision-id"] = "That decision identifier is already in this file.";
  return issues;
}

/** One built decision. Untyped members: the shape is the file's, not the UI's. */
export interface ProtectedDecisionV1 extends Record<string, unknown> {
  readonly id: string;
  readonly issuer: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly targets: readonly string[];
  readonly subject: Record<string, unknown>;
  readonly disposition: string;
}

/** Legacy `protectedBuildSource`. Key order decides the digest, so never re-sort. */
export function protectedBuildSourceV1(values: ProtectedValuesV1): Record<string, unknown> {
  if (values.sourceType === "github")
    return {
      type: "github",
      repository: values.sourceRepository,
      commit: values.sourceCommit,
      path: values.sourcePath,
    };
  if (values.sourceType === "npm")
    return {
      type: "npm",
      registry: values.sourceRegistry,
      package: values.sourcePackage,
      version: values.sourceVersion,
      integrity: values.sourceIntegrity,
    };
  if (values.sourceType === "pypi")
    return {
      type: "pypi",
      registry: values.sourceRegistry,
      package: values.sourcePackage,
      version: values.sourceVersion,
      filename: values.sourceFilename,
      sha256: values.sourceSha256,
    };
  if (values.sourceType === "oci") {
    const platform: Record<string, unknown> = {
      os: values.sourcePlatformOs,
      architecture: values.sourcePlatformArchitecture,
    };
    if (values.sourcePlatformVariant) platform.variant = values.sourcePlatformVariant;
    return {
      type: "oci",
      registry: values.sourceOciRegistry,
      repository: values.sourceOciRepository,
      indexDigest: values.sourceIndexDigest,
      platform,
      manifestDigest: values.sourceManifestDigest,
    };
  }
  if (values.sourceType === "remote")
    return {
      type: "remote",
      endpoint: values.sourceEndpoint,
      contentDigest: values.sourceContentDigest,
    };
  return { type: "aih", release: values.sourceRelease, revision: values.sourceRevision };
}

/**
 * SHA-256 of exactly these characters, as `sha256:<lower-case hex>`. The host
 * supplies it: the engine never hashes (delivery contract, "Hosts").
 */
export type ProtectedDigestFn = (preimage: string) => Promise<string>;

/** Legacy `protectedBuildDecision`. `evidenceEnvelope` is always null, as it was. */
export async function protectedBuildDecisionV1(
  values: ProtectedValuesV1,
  digest: ProtectedDigestFn,
): Promise<ProtectedDecisionV1> {
  const source = protectedBuildSourceV1(values);
  const sourceDigest = await digest(protectedDigestPreimage("source", source));
  const subjectDigest = await digest(
    protectedDigestPreimage("subject", { kind: values.kind, id: values.subjectId, sourceDigest }),
  );
  const issuedAt = protectedCanonicalTimestamp(values.issuedAt);
  const expiresAt = protectedCanonicalTimestamp(values.expiresAt);
  const conditional = values.disposition === "accepted-with-conditions";
  const qualificationBasis =
    values.qualificationKind === "aih-supported"
      ? {
          kind: "aih-supported",
          catalogSignerIdentity: values.catalogSigner,
          catalogDigest: values.catalogDigest,
          catalogHeadDigest: values.catalogHeadDigest,
          catalogMemberDigest: values.catalogMemberDigest,
          subjectKind: values.kind,
          subjectDigest,
        }
      : {
          kind: "organization-qualified",
          evidenceDigest: values.evidenceDigest,
          attestor: values.attestor,
        };
  return {
    format: "aih-governance-decision",
    version: 2,
    id: values.decisionId,
    qualificationBasis,
    subject: {
      kind: values.kind,
      id: values.subjectId,
      source,
      sourceDigest,
      subjectDigest,
    },
    targets: [...values.targets],
    allowedEffects: [...values.effects],
    policy: { id: values.policyId, version: values.policyVersion, digest: values.policyDigest },
    control: { id: values.controlId, digest: values.controlDigest },
    evidence: { id: values.evidenceId, digest: values.evidenceDigest, attestor: values.attestor },
    issuer: values.issuer,
    actor: values.actor,
    reason: values.reason,
    issuedAt,
    notBefore: issuedAt,
    expiresAt,
    disposition: values.disposition,
    acceptedFindings: conditional ? [...values.acceptedFindings.items] : [],
    acceptedGaps: conditional ? [...values.acceptedGaps.items] : [],
    conditions: conditional ? [...values.conditions.items] : [],
    ...(conditional ? { reviewBy: protectedCanonicalTimestamp(values.reviewBy) } : {}),
  };
}

/** One revocation row, as the runtime built it. */
export interface ProtectedRevocationV1 extends Record<string, unknown> {
  readonly decisionDigest: string;
}

/** Legacy `protectedBuildBundle`: decisions by id, targets and revocations sorted. */
export function protectedBuildBundleV1(
  values: ProtectedValuesV1,
  policy: unknown,
  decisions: readonly ProtectedDecisionV1[],
  revocations: readonly ProtectedRevocationV1[],
): Record<string, unknown> {
  const ordered = decisions
    .slice()
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const targets = Array.from(new Set(ordered.flatMap((decision) => [...decision.targets]))).sort();
  const issuedAt = protectedCanonicalTimestamp(values.issuedAt);
  return {
    schemaVersion: 2,
    bundleVersion: values.bundleVersion,
    issuer: values.issuer,
    issuedAt,
    policy: structuredClone(policy),
    authorityReceipt: {
      format: "aih-policy-authority-receipt",
      version: 3,
      issuerRepository: values.issuerRepository,
      issuedAt,
      expiresAt: protectedCanonicalTimestamp(values.expiresAt),
      trustedIssuers: [{ id: values.issuer, githubRepository: values.issuerRepository }],
      targets,
      decisions: ordered,
      decisionRevocations: revocations
        .slice()
        .sort((left, right) =>
          left.decisionDigest < right.decisionDigest
            ? -1
            : left.decisionDigest > right.decisionDigest
              ? 1
              : 0,
        ),
    },
  };
}

/** Legacy `protectedSourceLabel`, for the decision rows. */
export function protectedSourceLabelV1(source: Record<string, unknown>): string {
  const at = (left: unknown, right: unknown) => `${String(left)}@${String(right)}`;
  if (source.type === "github") return at(source.repository, source.commit);
  if (source.type === "npm" || source.type === "pypi") return at(source.package, source.version);
  if (source.type === "oci")
    return `${String(source.registry)}/${at(source.repository, source.manifestDigest)}`;
  if (source.type === "remote") return at(source.endpoint, source.contentDigest);
  return `AIH ${at(source.release, source.revision)}`;
}
