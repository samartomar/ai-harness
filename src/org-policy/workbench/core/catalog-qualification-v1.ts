import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { PreparedAihScannerPublicationsV1 } from "../../../baseline-evidence/aih-scan-preparation.js";
import { hashComponentTree } from "../../../baseline-evidence/hash.js";
import { componentIdentityPaths } from "../../../baseline-evidence/license.js";
import { prepareRegisteredScannerCatalogV1 } from "../../../baseline-evidence/scanner-provider-catalogs.js";
import { evidenceExpiryV1, evidenceIsCurrentV1 } from "../../../evidence-freshness.js";
import { defaultRunner } from "../../../internals/proc.js";
import { findOnPath } from "../../../live/runner.js";
import {
  GovernanceDecisionSubjectV2Schema,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../governance-decision-v2.js";
import { parseAihSupportedQualificationReceiptV2Bytes } from "../../supported-qualification-receipt-v2.js";
import {
  type AuthoringCatalogBundleV1,
  CatalogQualificationSummariesV1Schema,
  type CatalogQualificationSummaryV1,
} from "../contracts.js";
import {
  type AihFirstPartyQualificationPreparationV1,
  prepareAihFirstPartyQualificationCandidatesV1,
} from "./catalog-qualification-first-party-v1.js";
import {
  CATALOG_RECEIPT_SET_MAX_BYTES,
  CATALOG_RECEIPT_SET_MAX_ENTRIES,
} from "./catalog-qualification-limits.js";
import {
  type CatalogQualificationPublisherV1,
  packagedCatalogQualificationBindingsV1,
  packagedCatalogQualificationProjectionsV1,
  packagedCatalogQualificationRecordsV1,
} from "./catalog-qualification-package-v1.js";
import { CATALOG_QUALIFICATION_RELEASE_POLICIES_V1 } from "./catalog-qualification-policy-v1.js";

const MAX_CLOSURE_BYTES = 1_000_000;
const MAX_MEMBER_BYTES = 64_000;
const MAX_RECEIPT_SET_BYTES = CATALOG_RECEIPT_SET_MAX_BYTES;
const MAX_RECEIPT_SET_ENTRIES = CATALOG_RECEIPT_SET_MAX_ENTRIES;
const MAX_GITHUB_OUTPUT_BYTES = 256 * 1024;
const GITHUB_TIMEOUT_MS = 30_000;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const BARE_DIGEST = /^[0-9a-f]{64}$/;
const safeText = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => value === value.normalize("NFC") && !/\p{C}/u.test(value));
const id = safeText.max(240);
const path = safeText.refine(
  (value) =>
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes("\\") &&
    !/[%?#:]/.test(value) &&
    !value.endsWith("/") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
  "must be a safe relative POSIX path",
);
const digest = z.string().regex(DIGEST);

/** Exact canonical descriptor for a new Workbench Catalog member closure. */
export const CatalogQualificationClosureV1Schema = z
  .object({
    format: z.literal("aih-supported-catalog-member-closure"),
    version: z.literal(1),
    assetId: id,
    sourceId: id,
    sourceRevisionId: id,
    sourceContentDigest: digest,
    contentDigest: digest,
    subjectDigest: digest,
    bindingDigest: digest,
    scope: z
      .object({
        kind: z.enum(["source-files", "configuration-only", "derived-composition"]),
        description: safeText.max(500),
      })
      .strict(),
    files: z
      .array(z.object({ path, digest }).strict())
      .max(1_024)
      .superRefine((files, ctx) => {
        for (let index = 1; index < files.length; index++)
          if ((files[index - 1]?.path ?? "") >= (files[index]?.path ?? ""))
            ctx.addIssue({
              code: "custom",
              path: [index],
              message: "closure files must be uniquely ordered by path",
            });
      }),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope.kind === "source-files" && value.files.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["files"],
        message: "source-file scope requires files",
      });
    if (value.scope.kind !== "source-files" && value.files.length !== 0)
      ctx.addIssue({
        code: "custom",
        path: ["files"],
        message: "configuration and derived scope must not fabricate file coverage",
      });
  });
export type CatalogQualificationClosureV1 = z.infer<typeof CatalogQualificationClosureV1Schema>;

const tuple = z
  .object({ assetId: id, sourceId: id, sourceRevisionId: id, contentDigest: digest })
  .strict();
const materialFiles = z
  .array(z.object({ path, digest }).strict())
  .min(1)
  .max(1_024)
  .superRefine((values, ctx) => {
    for (let index = 1; index < values.length; index++)
      if ((values[index - 1]?.path ?? "") >= (values[index]?.path ?? ""))
        ctx.addIssue({ code: "custom", path: [index], message: "files must be uniquely ordered" });
  });
/** Core-only material sidecar. It is never a compiler/browser transport. */
export const CompilerQualificationBindingV1Schema = z
  .object({
    format: z.literal("aih-compiler-qualification-binding"),
    version: z.literal(1),
    asset: tuple,
    sourceContentDigest: digest,
    compiler: z
      .object({ id, version: safeText.max(80), inputFormat: safeText.max(1_000) })
      .strict(),
    subject: GovernanceDecisionSubjectV2Schema,
    material: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("source-files"), treeDigest: digest, files: materialFiles })
        .strict(),
      z
        .object({
          kind: z.literal("configuration-only"),
          declarationDigest: digest,
          sourceInputDigest: digest,
        })
        .strict(),
      z
        .object({
          kind: z.literal("derived-composition"),
          compositionDigest: digest,
          constituents: z.array(tuple).min(1).max(1_024),
        })
        .strict(),
    ]),
  })
  .strict();
export type CompilerQualificationBindingV1 = z.infer<typeof CompilerQualificationBindingV1Schema>;
export type CoreCompilerQualificationBindingsV1 = Readonly<
  Record<string, CompilerQualificationBindingV1>
>;

export interface PreparedAihFirstPartyCompilerQualificationsV1 {
  readonly bindings: CoreCompilerQualificationBindingsV1;
  /** Canonical Catalog profile artifact bytes indexed by the exact asset identity. */
  readonly profiles: Readonly<Record<string, Readonly<{ bytes: Uint8Array; sha256: string }>>>;
  /** Scanner-covered AIH assets that have no supported governance-subject kind. */
  readonly unsupported: AihFirstPartyQualificationPreparationV1["unsupported"];
}

/**
 * The preparation-only portion of the fixed Scanner provider registry. Raw
 * file digests must come from Core's `hashComponentTree`, never from Catalog.
 */
export interface RegisteredScannerCoverageForQualificationV1 {
  readonly source: {
    readonly id: string;
    readonly revisionId: string;
    readonly contentDigest: string;
  };
  readonly components: readonly {
    readonly componentId: string;
    readonly componentTreeSha256: string;
    /** Scanner request paths. Qualification material may additionally bind LICENSE. */
    readonly paths: readonly string[];
    readonly files: readonly { readonly path: string; readonly digest: string }[];
    readonly subject: {
      readonly assetId: string;
      readonly sourceId: string;
      readonly sourceRevisionId: string;
      readonly contentDigest: string;
    };
  }[];
  readonly unmappedDerivedAssets: readonly string[];
}

/**
 * Recomputes the compiler's own material tree without changing Scanner
 * request coverage. Legal metadata is part of compiler identity but is not a
 * fabricated Scanner file claim.
 */
export function qualificationMaterialCoverageFromRegisteredCoverageV1(
  sourceRoot: string,
  coverage: RegisteredScannerCoverageForQualificationV1,
): RegisteredScannerCoverageForQualificationV1 {
  return {
    ...coverage,
    components: coverage.components.map((component) => {
      const material = hashComponentTree(
        sourceRoot,
        componentIdentityPaths(sourceRoot, component.paths),
      );
      return {
        ...component,
        componentTreeSha256: material.treeSha256,
        files: material.files.map((file) => ({ path: file.path, digest: `sha256:${file.sha256}` })),
      };
    }),
  };
}

/**
 * Builds ordinary Core sidecars from a registered provider's materialized
 * coverage. It cannot mint an operational qualification proof.
 */
export function compilerQualificationBindingsFromRegisteredCoverageV1(
  bundle: AuthoringCatalogBundleV1,
  coverage: RegisteredScannerCoverageForQualificationV1,
  subjects: Readonly<Record<string, unknown>>,
): CoreCompilerQualificationBindingsV1 | undefined {
  const source = bundle.sources[coverage.source.id];
  if (
    source === undefined ||
    source.revision.id !== coverage.source.revisionId ||
    source.revision.contentDigest !== coverage.source.contentDigest
  )
    return undefined;
  const bindings: Record<string, CompilerQualificationBindingV1> = {};
  const unmapped = new Set(coverage.unmappedDerivedAssets);
  for (const component of coverage.components) {
    const asset = bundle.assets[component.subject.assetId];
    const suppliedSubject = subjects[component.subject.assetId];
    if (suppliedSubject === undefined) continue;
    const subject = GovernanceDecisionSubjectV2Schema.safeParse(suppliedSubject);
    const files = component.files.map((file) => ({ path: file.path, digest: file.digest }));
    const parsed = CompilerQualificationBindingV1Schema.safeParse({
      format: "aih-compiler-qualification-binding",
      version: 1,
      asset: component.subject,
      sourceContentDigest: coverage.source.contentDigest,
      compiler: {
        id: source.compiler.id,
        version: source.compiler.version,
        inputFormat: source.inputFormat,
      },
      subject: subject.success ? subject.data : undefined,
      material: {
        kind: "source-files",
        treeDigest: `sha256:${component.componentTreeSha256}`,
        files,
      },
    });
    if (
      !parsed.success ||
      asset === undefined ||
      asset.derivation !== "upstream" ||
      unmapped.has(asset.id) ||
      bindings[asset.id] !== undefined ||
      asset.id !== component.subject.assetId ||
      asset.sourceId !== component.subject.sourceId ||
      asset.sourceRevisionId !== component.subject.sourceRevisionId ||
      asset.contentDigest !== component.subject.contentDigest
    )
      return undefined;
    bindings[asset.id] = parsed.data;
  }
  return Object.freeze(bindings);
}

/**
 * First-party preparation is deliberately separate from the registered Git
 * path. Its source profile is derived only from an opaque, verified AIH
 * Scanner witness and the exact final built-in bundle.
 */
export function prepareAihFirstPartyCompilerQualificationsV1(
  bundle: AuthoringCatalogBundleV1,
  prepared: PreparedAihScannerPublicationsV1,
): PreparedAihFirstPartyCompilerQualificationsV1 | undefined {
  const firstParty = prepareAihFirstPartyQualificationCandidatesV1(bundle, prepared);
  if (firstParty === undefined) return undefined;
  const bindings: Record<string, CompilerQualificationBindingV1> = {};
  const profiles: Record<string, Readonly<{ bytes: Uint8Array; sha256: string }>> = {};
  for (const candidate of firstParty.candidates) {
    const parsed = CompilerQualificationBindingV1Schema.safeParse({
      format: "aih-compiler-qualification-binding",
      version: 1,
      asset: candidate.asset,
      sourceContentDigest: candidate.sourceContentDigest,
      compiler: candidate.compiler,
      subject: candidate.subject,
      material: candidate.material,
    });
    if (
      !parsed.success ||
      bindings[candidate.asset.assetId] !== undefined ||
      profiles[candidate.asset.assetId] !== undefined ||
      candidate.profile.sha256 !== sha256(candidate.profile.bytes)
    )
      return undefined;
    bindings[candidate.asset.assetId] = parsed.data;
    profiles[candidate.asset.assetId] = Object.freeze({
      bytes: new Uint8Array(candidate.profile.bytes),
      sha256: candidate.profile.sha256,
    });
  }
  return Object.freeze({
    bindings: Object.freeze(bindings),
    profiles: Object.freeze(profiles),
    unsupported: firstParty.unsupported,
  });
}

/** Only registered, pinned Git sources can derive a Catalog subject at release preparation. */
export function registeredCoverageGovernanceSubjectsV1(
  bundle: AuthoringCatalogBundleV1,
  coverage: RegisteredScannerCoverageForQualificationV1,
): Readonly<Record<string, unknown>> | undefined {
  const source = bundle.sources[coverage.source.id];
  const repository =
    source?.upstreamOrigin.kind === "git"
      ? /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(
          source.upstreamOrigin.locator,
        )?.[1]
      : undefined;
  if (source === undefined || repository === undefined) return undefined;
  const subjects: Record<string, unknown> = {};
  for (const component of coverage.components) {
    const asset = bundle.assets[component.subject.assetId];
    const id =
      /(?:skill|agent|mcp|tool|package|profile):([a-z][a-z0-9-]{0,63})$/.exec(
        asset?.id ?? "",
      )?.[1] ?? (/^[a-z][a-z0-9-]{0,63}$/.test(asset?.label ?? "") ? asset?.label : undefined);
    if (
      asset === undefined ||
      id === undefined ||
      !["tool", "skill", "agent", "mcp", "package", "profile"].includes(asset.kind) ||
      subjects[asset.id] !== undefined
    )
      continue;
    const governanceSource = {
      type: "github" as const,
      repository,
      commit: source.revision.id,
      path: asset.originalPath,
    };
    const kind = asset.kind as "tool" | "skill" | "agent" | "mcp" | "package" | "profile";
    const sourceDigest = governanceDecisionSourceDigestV2(governanceSource);
    const subject = {
      kind,
      id,
      source: governanceSource,
      sourceDigest,
      subjectDigest: governanceDecisionSubjectDigestV2({ kind, id, sourceDigest }),
    };
    if (!GovernanceDecisionSubjectV2Schema.safeParse(subject).success) continue;
    subjects[asset.id] = subject;
  }
  return Object.freeze(subjects);
}

/**
 * Release preparation entry point for the fixed provider registry. It reads a
 * real materialized source root and is never used by the browser or compiler
 * assembly path.
 */
export function prepareRegisteredCompilerQualificationBindingsV1(
  bundle: AuthoringCatalogBundleV1,
  sourceRoot: string,
  providerId: string,
): CoreCompilerQualificationBindingsV1 | undefined {
  const prepared = prepareRegisteredScannerCatalogV1(sourceRoot, providerId);
  const subjects =
    prepared.coverage === undefined
      ? undefined
      : registeredCoverageGovernanceSubjectsV1(bundle, prepared.coverage);
  return prepared.coverage === undefined
    ? undefined
    : subjects === undefined
      ? undefined
      : compilerQualificationBindingsFromRegisteredCoverageV1(
          bundle,
          qualificationMaterialCoverageFromRegisteredCoverageV1(sourceRoot, prepared.coverage),
          subjects,
        );
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function canonicalCatalogQualificationClosureV1(
  value: CatalogQualificationClosureV1,
): string {
  return stable(value);
}
function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function bareSha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function canonicalCompilerQualificationBindingV1(
  value: CompilerQualificationBindingV1,
): string {
  return stable(value);
}
export function compilerQualificationBindingDigestV1(
  value: CompilerQualificationBindingV1,
): string {
  return sha256(
    `aih-compiler-qualification-binding/v1\0${canonicalCompilerQualificationBindingV1(value)}`,
  );
}
function parseCanonicalJson(bytes: Uint8Array, limit: number): unknown | undefined {
  if (bytes.byteLength > limit) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const value = JSON.parse(text);
    return text === stable(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
function same(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}
function qualificationContextDigestV1(
  summary: Omit<CatalogQualificationSummaryV1, "contextDigest">,
): string {
  return sha256(`aih-catalog-qualification-context/v1\0${stable(summary)}`);
}

const MemberSchema = z
  .object({
    capabilities: z.unknown(),
    closure: z
      .object({ identity: safeText.max(500), sha256: z.string().regex(BARE_DIGEST) })
      .strict(),
    entryId: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/),
    platforms: z.unknown(),
    prose: z.unknown(),
    qualification: z.unknown(),
    recipe: z.unknown(),
    subject: z.unknown(),
    versions: z.unknown(),
  })
  .strict();
const ReceiptSetSchema = z
  .object({
    format: z.literal("aih-supported-qualification-receipt-set"),
    version: z.literal(1),
    entries: z
      .array(
        z
          .object({
            entryId: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/),
            memberDigest: digest,
            path: z.string().regex(/^receipts\/[a-z][a-z0-9.-]{0,63}\.json$/),
            receiptSha256: z.string().regex(BARE_DIGEST),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_RECEIPT_SET_ENTRIES)
      .superRefine((entries, ctx) => {
        for (let index = 1; index < entries.length; index++)
          if ((entries[index - 1]?.entryId ?? "") >= (entries[index]?.entryId ?? ""))
            ctx.addIssue({
              code: "custom",
              path: [index],
              message: "receipt set entries must sort",
            });
        for (const [index, entry] of entries.entries())
          if (entry.path !== `receipts/${entry.entryId}.json`)
            ctx.addIssue({ code: "custom", path: [index, "path"], message: "receipt path" });
      }),
  })
  .strict();

export interface CatalogQualificationArtifactV1 {
  readonly receiptBytes: Uint8Array;
  readonly receiptSetBytes: Uint8Array;
  readonly memberBytes: Uint8Array;
  readonly closureBytesByIdentity: Readonly<Record<string, Uint8Array>>;
  readonly publisher: CatalogQualificationPublisherV1;
  readonly receiptSetPublisher: CatalogQualificationPublisherV1;
}

/**
 * Static byte and bundle joins only. It deliberately returns ordinary data;
 * injected test/verifier results cannot mint a same-process proof.
 */
export function inspectCatalogQualificationArtifactV1(
  bundle: AuthoringCatalogBundleV1,
  artifacts: CatalogQualificationArtifactV1,
  coreBindings: CoreCompilerQualificationBindingsV1,
  now: string,
  verifiedAt = now,
): Record<string, CatalogQualificationSummaryV1> | undefined {
  const nowEpoch = Date.parse(now);
  const verifiedEpoch = Date.parse(verifiedAt);
  const receipt = parseAihSupportedQualificationReceiptV2Bytes(artifacts.receiptBytes);
  const receiptSet = ReceiptSetSchema.safeParse(
    parseCanonicalJson(artifacts.receiptSetBytes, MAX_RECEIPT_SET_BYTES),
  );
  const member = MemberSchema.safeParse(
    parseCanonicalJson(artifacts.memberBytes, MAX_MEMBER_BYTES),
  );
  if (
    receipt === undefined ||
    !receiptSet.success ||
    !member.success ||
    !Number.isFinite(nowEpoch) ||
    !Number.isFinite(verifiedEpoch)
  )
    return undefined;
  const closureBytes = artifacts.closureBytesByIdentity[member.data.closure.identity];
  const closure = CatalogQualificationClosureV1Schema.safeParse(
    closureBytes === undefined ? undefined : parseCanonicalJson(closureBytes, MAX_CLOSURE_BYTES),
  );
  const binding = closure.success ? coreBindings[closure.data.assetId] : undefined;
  if (
    closureBytes === undefined ||
    !closure.success ||
    binding === undefined ||
    bareSha256(closureBytes) !== member.data.closure.sha256 ||
    receipt.qualificationBasis.catalogMemberDigest !==
      sha256(`aih-supported-catalog-member/v2\0${stable(member.data)}`)
  )
    return undefined;
  const receiptSetEntry = receiptSet.data.entries.find(
    (entry) => entry.entryId === receipt.entryId,
  );
  if (
    receiptSetEntry === undefined ||
    receiptSetEntry.memberDigest !== receipt.qualificationBasis.catalogMemberDigest ||
    receiptSetEntry.receiptSha256 !== bareSha256(artifacts.receiptBytes)
  )
    return undefined;
  if (
    Date.parse(receipt.notBefore) > nowEpoch ||
    !evidenceIsCurrentV1(receipt.issuedAt, receipt.expiresAt, nowEpoch)
  )
    return undefined;
  const asset = bundle.assets[closure.data.assetId];
  const source = bundle.sources[closure.data.sourceId];
  if (
    asset === undefined ||
    source === undefined ||
    asset.sourceId !== closure.data.sourceId ||
    asset.sourceRevisionId !== closure.data.sourceRevisionId ||
    asset.contentDigest !== closure.data.contentDigest ||
    source.revision.id !== closure.data.sourceRevisionId ||
    source.revision.contentDigest !== closure.data.sourceContentDigest ||
    closure.data.bindingDigest !== compilerQualificationBindingDigestV1(binding) ||
    binding.asset.assetId !== asset.id ||
    binding.asset.sourceId !== asset.sourceId ||
    binding.asset.sourceRevisionId !== asset.sourceRevisionId ||
    binding.asset.contentDigest !== asset.contentDigest ||
    binding.sourceContentDigest !== source.revision.contentDigest ||
    binding.compiler.id !== source.compiler.id ||
    binding.compiler.version !== source.compiler.version ||
    binding.compiler.inputFormat !== source.inputFormat ||
    binding.subject.subjectDigest !== receipt.subject.subjectDigest ||
    !same(binding.subject, receipt.subject) ||
    binding.material.kind !== closure.data.scope.kind ||
    (binding.material.kind === "source-files" &&
      !same(binding.material.files, closure.data.files)) ||
    receipt.entryId !== member.data.entryId ||
    receipt.subject.subjectDigest !== closure.data.subjectDigest ||
    !same(receipt.subject, member.data.subject)
  )
    return undefined;
  const receiptDigest = sha256(artifacts.receiptBytes);
  const receiptSetDigest = sha256(artifacts.receiptSetBytes);
  const closureDigest = sha256(closureBytes);
  const unsignedSummary: Omit<CatalogQualificationSummaryV1, "contextDigest"> = {
    projectionVersion: "catalog-qualification-summary/v1",
    state: "qualified",
    assetId: asset.id,
    sourceId: asset.sourceId,
    sourceRevisionId: asset.sourceRevisionId,
    sourceContentDigest: source.revision.contentDigest,
    contentDigest: asset.contentDigest,
    subjectDigest: receipt.subject.subjectDigest,
    publisher: {
      repository: artifacts.publisher.repository,
      workflow: artifacts.publisher.workflow,
      ref: artifacts.publisher.ref,
      issuer: artifacts.publisher.issuer,
      commit: artifacts.publisher.commit,
    },
    receiptDigest,
    receiptSetDigest,
    catalogDigest: receipt.qualificationBasis.catalogDigest,
    catalogHeadDigest: receipt.qualificationBasis.catalogHeadDigest,
    catalogMemberDigest: receipt.qualificationBasis.catalogMemberDigest,
    closureDigest,
    compilerBindingDigest: compilerQualificationBindingDigestV1(binding),
    verifiedAt,
    originalIssuedAt: receipt.issuedAt,
    notBefore: receipt.notBefore,
    validUntil: evidenceExpiryV1(receipt.issuedAt, receipt.expiresAt),
    scope: closure.data.scope,
  };
  const summary: CatalogQualificationSummaryV1 = {
    ...unsignedSummary,
    contextDigest: qualificationContextDigestV1(unsignedSummary),
  };
  const summaries = { [summary.assetId]: summary };
  return CatalogQualificationSummariesV1Schema.safeParse(summaries).success ? summaries : undefined;
}

const preparedQualifications = new WeakMap<
  object,
  Readonly<Record<string, CatalogQualificationSummaryV1>>
>();
declare const preparedCatalogQualificationBrand: unique symbol;
/** Same-process display proof, minted only by the live packaging verifier or package loader. */
export interface PreparedCatalogQualificationV1 {
  readonly [preparedCatalogQualificationBrand]?: never;
}
function mint(
  summaries: Record<string, CatalogQualificationSummaryV1>,
): PreparedCatalogQualificationV1 {
  const prepared: PreparedCatalogQualificationV1 = Object.freeze({});
  preparedQualifications.set(prepared, Object.freeze(structuredClone(summaries)));
  return prepared;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function catalogQualificationAttestationMatchesV1(
  output: string,
  publisher: CatalogQualificationPublisherV1,
  bytes: Uint8Array,
  now: number,
): string | undefined {
  try {
    const results = JSON.parse(output);
    if (!Array.isArray(results) || results.length !== 1) return undefined;
    const verification = object(object(results[0])?.verificationResult);
    const signature = object(verification?.signature);
    const certificate = object(signature?.certificate);
    const statement = object(verification?.statement);
    const workflowUri = `https://github.com/${publisher.workflow}@${publisher.ref}`;
    if (
      certificate?.subjectAlternativeName !== workflowUri ||
      certificate?.buildSignerURI !== workflowUri ||
      certificate?.buildConfigURI !== workflowUri ||
      certificate?.issuer !== publisher.issuer ||
      certificate?.sourceRepositoryURI !== `https://github.com/${publisher.repository}` ||
      certificate?.sourceRepositoryRef !== publisher.ref ||
      (certificate?.sourceRepositoryDigest !== publisher.commit &&
        certificate?.sourceRepositoryDigest !== `sha1:${publisher.commit}`) ||
      certificate?.runnerEnvironment !== "github-hosted" ||
      statement?._type !== "https://in-toto.io/Statement/v1" ||
      statement?.predicateType !== "https://slsa.dev/provenance/v1" ||
      !Array.isArray(statement?.subject) ||
      statement.subject.length < 1 ||
      statement.subject.length > MAX_RECEIPT_SET_ENTRIES ||
      (publisher.subjectName === "qualification-receipt-set.json" && statement.subject.length !== 1)
    )
      return undefined;
    const names = new Set<string>();
    for (const raw of statement.subject) {
      const item = object(raw);
      const itemDigest = object(item?.digest);
      if (
        typeof item?.name !== "string" ||
        !/^[a-z][a-z0-9.-]{0,63}\.json$/.test(item.name) ||
        names.has(item.name) ||
        Object.keys(itemDigest ?? {}).join("\0") !== "sha256" ||
        typeof itemDigest?.sha256 !== "string" ||
        !BARE_DIGEST.test(itemDigest.sha256)
      )
        return undefined;
      names.add(item.name);
    }
    const subject = object(
      statement.subject.find((item) => object(item)?.name === publisher.subjectName),
    );
    const subjectDigest = object(subject?.digest);
    if (
      Object.keys(subjectDigest ?? {}).join("\0") !== "sha256" ||
      subject?.name !== publisher.subjectName ||
      subjectDigest?.sha256 !== bareSha256(bytes)
    )
      return undefined;
    const timestamps = verification?.verifiedTimestamps;
    if (!Array.isArray(timestamps) || timestamps.length === 0 || timestamps.length > 16)
      return undefined;
    const moments = timestamps.map((entry) => {
      const value = object(entry)?.timestamp;
      return typeof value === "string" ? Date.parse(value) : Number.NaN;
    });
    if (moments.some((value) => !Number.isFinite(value) || value > now)) return undefined;
    const latest = Math.max(...moments);
    return Number.isFinite(latest)
      ? new Date(latest).toISOString().replace(".000Z", "Z")
      : undefined;
  } catch {
    return undefined;
  }
}

async function verifyWithGithubV1(
  bytes: Uint8Array,
  publisher: CatalogQualificationPublisherV1,
  now: number,
  verifiedStatements: string[],
): Promise<string | undefined> {
  for (const statement of verifiedStatements) {
    const match = catalogQualificationAttestationMatchesV1(statement, publisher, bytes, now);
    if (match !== undefined) return match;
  }
  const gh = findOnPath("gh", process.env, process.platform, {
    excludeRoot: process.cwd(),
    windowsExeOnly: true,
  });
  if (gh === undefined) return undefined;
  let directory: string | undefined;
  let verified: string | undefined;
  let statement: string | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "aih-catalog-qualification-"));
    const receiptPath = join(directory, "receipt.json");
    writeFileSync(receiptPath, bytes, { flag: "wx", mode: 0o600 });
    const workflowUri = `https://github.com/${publisher.workflow}@${publisher.ref}`;
    const result = await defaultRunner(
      [
        gh,
        "attestation",
        "verify",
        receiptPath,
        "--format",
        "json",
        "--repo",
        publisher.repository,
        "--predicate-type",
        "https://slsa.dev/provenance/v1",
        "--cert-identity",
        workflowUri,
        "--cert-oidc-issuer",
        publisher.issuer,
        "--source-ref",
        publisher.ref,
        "--deny-self-hosted-runners",
      ],
      { cwd: process.cwd(), maxBufferBytes: MAX_GITHUB_OUTPUT_BYTES, timeoutMs: GITHUB_TIMEOUT_MS },
    );
    if (
      !result.spawnError &&
      result.code === 0 &&
      !result.truncated &&
      Buffer.byteLength(result.stdout, "utf8") <= MAX_GITHUB_OUTPUT_BYTES &&
      Buffer.from(readFileSync(receiptPath)).equals(Buffer.from(bytes))
    ) {
      verified = catalogQualificationAttestationMatchesV1(result.stdout, publisher, bytes, now);
      if (verified !== undefined) statement = result.stdout;
    }
  } catch {
    verified = undefined;
  } finally {
    if (directory !== undefined) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        verified = undefined;
      }
    }
  }
  if (verified !== undefined && statement !== undefined) {
    verifiedStatements.push(statement);
    if (verifiedStatements.length > 16) verifiedStatements.shift();
  }
  return verified;
}

/**
 * Live release/build boundary. Every raw record must match a statement verified
 * by the real defaultRunner before an opaque proof is minted. A verified
 * multi-subject statement can be reused within this invocation only.
 */
export async function verifyCatalogQualificationArtifactsForPackagingV1(
  bundle: AuthoringCatalogBundleV1,
  coreBindings: CoreCompilerQualificationBindingsV1,
  records: readonly CatalogQualificationArtifactV1[],
  now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  verifiedAt = now,
): Promise<PreparedCatalogQualificationV1 | undefined> {
  const merged: Record<string, CatalogQualificationSummaryV1> = {};
  // A GH-verified multi-subject statement authenticates each named digest. Keep
  // it only within this preparation call and recheck every exact subject join.
  const verifiedStatements: string[] = [];
  const nowEpoch = Date.parse(now);
  const verifiedEpoch = Date.parse(verifiedAt);
  if (!Number.isFinite(nowEpoch) || !Number.isFinite(verifiedEpoch) || verifiedEpoch > nowEpoch)
    return undefined;
  for (const record of records) {
    const receipt = parseAihSupportedQualificationReceiptV2Bytes(record.receiptBytes);
    const policy = CATALOG_QUALIFICATION_RELEASE_POLICIES_V1.find(
      (candidate) => candidate.catalogCommit === record.publisher.commit,
    );
    const expectedPublisher =
      receipt === undefined || policy === undefined
        ? undefined
        : {
            ...policy.publisher,
            subjectName: `${receipt.entryId}.json`,
          };
    if (
      expectedPublisher === undefined ||
      policy === undefined ||
      !same(record.publisher, expectedPublisher) ||
      !same(record.receiptSetPublisher, policy.receiptSetPublisher)
    )
      return undefined;
    const receiptAttestedAt = await verifyWithGithubV1(
      record.receiptBytes,
      record.publisher,
      nowEpoch,
      verifiedStatements,
    );
    const setAttestedAt = await verifyWithGithubV1(
      record.receiptSetBytes,
      record.receiptSetPublisher,
      nowEpoch,
      verifiedStatements,
    );
    if (
      receiptAttestedAt === undefined ||
      setAttestedAt === undefined ||
      Date.parse(receiptAttestedAt) > verifiedEpoch ||
      Date.parse(setAttestedAt) > verifiedEpoch
    )
      return undefined;
    const summaries = inspectCatalogQualificationArtifactV1(
      bundle,
      record,
      coreBindings,
      now,
      verifiedAt,
    );
    if (summaries === undefined) return undefined;
    for (const [assetId, summary] of Object.entries(summaries)) {
      if (merged[assetId] !== undefined) return undefined;
      merged[assetId] = summary;
    }
  }
  return Object.keys(merged).length === 0 ? undefined : mint(merged);
}

/** Revalidates raw package records, preserving their original signed dates. */
export async function verifyCatalogQualificationForPackagingV1(
  bundle: AuthoringCatalogBundleV1,
  coreBindings: CoreCompilerQualificationBindingsV1,
  now?: string,
  verifiedAt?: string,
): Promise<PreparedCatalogQualificationV1 | undefined> {
  return verifyCatalogQualificationArtifactsForPackagingV1(
    bundle,
    coreBindings,
    packagedCatalogQualificationRecordsV1(),
    now,
    verifiedAt,
  );
}

/** Offline, inputless Studio loader. Empty package records make zero claims and do no I/O. */
export function preparePackagedCatalogQualificationV1(
  bundle: AuthoringCatalogBundleV1,
): PreparedCatalogQualificationV1 | undefined {
  const coreBindings = Object.fromEntries(
    packagedCatalogQualificationBindingsV1().map((binding) => [binding.asset.assetId, binding]),
  );
  const merged: Record<string, CatalogQualificationSummaryV1> = {};
  for (const record of packagedCatalogQualificationProjectionsV1()) {
    const parsed = CatalogQualificationSummariesV1Schema.safeParse(record.summary);
    if (!parsed.success) return undefined;
    for (const [assetId, summary] of Object.entries(parsed.data)) {
      const asset = bundle.assets[assetId];
      const source = asset === undefined ? undefined : bundle.sources[asset.sourceId];
      const binding = coreBindings[assetId];
      if (
        asset === undefined ||
        source === undefined ||
        binding === undefined ||
        summary.sourceId !== asset.sourceId ||
        asset.sourceRevisionId !== summary.sourceRevisionId ||
        asset.contentDigest !== summary.contentDigest ||
        source.revision.contentDigest !== summary.sourceContentDigest ||
        summary.compilerBindingDigest !== compilerQualificationBindingDigestV1(binding) ||
        binding.asset.assetId !== asset.id ||
        binding.asset.sourceId !== asset.sourceId ||
        binding.asset.sourceRevisionId !== asset.sourceRevisionId ||
        binding.asset.contentDigest !== asset.contentDigest ||
        binding.sourceContentDigest !== source.revision.contentDigest ||
        binding.subject.subjectDigest !== summary.subjectDigest ||
        summary.contextDigest !==
          qualificationContextDigestV1(
            (({ contextDigest: _contextDigest, ...value }) => value)(summary),
          )
      )
        return undefined;
      if (merged[assetId] !== undefined) return undefined;
      merged[assetId] = summary;
    }
  }
  return Object.keys(merged).length === 0 ? undefined : mint(merged);
}

/** Release packaging may serialize this minimal projection only after live verification. */
export function catalogQualificationPackagedProjectionV1(
  prepared: unknown,
): { summary: Record<string, CatalogQualificationSummaryV1> } | undefined {
  if (typeof prepared !== "object" || prepared === null) return undefined;
  const summaries = preparedQualifications.get(prepared);
  return summaries === undefined ? undefined : { summary: structuredClone(summaries) };
}

/** Applies only opaque preparation; parsed JSON and structural clones fail closed. */
export function catalogQualificationPreparedBundleV1(
  bundle: AuthoringCatalogBundleV1,
  prepared: unknown,
): AuthoringCatalogBundleV1 | undefined {
  if (typeof prepared !== "object" || prepared === null) return undefined;
  const summaries = preparedQualifications.get(prepared);
  return summaries === undefined
    ? undefined
    : { ...structuredClone(bundle), qualifications: structuredClone(summaries) };
}
