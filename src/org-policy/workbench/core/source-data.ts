import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1 } from "../../../baseline-evidence/scanner-publication-policy.js";
import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  parseStrictJsonObjectV1,
} from "../../../contract/strict-json-v1.js";
import type { PreparedEccRuntimeDescriptorV1 } from "../../../ecc/runtime-descriptor.js";
import { packagedScannerCollectionOverlayV1 } from "../../packaged-collection-evidence-v1.js";
import { verifyAuthoringCatalogBundleIntegrityV1 } from "../catalog-integrity.js";
import {
  actionForCompilerDeclarationV1,
  compilerRegistrationForInputFormatV1,
} from "../compilers/formats.js";
import { type AuthoringCatalogBundleV1, AuthoringCatalogBundleV1Schema } from "../contracts.js";
import {
  type PreparedWorkbenchCatalogV1,
  packagedPreparedWorkbenchCatalogV1,
} from "../prepared-catalog.js";
import { CATALOG_QUALIFICATION_RELEASE_POLICIES_V1 } from "./catalog-qualification-policy-v1.js";
import {
  readSourceDataLocalRuntimeDescriptorV1,
  sourceDataReceiptDigestsV1,
  stageSourceDataLocalHeadV1,
  verifySourceDataLocalHeadV1,
  verifySourceDataLocalReceiptV1,
  writeSourceDataLocalReceiptV1,
} from "./source-data-local-receipt.js";
import {
  SourceDataQualificationProofV1Schema,
  verifySourceDataQualificationV1,
} from "./source-data-qualification.js";

const DOMAIN = "workbench-source-data/v1";
const MAX_BYTES = 16 * 1024 * 1024;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sourceId = z.string().regex(/^source:[a-z0-9][a-z0-9.-]{0,100}$/);
const TrustSchema = z
  .object({
    version: z.literal(1),
    authorities: z
      .array(
        z
          .object({
            keyId: z.string().regex(/^[a-f0-9]{64}$/),
            publicKeyPem: z.string().min(1).max(2_048),
            role: z.literal(DOMAIN),
            sources: z.array(sourceId).min(1).max(64),
            catalogPublisherCommits: z
              .array(z.string().regex(/^[a-f0-9]{40}$/))
              .min(1)
              .max(32)
              .optional(),
            scannerPublisherCommits: z
              .array(z.string().regex(/^[a-f0-9]{40}$/))
              .min(1)
              .max(32)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export const WorkbenchSourceDataPayloadV1Schema = z
  .object({
    version: z.literal(DOMAIN),
    compatibility: z.literal("core-workbench-data/v1"),
    updateKind: z.literal("evidence-only").optional(),
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    previousDigest: digest.nullable(),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    sourceBundle: AuthoringCatalogBundleV1Schema,
    qualification: SourceDataQualificationProofV1Schema.optional(),
    scanner: z.unknown().optional(),
  })
  .strict();
const EnvelopeSchema = z
  .object({
    version: z.literal("signed-workbench-source-data/v1"),
    keyId: z.string().regex(/^[a-f0-9]{64}$/),
    payload: WorkbenchSourceDataPayloadV1Schema,
    signature: z.string().length(88),
  })
  .strict();
const IndexSchema = z
  .object({
    version: z.literal(1),
    sources: z.record(
      sourceId,
      z.object({ active: digest, history: z.array(digest).max(64) }).strict(),
    ),
  })
  .strict();
export type WorkbenchSourceDataPayloadV1 = z.infer<typeof WorkbenchSourceDataPayloadV1Schema>;
type Pin = { assetId: string; sourceId: string; sourceRevisionId: string; contentDigest: string };

function fail(message: string): never {
  throw new TypeError(`Workbench source data: ${message}`);
}
function hash(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function seal(bundle: AuthoringCatalogBundleV1): AuthoringCatalogBundleV1 {
  bundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...bundle, provenance: {} })}`;
  const parsed = AuthoringCatalogBundleV1Schema.parse(bundle);
  verifyAuthoringCatalogBundleIntegrityV1(parsed);
  return parsed;
}
export function readWorkbenchSourceDataFileV1(path: string, max = MAX_BYTES): string {
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fstatSync(fd);
    const stat = lstatSync(path);
    if (
      !opened.isFile() ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      opened.size < 1 ||
      opened.size > max ||
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      opened.size !== stat.size
    )
      fail("file changed during open");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd);
    const value = bytes.subarray(0, length);
    if (
      length !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== opened.mtimeMs ||
      !Buffer.from(value.toString("utf8"), "utf8").equals(value)
    )
      fail("invalid or changed file bytes");
    return value.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
const readBounded = readWorkbenchSourceDataFileV1;
function directory(root: string): void {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("store must be a real directory");
}
function indexAt(root: string) {
  const path = join(root, "active.json");
  const index = existsSync(path)
    ? IndexSchema.parse(parseStrictJsonObjectV1(readBounded(path, 64_000), "Source data index"))
    : { version: 1 as const, sources: {} as z.infer<typeof IndexSchema>["sources"] };
  if (Object.keys(index.sources).length > 64) fail("too many sources");
  for (const entry of Object.values(index.sources))
    if (new Set([entry.active, ...entry.history]).size !== entry.history.length + 1)
      fail("duplicate source history");
  return index;
}
function trustAt(root: string): unknown {
  return parseStrictJsonObjectV1(
    readBounded(join(root, "trust.json"), 64_000),
    "Source data trust policy",
  );
}
function fileFor(root: string, value: string): string {
  return join(root, `${digest.parse(value).slice(7)}.json`);
}

/** Default root is user-scoped, never inferred from a repository. No configuration means no external data. */
export function workbenchSourceDataRootV1(): string {
  const override = process.env.AIH_WORKBENCH_DATA;
  if (override !== undefined && (!override.trim() || override.includes("\0")))
    fail("invalid store override");
  return override === undefined
    ? join(homedir(), ".aih", "workbench-data", "v1")
    : resolve(override);
}

/** Verify a separately configured publisher role; a signature never grants runtime authority. */
export function verifyWorkbenchSourceDataEnvelopeV1(
  bytes: string,
  trustInput: unknown,
  now: string,
  historical = false,
) {
  if (Buffer.byteLength(bytes) > MAX_BYTES || !Number.isFinite(Date.parse(now)))
    fail("invalid budget or clock");
  const trust = TrustSchema.parse(trustInput);
  if (new Set(trust.authorities.map((item) => item.keyId)).size !== trust.authorities.length)
    fail("ambiguous trust root");
  const envelope = EnvelopeSchema.parse(parseStrictJsonObjectV1(bytes, "Signed source data"));
  if (canonicalStrictJsonBytesV1(envelope).toString("utf8") !== bytes)
    fail("noncanonical envelope");
  const sourceScope = Object.keys(envelope.payload.sourceBundle.sources);
  const authorities = trust.authorities.filter(
    (item) =>
      item.keyId === envelope.keyId &&
      sourceScope.length === 1 &&
      item.sources.includes(sourceScope[0]!),
  );
  const authority = authorities.length === 1 ? authorities[0] : undefined;
  if (!authority) fail("untrusted or ambiguous publisher for source");
  const publicKey = createPublicKey(authority.publicKeyPem);
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    createHash("sha256")
      .update(publicKey.export({ format: "der", type: "spki" }))
      .digest("hex") !== authority.keyId
  )
    fail("invalid configured key identity");
  const signature = Buffer.from(envelope.signature, "base64");
  if (
    signature.length !== 64 ||
    signature.toString("base64") !== envelope.signature ||
    !verify(null, canonicalStrictJsonBytesV1(envelope.payload), publicKey, signature)
  )
    fail("signature mismatch");
  const payload = envelope.payload;
  if (
    Date.parse(payload.issuedAt) > Date.parse(now) ||
    Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt) ||
    Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt) > 90 * 86_400_000 ||
    (!historical && Date.parse(payload.expiresAt) <= Date.parse(now))
  )
    fail("invalid validity window");
  const source = assertCompatibleWorkbenchSourceBundleV1(
    payload.sourceBundle,
    packagedPreparedWorkbenchCatalogV1().bundle,
    payload.updateKind,
  );
  if (!authority.sources.includes(source.id)) fail("unauthorized source scope");
  return { payload, digest: hash(bytes), sourceId: source.id, authority };
}

/** Shared structural/capability boundary; does not authenticate evidence or a publisher. */
export function assertCompatibleWorkbenchSourceBundleV1(
  bundle: AuthoringCatalogBundleV1,
  installedBundle: AuthoringCatalogBundleV1,
  updateKind?: "evidence-only",
) {
  const sources = Object.values(bundle.sources);
  if (sources.length !== 1) fail("one exact source is required");
  const source = sources[0]!;
  const builtInEvidenceOnly =
    source.id === "source:aih-core" &&
    source.inputFormat === "built-in/v1" &&
    source.upstreamOrigin.kind === "aih" &&
    updateKind === "evidence-only";
  if (updateKind !== undefined && !builtInEvidenceOnly) fail("invalid evidence-only source");
  if (builtInEvidenceOnly) {
    const installed = extractWorkbenchSourceDataV1(installedBundle, source.id);
    const inventory = (value: AuthoringCatalogBundleV1) => {
      const {
        evidence: _evidence,
        qualifications: _qualifications,
        provenance: _provenance,
        ...identity
      } = value;
      return identity;
    };
    if (
      canonicalStrictJsonSha256V1(inventory(bundle)) !==
      canonicalStrictJsonSha256V1(inventory(installed))
    )
      fail("evidence-only update differs from installed Core inventory");
  }
  if (
    source.policyInputRequired ||
    (!builtInEvidenceOnly &&
      ![
        "pinned-baseline/v1",
        "pinned-skill-collection/v1",
        "pinned-component-collection/v1",
      ].includes(source.inputFormat))
  )
    fail("unsupported source data format");
  if (
    !builtInEvidenceOnly &&
    (source.id === "source:aih-core" ||
      source.upstreamOrigin.kind === "aih" ||
      source.inputFormat === "built-in/v1")
  )
    fail("unauthorized source scope");
  const registration = compilerRegistrationForInputFormatV1(source.inputFormat);
  if (source.compiler.id !== registration.id || source.compiler.version !== registration.version)
    fail("incompatible compiler");
  for (const asset of Object.values(bundle.assets)) {
    if (
      !builtInEvidenceOnly &&
      (asset.derivation === "built-in" ||
        asset.sourceId !== source.id ||
        asset.authoring.projectorId !== undefined ||
        asset.authoring.supportedTargets.length !== 0 ||
        asset.authoring.action !== actionForCompilerDeclarationV1(source.inputFormat, asset.kind))
    )
      fail("data cannot supply Core capabilities");
  }
  verifyAuthoringCatalogBundleIntegrityV1(bundle);
  return source;
}

/** Called only with package-owned sealed records, after package loading validates their identity. */
export function applyPackagedWorkbenchSourceBundlesV1(
  base: PreparedWorkbenchCatalogV1,
  records: readonly { sourceBundle: AuthoringCatalogBundleV1; updateKind?: "evidence-only" }[],
): PreparedWorkbenchCatalogV1 {
  const result = structuredClone(base);
  const seen = new Set<string>();
  for (const record of records) {
    const source = assertCompatibleWorkbenchSourceBundleV1(
      record.sourceBundle,
      base.bundle,
      record.updateKind,
    );
    if (seen.has(source.id)) fail("duplicate packaged source");
    seen.add(source.id);
    replaceSource(result, record.sourceBundle, source.id);
  }
  result.bundle = seal(result.bundle);
  return result;
}

/** Signature validation alone is not evidence custody. This route admits release-known evidence only. */
export function verifyWorkbenchSourceDataV1(
  bytes: string,
  trustInput: unknown,
  now: string,
  historical = false,
) {
  const checked = verifyWorkbenchSourceDataEnvelopeV1(bytes, trustInput, now, historical);
  const { payload, authority } = checked;
  const bundle = payload.sourceBundle;
  if (payload.scanner !== undefined) fail("independent Scanner proof requires asynchronous import");
  // A data publisher is not a Scanner authority. Until a separately authenticated
  // Scanner refresh proof is supplied, only exact release-prepared custody may
  // be transported. Unknown evidence must remain explicitly non-authoritative.
  const packagedEvidence = packagedScannerCollectionOverlayV1(bundle);
  for (const [id, evidence] of Object.entries(bundle.evidence)) {
    const expected = packagedEvidence[id];
    if (
      expected !== undefined &&
      canonicalStrictJsonSha256V1(expected) === canonicalStrictJsonSha256V1(evidence)
    )
      continue;
    if (evidence.verification.state !== "missing" && evidence.verification.state !== "unverified")
      fail("independent Scanner evidence proof required");
    if (
      evidence.scan.outcome !== "unknown" ||
      evidence.scan.coverage !== "none" ||
      evidence.scan.reportSignedAt !== undefined ||
      evidence.qualification.state !== "unknown"
    )
      fail("independent Scanner evidence proof required");
  }
  verifySourceDataQualificationV1(
    bundle,
    payload.qualification,
    payload.issuedAt,
    authority.catalogPublisherCommits,
  );
  return checked;
}

const importWitnesses = new Map<string, string>();
/** Only the effective authority for this exact source may invalidate its receipt. */
function effectiveSourceTrust(checked: ReturnType<typeof verifyWorkbenchSourceDataEnvelopeV1>) {
  return {
    version: "workbench-effective-source-trust/v1",
    sourceId: checked.sourceId,
    keyId: checked.authority.keyId,
    role: checked.authority.role,
    scannerPublisherCommits: [
      ...new Set(
        checked.authority.scannerPublisherCommits ??
          SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1.map((item) => item.commit),
      ),
    ].sort(),
    catalogPublisherCommits: [
      ...new Set(
        checked.authority.catalogPublisherCommits ??
          CATALOG_QUALIFICATION_RELEASE_POLICIES_V1.map((policy) => policy.catalogCommit),
      ),
    ].sort(),
  };
}
function verifyStored(
  root: string,
  bytes: string,
  trust: unknown,
  now: string,
  historical = false,
) {
  const checked = verifyWorkbenchSourceDataEnvelopeV1(bytes, trust, now, historical);
  const effectiveTrust = effectiveSourceTrust(checked);
  const trustDigest = canonicalStrictJsonSha256V1(effectiveTrust);
  if (importWitnesses.get(checked.digest) === trustDigest) return checked;
  if (checked.payload.scanner !== undefined || checked.payload.qualification !== undefined) {
    verifySourceDataLocalReceiptV1(
      root,
      sourceDataReceiptDigestsV1(checked.digest, effectiveTrust, checked.payload.sourceBundle),
      now,
      historical,
    );
    return checked;
  }
  return verifyWorkbenchSourceDataV1(bytes, trust, now, historical);
}

/** Raw verification precedes local receipt creation and the active-pointer transaction. */
export async function importWorkbenchSourceDataWithProofsV1(
  root: string,
  bytes: string,
  options: { sourceRoot?: string; proofRoot?: string; now?: string } = {},
) {
  const now = options.now ?? new Date().toISOString();
  directory(root);
  const trust = trustAt(root);
  const checked = verifyWorkbenchSourceDataEnvelopeV1(bytes, trust, now);
  let runtimeDescriptor: PreparedEccRuntimeDescriptorV1 | undefined;
  if (checked.payload.scanner === undefined) {
    verifyWorkbenchSourceDataV1(bytes, trust, now);
  } else {
    if (!options.sourceRoot)
      fail("Scanner proof import requires --scanner-source with exact source bytes");
    const { prepareSourceDataScannerRuntimeFactsV1 } = await import("./source-data-scanner.js");
    const scanner = await prepareSourceDataScannerRuntimeFactsV1(
      checked.payload.sourceBundle,
      checked.payload.scanner,
      options.sourceRoot,
      checked.payload.issuedAt,
      checked.authority.scannerPublisherCommits,
      now,
      options.proofRoot,
    );
    if (
      canonicalStrictJsonSha256V1(scanner.evidence) !==
      canonicalStrictJsonSha256V1(checked.payload.sourceBundle.evidence)
    )
      fail("Scanner evidence differs from original verified reports");
    runtimeDescriptor = scanner.descriptor;
    verifySourceDataQualificationV1(
      checked.payload.sourceBundle,
      checked.payload.qualification,
      checked.payload.issuedAt,
      checked.authority.catalogPublisherCommits,
    );
  }
  const effectiveTrust = effectiveSourceTrust(checked);
  const trustDigest = canonicalStrictJsonSha256V1(effectiveTrust);
  if (
    canonicalStrictJsonSha256V1(
      effectiveSourceTrust(verifyWorkbenchSourceDataEnvelopeV1(bytes, trustAt(root), now)),
    ) !== trustDigest
  )
    fail("trust policy changed during preparation");
  if (checked.payload.scanner !== undefined || checked.payload.qualification !== undefined) {
    const expiry = Math.min(
      Date.parse(checked.payload.expiresAt),
      ...Object.values(checked.payload.sourceBundle.evidence).flatMap((item) =>
        item.verification.validUntil ? [Date.parse(item.verification.validUntil)] : [],
      ),
      ...Object.values(checked.payload.sourceBundle.qualifications ?? {}).map((item) =>
        Date.parse(item.validUntil),
      ),
    );
    if (expiry <= Date.parse(now)) fail("verified source evidence has expired");
    writeSourceDataLocalReceiptV1(root, {
      ...sourceDataReceiptDigestsV1(checked.digest, effectiveTrust, checked.payload.sourceBundle),
      verifiedAt: now,
      expiresAt: new Date(expiry).toISOString(),
      ...(runtimeDescriptor === undefined ? {} : { runtimeDescriptor }),
    });
  }
  importWitnesses.set(checked.digest, trustDigest);
  try {
    return importWorkbenchSourceDataV1(root, bytes, now);
  } finally {
    importWitnesses.delete(checked.digest);
  }
}

/** Extracts data only; this encoder neither signs it nor creates verification custody. */
export function extractWorkbenchSourceDataV1(
  input: AuthoringCatalogBundleV1,
  id: string,
): AuthoringCatalogBundleV1 {
  const source = input.sources[id];
  if (!source) fail("unknown source");
  const assets = Object.fromEntries(
    Object.entries(input.assets).filter(([, asset]) => asset.sourceId === id),
  );
  const ids = new Set(Object.keys(assets));
  const chunks = new Set(Object.values(assets).map((asset) => asset.detailChunkId));
  return seal(
    structuredClone({
      ...input,
      sources: { [id]: source },
      assets,
      groups: Object.fromEntries(
        Object.entries(input.groups).filter(([, group]) =>
          group.assetIds.every((asset) => ids.has(asset)),
        ),
      ),
      relations: input.relations.filter(
        (item) => ids.has(item.fromAssetId) && ids.has(item.toAssetId),
      ),
      templates: Object.fromEntries(
        Object.entries(input.templates).filter(
          ([, item]) =>
            item.roots.every((root) => ids.has(root.assetId)) &&
            item.exclusions.every((id) => ids.has(id)),
        ),
      ),
      detailChunks: Object.fromEntries(
        Object.entries(input.detailChunks).filter(([id]) => chunks.has(id)),
      ),
      evidence: Object.fromEntries(
        Object.entries(input.evidence).filter(([, item]) =>
          item.subjects.every((subject) => ids.has(subject.assetId)),
        ),
      ),
      ...(input.qualifications === undefined
        ? {}
        : {
            qualifications: Object.fromEntries(
              Object.entries(input.qualifications).filter(([, item]) => ids.has(item.assetId)),
            ),
          }),
    }),
  );
}

/** Atomic activation: validation and chain checks precede the only active-pointer replacement. */
export function importWorkbenchSourceDataV1(
  root: string,
  bytes: string,
  now = new Date().toISOString(),
) {
  directory(root);
  const trusted = verifyStored(root, bytes, trustAt(root), now);
  const lock = join(root, "import.lock");
  const fd = openSync(lock, "wx", 0o600);
  let temporary: string | undefined;
  let restoreLocalHead: (() => void) | undefined;
  try {
    const index = indexAt(root);
    const previousIndex = structuredClone(index);
    const previous = index.sources[trusted.sourceId];
    if (previous?.active === trusted.digest) {
      verifySourceDataLocalHeadV1(root, index);
      return trusted;
    }
    if (previous === undefined) {
      if (trusted.payload.sequence !== 1 || trusted.payload.previousDigest !== null)
        fail("initial source chain mismatch");
    } else {
      const old = verifyStored(
        root,
        readBounded(fileFor(root, previous.active)),
        trustAt(root),
        now,
        true,
      );
      if (
        old.digest !== previous.active ||
        old.sourceId !== trusted.sourceId ||
        trusted.payload.previousDigest !== previous.active ||
        trusted.payload.sequence !== old.payload.sequence + 1 ||
        Date.parse(trusted.payload.issuedAt) < Date.parse(old.payload.issuedAt)
      )
        fail("source chain mismatch");
      if (previous.history.length >= 64) fail("retained history budget reached");
    }
    // Validate the whole composition before touching the active pointer. All unrelated
    // snapshots are reused exactly; there is no scan, network acquisition, or selection edit.
    const composed = packagedPreparedWorkbenchCatalogV1();
    for (const [id, entry] of Object.entries(index.sources)) {
      if (id === trusted.sourceId) continue;
      const retained = verifyStored(
        root,
        readBounded(fileFor(root, entry.active)),
        trustAt(root),
        now,
        true,
      );
      if (retained.digest !== entry.active || retained.sourceId !== id)
        fail("retained snapshot identity mismatch");
      replaceSource(composed, retained.payload.sourceBundle, id);
    }
    replaceSource(composed, trusted.payload.sourceBundle, trusted.sourceId);
    seal(composed.bundle);
    const target = fileFor(root, trusted.digest);
    try {
      writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (readBounded(target) !== bytes) fail("immutable snapshot differs");
    }
    index.sources[trusted.sourceId] = {
      active: trusted.digest,
      history: previous ? [previous.active, ...previous.history] : [],
    };
    IndexSchema.parse(index);
    restoreLocalHead = stageSourceDataLocalHeadV1(root, previousIndex, index);
    temporary = join(root, `active-${randomUUID()}.tmp`);
    const staged = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(staged, canonicalStrictJsonBytesV1(index));
      fsyncSync(staged);
    } finally {
      closeSync(staged);
    }
    renameSync(temporary, join(root, "active.json"));
    restoreLocalHead = undefined;
    temporary = undefined;
    return trusted;
  } finally {
    restoreLocalHead?.();
    closeSync(fd);
    unlinkSync(lock);
    if (temporary !== undefined) unlinkSync(temporary);
  }
}

function exactPins(bundle: AuthoringCatalogBundleV1, pins: readonly Pin[]) {
  return pins.every((pin) => {
    const asset = bundle.assets[pin.assetId];
    return (
      asset !== undefined &&
      asset.sourceId === pin.sourceId &&
      asset.sourceRevisionId === pin.sourceRevisionId &&
      asset.contentDigest === pin.contentDigest
    );
  });
}

/**
 * Protected local runtime facts for exact historical ECC pins. Each value is
 * re-bound to the active source-data envelope, current trust policy and its
 * machine-local verification receipt before it leaves this module.
 */
export function historicalEccRuntimeDescriptorsFromSourceDataV1(
  root = workbenchSourceDataRootV1(),
  now = new Date().toISOString(),
): readonly import("../../../ecc/runtime-descriptor.js").EccRuntimeDescriptorV1[] {
  if (!existsSync(root) || !existsSync(join(root, "active.json"))) return [];
  directory(root);
  const trust = trustAt(root);
  const index = indexAt(root);
  verifySourceDataLocalHeadV1(root, index);
  const descriptors: import("../../../ecc/runtime-descriptor.js").EccRuntimeDescriptorV1[] = [];
  for (const entry of Object.values(index.sources)) {
    for (const reference of [entry.active, ...entry.history]) {
      const checked = verifyStored(root, readBounded(fileFor(root, reference)), trust, now, true);
      if (checked.digest !== reference) fail("historical source snapshot identity mismatch");
      const descriptor = readSourceDataLocalRuntimeDescriptorV1(
        root,
        sourceDataReceiptDigestsV1(
          checked.digest,
          effectiveSourceTrust(checked),
          checked.payload.sourceBundle,
        ),
        now,
        true,
      );
      if (descriptor === undefined) continue;
      const sources = Object.values(checked.payload.sourceBundle.sources);
      const source = sources.length === 1 ? sources[0] : undefined;
      if (
        source === undefined ||
        source.upstreamOrigin.kind !== "git" ||
        source.upstreamOrigin.locator !== descriptor.source.repository ||
        source.revision.id !== descriptor.source.commit ||
        source.revision.contentDigest !== descriptor.compilerInputDigest
      )
        fail("runtime descriptor does not bind the retained source snapshot");
      descriptors.push(descriptor);
    }
  }
  return descriptors;
}

/** Reconstruct authorized source data and retain exact saved pins; never import caller action bindings. */
export function applyWorkbenchSourceDataV1(
  base: PreparedWorkbenchCatalogV1,
  options: { root?: string; now?: string; pins?: readonly Pin[] } = {},
): PreparedWorkbenchCatalogV1 {
  const root = options.root ?? workbenchSourceDataRootV1();
  if (!existsSync(root)) return structuredClone(base);
  directory(root);
  if (!existsSync(join(root, "active.json"))) return structuredClone(base);
  const now = options.now ?? new Date().toISOString();
  const trust = trustAt(root);
  const index = indexAt(root);
  verifySourceDataLocalHeadV1(root, index);
  const result = structuredClone(base);
  for (const [id, entry] of Object.entries(index.sources)) {
    const pins = (options.pins ?? []).filter((pin) => pin.sourceId === id);
    const snapshots = [entry.active, ...entry.history];
    let chosen: AuthoringCatalogBundleV1 | undefined;
    for (const reference of snapshots) {
      const verified = verifyStored(
        root,
        readBounded(fileFor(root, reference)),
        trust,
        now,
        // Reading an already accepted snapshot is dated display, not fresh intake.
        // Signature, current trust, local receipt and protected-head checks remain.
        true,
      );
      if (verified.digest !== reference || verified.sourceId !== id)
        fail("snapshot identity mismatch");
      if (exactPins(verified.payload.sourceBundle, pins)) {
        chosen = structuredClone(verified.payload.sourceBundle);
        const expires = Date.parse(verified.payload.expiresAt);
        for (const evidence of Object.values(chosen.evidence)) {
          if (
            evidence.verification.state === "verified" &&
            evidence.verification.validUntil &&
            Date.parse(evidence.verification.validUntil) > expires
          ) {
            if (Date.parse(evidence.verification.verifiedAt!) >= expires)
              evidence.verification = { state: "stale" };
            else evidence.verification.validUntil = verified.payload.expiresAt;
          }
        }
        for (const [assetId, qualification] of Object.entries(chosen.qualifications ?? {})) {
          if (Date.parse(qualification.validUntil) > expires) {
            if (Date.parse(qualification.notBefore) >= expires)
              delete chosen.qualifications![assetId];
            else qualification.validUntil = verified.payload.expiresAt;
          }
        }
        break;
      }
    }
    if (chosen === undefined) {
      if (exactPins(base.bundle, pins)) continue;
      fail("no retained snapshot matches saved source pins");
    }
    replaceSource(result, chosen, id);
  }
  result.bundle = seal(result.bundle);
  return result;
}

function replaceSource(
  result: PreparedWorkbenchCatalogV1,
  chosen: AuthoringCatalogBundleV1,
  id: string,
): void {
  const oldBindings = structuredClone(result.bindings);
  const previousIds = new Set(
    Object.values(result.bundle.assets)
      .filter((asset) => asset.sourceId === id)
      .map((asset) => asset.id),
  );
  const previousChunks = new Set(
    [...previousIds].map((id) => result.bundle.assets[id]!.detailChunkId),
  );
  const exactOld = new Map([...previousIds].map((id) => [id, result.bundle.assets[id]!]));
  const changed = (assetId: string) => {
    const old = exactOld.get(assetId);
    return (
      old !== undefined &&
      !exactPins(chosen, [
        {
          assetId,
          sourceId: old.sourceId,
          sourceRevisionId: old.sourceRevisionId,
          contentDigest: old.contentDigest,
        },
      ])
    );
  };
  const mixed = (ids: readonly string[]) =>
    ids.some((id) => previousIds.has(id)) && ids.some((id) => !previousIds.has(id));
  const incompatible = (ids: readonly string[]) => mixed(ids) && ids.some(changed);
  if (
    Object.values(result.bundle.groups).some((group) => incompatible(group.assetIds)) ||
    Object.values(result.bundle.templates).some((template) =>
      incompatible([...template.roots.map((root) => root.assetId), ...template.exclusions]),
    ) ||
    result.bundle.relations.some((relation) =>
      incompatible([relation.fromAssetId, relation.toAssetId]),
    ) ||
    Object.values(result.bundle.evidence).some((evidence) =>
      incompatible(evidence.subjects.map((subject) => subject.assetId)),
    )
  )
    fail(
      "update invalidates a cross-source closure; recompile the affected composition explicitly",
    );
  for (const assetId of previousIds) {
    delete result.bundle.assets[assetId];
    delete result.bindings[assetId];
  }
  for (const chunk of previousChunks)
    if (!Object.values(result.bundle.assets).some((asset) => asset.detailChunkId === chunk))
      delete result.bundle.detailChunks[chunk];
  for (const [groupId, group] of Object.entries(result.bundle.groups))
    if (group.assetIds.some((id) => previousIds.has(id)) && !mixed(group.assetIds))
      delete result.bundle.groups[groupId];
  for (const [templateId, template] of Object.entries(result.bundle.templates)) {
    const ids = [...template.roots.map((root) => root.assetId), ...template.exclusions];
    if (ids.some((id) => previousIds.has(id)) && !mixed(ids))
      delete result.bundle.templates[templateId];
  }
  result.bundle.relations = result.bundle.relations.filter(
    (item) =>
      (!previousIds.has(item.fromAssetId) && !previousIds.has(item.toAssetId)) ||
      mixed([item.fromAssetId, item.toAssetId]),
  );
  for (const [evidenceId, evidence] of Object.entries(result.bundle.evidence))
    if (
      evidence.subjects.some((subject) => previousIds.has(subject.assetId)) &&
      !mixed(evidence.subjects.map((subject) => subject.assetId))
    )
      delete result.bundle.evidence[evidenceId];
  for (const [qualificationId, qualification] of Object.entries(result.bundle.qualifications ?? {}))
    if (previousIds.has(qualification.assetId))
      delete result.bundle.qualifications![qualificationId];
  for (const field of [
    "sources",
    "assets",
    "detailChunks",
    "groups",
    "templates",
    "evidence",
    "qualifications",
  ] as const) {
    // Missing publisher-supplied display data must not erase known exact-source
    // Scanner findings. The release-prepared overlay is independently owned.
    const retainedEvidence = field === "evidence" ? packagedScannerCollectionOverlayV1(chosen) : {};
    const incoming =
      field === "evidence"
        ? {
            ...retainedEvidence,
            ...Object.fromEntries(
              Object.entries(chosen.evidence).map(([key, value]) => [
                key,
                value.verification.state === "verified" ? value : (retainedEvidence[key] ?? value),
              ]),
            ),
          }
        : chosen[field];
    if (incoming === undefined) continue;
    const current = result.bundle[field] ?? {};
    for (const key of Object.keys(incoming))
      if (Object.hasOwn(current, key) && !(field === "sources" && key === id))
        fail("source data collides with unrelated data");
    Object.assign(current, incoming);
    Object.assign(result.bundle, { [field]: current });
  }
  result.bundle.relations.push(...chosen.relations);
  for (const asset of Object.values(chosen.assets)) {
    const old = exactOld.get(asset.id);
    result.bindings[asset.id] =
      old !== undefined &&
      exactPins(chosen, [
        {
          assetId: old.id,
          sourceId: old.sourceId,
          sourceRevisionId: old.sourceRevisionId,
          contentDigest: old.contentDigest,
        },
      ])
        ? structuredClone(oldBindings[asset.id] ?? { kind: "intent" })
        : { kind: "intent" };
  }
}
