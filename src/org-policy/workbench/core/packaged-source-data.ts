import { createHash } from "node:crypto";
import { SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1 } from "../../../baseline-evidence/scanner-publication-policy.js";
import {
  assertSafeRelativePosixPathV1,
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../../../contract/strict-json-v1.js";
import {
  type EccRuntimeDescriptorV1,
  registerPackagedEccRuntimeDescriptorsV1,
  packagedEccRuntimeDescriptorsV1 as runtimeDescriptorsForPackageOwnerV1,
} from "../../../ecc/runtime-descriptor.js";
import { verifyAuthoringCatalogBundleIntegrityV1 } from "../catalog-integrity.js";
import type { WorkbenchPolicyBindingsV1 } from "../compile-policy.js";
import {
  actionForCompilerDeclarationV1,
  compilerRegistrationForInputFormatV1,
} from "../compilers/formats.js";
import type { AuthoringCatalogBundleV1 } from "../contracts.js";
import type {
  PreparedWorkbenchCatalogV1,
  PrepareWorkbenchCatalogOptionsV1,
} from "../prepared-catalog.js";
import { PACKAGED_WORKBENCH_SOURCE_DATA_V1 } from "./packaged-source-data-data.js";
import {
  type PackagedSourceDataRecordV1,
  PackagedSourceDataRecordV1Schema,
} from "./packaged-source-data-record.js";
import { applyPackagedWorkbenchSourceBundlesV1 } from "./source-data.js";

let cached: readonly PackagedSourceDataRecordV1[] | undefined;
const sealedIdentityByRecord = new WeakMap<PackagedSourceDataRecordV1, string>();
const registeredRuntimeDescriptorRecords = new WeakSet<PackagedSourceDataRecordV1>();
const PREPARED_OVERLAY_CACHE_LIMIT_V1 = 4;
type PreparedOverlayV1 = Readonly<Pick<PreparedWorkbenchCatalogV1, "bundle" | "bindings">>;
const preparedOverlays = new Map<string, PreparedOverlayV1>();
/** Only this package's literal sealed records can enter the offline bootstrap path. */
export function packagedWorkbenchSourceDataRecordsV1(): readonly PackagedSourceDataRecordV1[] {
  return structuredClone(verifiedPackagedWorkbenchSourceDataRecordsV1());
}

function verifiedPackagedWorkbenchSourceDataRecordsV1(): readonly PackagedSourceDataRecordV1[] {
  if (cached === undefined) {
    if (
      PACKAGED_WORKBENCH_SOURCE_DATA_V1.length > 64 ||
      PACKAGED_WORKBENCH_SOURCE_DATA_V1.reduce(
        (total, item) => total + Buffer.byteLength(item.bytes),
        0,
      ) >
        64 * 1024 * 1024
    )
      throw new TypeError("Packaged source inventory exceeds its byte budget");
    const seen = new Set<string>();
    const records = PACKAGED_WORKBENCH_SOURCE_DATA_V1.map((sealed) => {
      if (Buffer.byteLength(sealed.bytes) > 16 * 1024 * 1024)
        throw new TypeError("Packaged source data exceeds its byte budget");
      const value = parseStrictJsonObjectV1(sealed.bytes, "Packaged source data");
      const canonicalBytes = canonicalStrictJsonBytesV1(value);
      if (
        canonicalBytes.toString("utf8") !== sealed.bytes ||
        createHash("sha256").update(canonicalBytes).digest("hex") !== sealed.sha256
      )
        throw new TypeError("Packaged source data seal mismatch");
      const record = PackagedSourceDataRecordV1Schema.parse(value);
      verifyAuthoringCatalogBundleIntegrityV1(record.sourceBundle);
      const sources = Object.values(record.sourceBundle.sources);
      const source = sources[0];
      if (sources.length !== 1 || !source || seen.has(source.id))
        throw new TypeError("Packaged source identity is ambiguous");
      if (
        source.upstreamOrigin.kind !== "aih" &&
        (source.upstreamOrigin.locator.replace(/^https:\/\/github\.com\//, "") !==
          record.source.repository ||
          source.revision.id !== record.source.commit)
      )
        throw new TypeError("Packaged source archive identity mismatch");
      seen.add(source.id);
      return record;
    });
    cached = deepFreezeStrictJsonV1(records) as readonly PackagedSourceDataRecordV1[];
    for (const [index, record] of cached.entries()) {
      const sealed = PACKAGED_WORKBENCH_SOURCE_DATA_V1[index];
      if (!sealed) throw new TypeError("Packaged source data identity is missing");
      sealedIdentityByRecord.set(record, sealed.sha256);
    }
  }
  return cached;
}

/**
 * Runtime descriptors are package literals only; user source-data imports cannot enter this registry.
 * Catalog preparation validates the outer package seal but does not establish runtime materialization
 * validity. Runtime consumers validate the nested descriptor seal when they actually need it.
 */
export function packagedEccRuntimeDescriptorsV1() {
  const descriptors: EccRuntimeDescriptorV1[] = [];
  for (const record of verifiedPackagedWorkbenchSourceDataRecordsV1()) {
    if (!registeredRuntimeDescriptorRecords.has(record)) {
      registerPackagedEccRuntimeDescriptorsV1(
        record,
        record.runtimeDescriptor === undefined ? [] : [record.runtimeDescriptor],
      );
      // Registration can throw for a malformed nested seal. Mark only a fully validated owner so
      // a later resolution attempt cannot treat its empty registry as trusted.
      registeredRuntimeDescriptorRecords.add(record);
    }
    descriptors.push(...runtimeDescriptorsForPackageOwnerV1(record));
  }
  return descriptors;
}

/** Package data is applied before independently authenticated user updates. */
export function applyPackagedWorkbenchSourceDataV1(
  base: PreparedWorkbenchCatalogV1,
  pins: PrepareWorkbenchCatalogOptionsV1["sourceDataPins"] = [],
): PreparedWorkbenchCatalogV1 {
  const records = verifiedPackagedWorkbenchSourceDataRecordsV1().filter((record) => {
    const sourceId = Object.keys(record.sourceBundle.sources)[0];
    if (!sourceId) throw new TypeError("Packaged source identity is missing");
    return pins
      .filter((pin) => pin.sourceId === sourceId)
      .every((pin) => {
        const asset = record.sourceBundle.assets[pin.assetId];
        return (
          asset?.sourceRevisionId === pin.sourceRevisionId &&
          asset.contentDigest === pin.contentDigest
        );
      });
  });
  if (records.length === 0) return base;
  const recordIdentities = records.map((record) => {
    const identity = sealedIdentityByRecord.get(record);
    if (!identity) throw new TypeError("Packaged source data identity is missing");
    return identity;
  });
  // Pin filtering is already represented by the ordered record identities.
  const key = canonicalStrictJsonSha256V1({
    bundle: base.bundle,
    bindings: base.bindings,
    recordIdentities,
  });
  const hit = preparedOverlays.get(key);
  if (hit !== undefined) {
    preparedOverlays.delete(key);
    preparedOverlays.set(key, hit);
    return detachedPreparedOverlay(base, hit);
  }
  const applied = applyPackagedWorkbenchSourceBundlesV1(base, records);
  for (const record of records) {
    for (const [assetId, binding] of packagedCompilerBindingsV1(record)) {
      if (applied.bundle.assets[assetId] === undefined)
        throw new TypeError("Packaged compiler declaration is absent after replacement");
      applied.bindings[assetId] = binding;
    }
  }
  const overlay = Object.freeze({
    bundle: deepFreezeStrictJsonV1(
      structuredClone(applied.bundle),
    ) as PreparedWorkbenchCatalogV1["bundle"],
    bindings: deepFreezeStrictJsonV1(
      structuredClone(applied.bindings),
    ) as PreparedWorkbenchCatalogV1["bindings"],
  });
  preparedOverlays.set(key, overlay);
  if (preparedOverlays.size > PREPARED_OVERLAY_CACHE_LIMIT_V1) {
    const oldest = preparedOverlays.keys().next().value;
    if (oldest === undefined) throw new TypeError("Prepared package overlay cache eviction");
    preparedOverlays.delete(oldest);
  }
  return detachedPreparedOverlay(base, overlay);
}

const FRAMEWORK_ASSET_KINDS = new Set([
  "agent",
  "baseline",
  "capability",
  "framework",
  "lang",
  "mcp",
  "module",
  "runtime",
  "skill",
]);
const frameworkAssetId = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;
const commit = /^[a-f0-9]{40}$/;
const sourceDigest = /^[a-f0-9]{64}$/;
const githubRepository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`Invalid packaged ${label}`);
  return value as Record<string, unknown>;
}

function strictKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new TypeError(`Invalid packaged ${label}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_000)
    throw new TypeError(`Invalid packaged ${label}`);
  return value;
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 2_000)
    throw new TypeError(`Invalid packaged ${label}`);
  return value.map((item) => text(item, label));
}

/**
 * Package records retain compiler source metadata but not source bytes. This
 * verifies the sealed compiler declaration against its compiled output before
 * restoring the same external-selection projection that Core owns for pinned
 * framework sources. Raw compiler replay remains a release-only operation.
 */
function packagedCompilerBindingsV1(
  record: PackagedSourceDataRecordV1,
): ReadonlyArray<readonly [string, WorkbenchPolicyBindingsV1[string]]> {
  const sourceIds = Object.keys(record.sourceBundle.sources);
  const sourceId = sourceIds[0];
  if (sourceIds.length !== 1 || sourceId === undefined)
    throw new TypeError("Packaged compiler source is ambiguous");
  const source = record.sourceBundle.sources[sourceId];
  if (source === undefined) throw new TypeError("Packaged compiler source is missing");
  const template = object(record.compilerTemplate, "compiler template");
  const inputFormat = text(template.version, "compiler template version");
  const registration = compilerRegistrationForInputFormatV1(inputFormat);
  if (
    inputFormat !== source.inputFormat ||
    registration.id !== source.compiler.id ||
    registration.version !== source.compiler.version
  )
    throw new TypeError("Packaged compiler registration does not match source");
  if (inputFormat !== "pinned-baseline/v1") return [];
  strictKeys(template, ["version", "framework"], "compiler template");

  const framework = object(template.framework, "framework compiler template");
  strictKeys(framework, ["id", "repository", "commit", "assets"], "framework compiler template");
  const frameworkId = text(framework.id, "framework compiler id");
  const repository = text(framework.repository, "framework compiler repository");
  const revision = text(framework.commit, "framework compiler commit");
  if (
    (frameworkId !== "ecc" && frameworkId !== "superpowers") ||
    !githubRepository.test(repository) ||
    !commit.test(revision) ||
    sourceId !== `source:${frameworkId}` ||
    source.upstreamOrigin.kind !== "git" ||
    source.upstreamOrigin.locator !== repository ||
    source.revision.id !== revision
  )
    throw new TypeError("Packaged framework compiler source mismatch");
  if (
    !Array.isArray(framework.assets) ||
    framework.assets.length < 1 ||
    framework.assets.length > 1_000
  )
    throw new TypeError("Invalid packaged framework compiler assets");

  const bindings: Array<readonly [string, WorkbenchPolicyBindingsV1[string]]> = [];
  const expected = new Set<string>();
  for (const supplied of framework.assets) {
    const asset = object(supplied, "framework compiler declaration");
    strictKeys(
      asset,
      [
        "id",
        "kind",
        "curationKind",
        "riders",
        "dependencies",
        "members",
        "source",
        "sourcePaths",
        "metadata",
      ],
      "framework compiler declaration",
    );
    const id = text(asset.id, "framework compiler asset id");
    const kind = text(asset.kind, "framework compiler asset kind");
    if (!frameworkAssetId.test(id) || !FRAMEWORK_ASSET_KINDS.has(kind))
      throw new TypeError("Invalid packaged framework compiler declaration");
    if (
      asset.curationKind !== undefined &&
      !["agent", "skill", "command"].includes(
        text(asset.curationKind, "framework compiler curation kind"),
      )
    )
      throw new TypeError("Invalid packaged framework compiler declaration");
    for (const field of ["riders", "dependencies", "members"] as const)
      if (asset[field] !== undefined) strings(asset[field], `framework compiler ${field}`);
    for (const path of strings(asset.sourcePaths, "framework compiler source paths"))
      assertSafeRelativePosixPathV1(path, "framework compiler source path");
    const declaredSource = object(asset.source, "framework compiler asset source");
    strictKeys(declaredSource, ["repository", "commit", "path"], "framework compiler asset source");
    const item = {
      id,
      kind,
      source: {
        repository: text(declaredSource.repository, "framework compiler asset repository"),
        commit: text(declaredSource.commit, "framework compiler asset commit"),
        path: assertSafeRelativePosixPathV1(
          text(declaredSource.path, "framework compiler asset path"),
          "framework compiler asset path",
        ),
      },
    };
    if (
      item.source.repository !== repository ||
      item.source.commit !== revision ||
      !commit.test(item.source.commit)
    )
      throw new TypeError("Packaged framework compiler declaration source mismatch");
    if (asset.metadata !== undefined) {
      const metadata = object(asset.metadata, "framework compiler metadata");
      strictKeys(
        metadata,
        ["title", "summary", "usageContext", "allowedTools", "sourcePath", "sourceSha256"],
        "framework compiler metadata",
      );
      for (const field of [
        "title",
        "summary",
        "usageContext",
        "sourcePath",
        "sourceSha256",
      ] as const)
        field === "sourcePath"
          ? assertSafeRelativePosixPathV1(
              text(metadata[field], `framework compiler metadata ${field}`),
              "framework compiler metadata source path",
            )
          : text(metadata[field], `framework compiler metadata ${field}`);
      if (
        !sourceDigest.test(text(metadata.sourceSha256, "framework compiler metadata source digest"))
      )
        throw new TypeError("Invalid packaged framework compiler metadata");
      strings(metadata.allowedTools, "framework compiler metadata tools");
    }
    const assetId = `${frameworkId}/${id}`;
    const compiled = record.sourceBundle.assets[assetId];
    if (
      expected.has(assetId) ||
      compiled === undefined ||
      compiled.id !== assetId ||
      compiled.sourceId !== sourceId ||
      compiled.sourceRevisionId !== revision ||
      compiled.derivation !== "upstream" ||
      compiled.kind !== kind ||
      compiled.originalPath !== item.source.path ||
      compiled.authoring.action !== actionForCompilerDeclarationV1(inputFormat, kind)
    )
      throw new TypeError("Packaged framework compiler declaration mismatch");
    expected.add(assetId);
    bindings.push([
      assetId,
      {
        kind: "external-selection",
        external: { owner: frameworkId, item },
      },
    ]);
  }
  for (const compiled of Object.values(record.sourceBundle.assets))
    if (
      compiled.sourceId === sourceId &&
      compiled.derivation === "upstream" &&
      !expected.has(compiled.id)
    )
      throw new TypeError("Packaged framework compiler output has an undeclared asset");
  return bindings;
}

function detachedPreparedOverlay(
  base: PreparedWorkbenchCatalogV1,
  overlay: PreparedOverlayV1,
): PreparedWorkbenchCatalogV1 {
  return {
    ...base,
    bundle: structuredClone(overlay.bundle),
    bindings: structuredClone(overlay.bindings),
  };
}

/** Publication identities for package reports actually present in the displayed catalog. */
export function packagedWorkbenchSourcePublicationsV1(bundle: AuthoringCatalogBundleV1) {
  return packagedWorkbenchSourceDataRecordsV1().flatMap((record) => {
    const included = Object.values(record.sourceBundle.evidence).some(
      (evidence) =>
        canonicalStrictJsonSha256V1(bundle.evidence[evidence.id] ?? null) ===
        canonicalStrictJsonSha256V1(evidence),
    );
    if (!included) return [];
    const proof = record.scannerProof;
    if (!proof || typeof proof !== "object" || !("publisherCommit" in proof))
      throw new TypeError("Packaged Scanner publisher is missing");
    const publisher = SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1.find(
      (candidate) => candidate.commit === proof.publisherCommit,
    );
    if (!publisher) throw new TypeError("Unknown packaged Scanner publisher");
    return record.publicationBlobs.map((publication) => ({
      source: record.source.repository,
      publisher: publisher.repository,
      commit: publisher.commit,
      digest: `sha256:${publication.sha256}`,
    }));
  });
}
