import { createHash } from "node:crypto";
import {
  authorPreparedAihScannerPublicationV1,
  type PreparedAihScannerPublicationsV1,
} from "../../../baseline-evidence/aih-scan-preparation.js";
import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
} from "../../../contract/strict-json-v1.js";
import {
  ExactSemverV2Schema,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../governance-decision-v2.js";
import type { AuthoringCatalogBundleV1 } from "../contracts.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const STABLE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const CORE_SOURCE_ID = "source:aih-core";
const CORE_PACKAGE = "@aihq/core";
const CORE_OWNER = "samartomar";
const CORE_REPOSITORY = "ai-harness";
const CORE_SOURCE_REPOSITORY = `${CORE_OWNER}/${CORE_REPOSITORY}`;

type Material =
  | Readonly<{
      kind: "source-files";
      treeDigest: string;
      files: readonly Readonly<{ path: string; digest: string }>[];
    }>
  | Readonly<{
      kind: "configuration-only";
      declarationDigest: string;
      sourceInputDigest: string;
    }>;

export interface AihFirstPartyQualificationCandidateV1 {
  readonly asset: Readonly<{
    assetId: string;
    sourceId: string;
    sourceRevisionId: string;
    contentDigest: string;
  }>;
  readonly sourceContentDigest: string;
  readonly compiler: Readonly<{ id: string; version: string; inputFormat: "built-in/v1" }>;
  readonly subject: unknown;
  readonly material: Material;
  /** Raw canonical profile bytes; this exact SHA-256 is the AIH source revision. */
  readonly profile: Readonly<{ bytes: Uint8Array; sha256: string }>;
}

export interface AihFirstPartyQualificationPreparationV1 {
  readonly candidates: readonly AihFirstPartyQualificationCandidateV1[];
  /** Explicitly retained Scanner coverage that cannot have a governance subject yet. */
  readonly unsupported: readonly Readonly<{
    assetId: string;
    reason: "unsupported-governance-subject-kind";
  }>[];
}

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalStrictJsonBytesV1(left).equals(canonicalStrictJsonBytesV1(right));
}

function validFiles(value: readonly Readonly<{ path: string; digest: string }>[]): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_024 &&
    value.every(
      (file, index) =>
        typeof file.path === "string" &&
        SAFE_PATH.test(file.path) &&
        !file.path.startsWith("/") &&
        !file.path.includes("\\") &&
        DIGEST.test(file.digest) &&
        (index === 0 || (value[index - 1]?.path ?? "") < file.path),
    )
  );
}

function stablePackId(asset: {
  id: string;
  kind: string;
  originalPath: string;
}): string | undefined {
  const match = /^packs\/([a-z][a-z0-9-]{0,63})\/[A-Za-z0-9._/-]+$/.exec(asset.originalPath);
  return (asset.kind === "skill" || asset.kind === "agent") && match !== null
    ? match[1]
    : undefined;
}

function stableMcpId(asset: {
  kind: string;
  label: string;
  originalPath: string;
}): string | undefined {
  return asset.kind === "mcp" &&
    /^(?:core-control|core-request)\/[a-z][a-z0-9-]{0,63}$/.test(asset.originalPath) &&
    STABLE_ID.test(asset.label)
    ? asset.label
    : undefined;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Derives first-party candidates from a same-process Scanner witness. It never
 * accepts detached scanner output, a Git provider coverage record, or caller
 * supplied profile bytes.
 */
export function prepareAihFirstPartyQualificationCandidatesV1(
  bundle: AuthoringCatalogBundleV1,
  prepared: PreparedAihScannerPublicationsV1,
): AihFirstPartyQualificationPreparationV1 | undefined {
  const output = authorPreparedAihScannerPublicationV1(prepared);
  if (output === undefined) return undefined;
  const source = bundle.sources[CORE_SOURCE_ID];
  const release = /^package:@aihq\/core@(.+)$/.exec(source?.revision.id ?? "")?.[1];
  if (
    source === undefined ||
    release === undefined ||
    !ExactSemverV2Schema.safeParse(release).success ||
    source.distributor.kind !== "aih" ||
    source.distributor.locator !== CORE_PACKAGE ||
    source.upstreamOrigin.kind !== "aih" ||
    source.upstreamOrigin.locator !== CORE_PACKAGE ||
    source.inputFormat !== "built-in/v1" ||
    source.compiler.id !== "built-in" ||
    source.compiler.version !== "1" ||
    output.catalog.id !== "aih" ||
    output.catalog.owner !== CORE_OWNER ||
    output.catalog.repository !== CORE_REPOSITORY ||
    output.catalog.sourceTreeSha256.length !== 64 ||
    !SHA256.test(output.catalog.sourceTreeSha256) ||
    output.catalog.coverageDigest !== `sha256:${canonicalStrictJsonSha256V1(output.coverage)}` ||
    !same(output.catalog.source, {
      id: source.id,
      revisionId: source.revision.id,
      contentDigest: source.revision.contentDigest,
      inputFormat: source.inputFormat,
      upstreamOrigin: source.upstreamOrigin,
    }) ||
    output.coverage.source.id !== source.id ||
    output.coverage.source.revisionId !== source.revision.id ||
    output.coverage.source.contentDigest !== source.revision.contentDigest ||
    output.coverage.repository !== CORE_SOURCE_REPOSITORY ||
    output.coverage.pinnedCommit !== output.catalog.pinnedCommit ||
    output.coverage.sourceTreeSha256 !== output.catalog.sourceTreeSha256
  )
    return undefined;

  const components = new Map(
    output.coverage.components.map((component) => [component.componentId, component]),
  );
  const observations = new Map(
    output.observations.map((observation) => [observation.componentId, observation]),
  );
  const assets = Object.values(bundle.assets).filter((asset) => asset.sourceId === source.id);
  if (
    assets.length === 0 ||
    components.size !== output.coverage.components.length ||
    observations.size !== output.observations.length ||
    components.size !== assets.length ||
    observations.size !== components.size ||
    output.coverage.unmappedDerivedAssets.length !== 0
  )
    return undefined;

  const candidates: AihFirstPartyQualificationCandidateV1[] = [];
  const unsupported: { assetId: string; reason: "unsupported-governance-subject-kind" }[] = [];
  for (const asset of assets) {
    const componentId = `asset:${createHash("sha256").update(asset.id).digest("hex")}`;
    const component = components.get(componentId);
    const observation = observations.get(componentId);
    if (
      component === undefined ||
      observation === undefined ||
      asset.derivation !== "built-in" ||
      component.componentTreeSha256.length !== 64 ||
      !SHA256.test(component.componentTreeSha256) ||
      !validFiles(component.files) ||
      component.paths.length === 0 ||
      component.paths.length > 1_024 ||
      component.paths.some(
        (item) => !SAFE_PATH.test(item) || item.startsWith("/") || item.includes("\\"),
      ) ||
      component.subject.assetId !== asset.id ||
      component.subject.sourceId !== source.id ||
      component.subject.sourceRevisionId !== source.revision.id ||
      component.subject.contentDigest !== asset.contentDigest ||
      asset.sourceRevisionId !== component.subject.sourceRevisionId ||
      asset.contentDigest !== component.subject.contentDigest ||
      observation.componentTreeSha256 !== component.componentTreeSha256 ||
      !SHA256.test(observation.requestSha256) ||
      !SHA256.test(observation.publicationSha256) ||
      !SHA256.test(observation.receiptSha256) ||
      !Number.isFinite(Date.parse(observation.reportSignedAt)) ||
      !Number.isFinite(Date.parse(observation.reportVerificationExpiresAt))
    )
      return undefined;

    const packId = stablePackId(asset);
    const mcpId = stableMcpId(asset);
    const packPaths =
      packId === undefined ? undefined : ["aih-packs.json", asset.originalPath].sort();
    const mcpPath = mcpId === undefined ? undefined : `declarations/claude/project/${mcpId}.json`;
    const hook = asset.kind === "hook" && asset.id === "aih/usage-metering";
    if (
      (packPaths !== undefined &&
        (!sameStrings(component.paths, packPaths) ||
          !component.files.some((file) => file.path === "aih-packs.json") ||
          component.files.some(
            (file) =>
              file.path !== "aih-packs.json" && !file.path.startsWith(`${asset.originalPath}/`),
          ))) ||
      (mcpPath !== undefined &&
        (!sameStrings(component.paths, [mcpPath]) ||
          component.files.length !== 1 ||
          component.files[0]?.path !== mcpPath)) ||
      (hook &&
        (!sameStrings(component.paths, ["generated/usage-metering/usage-record.mjs"]) ||
          component.files.length !== 1 ||
          component.files[0]?.path !== "generated/usage-metering/usage-record.mjs")) ||
      (packId === undefined && mcpId === undefined && !hook)
    )
      return undefined;
    if (packId === undefined && mcpId === undefined) {
      unsupported.push({ assetId: asset.id, reason: "unsupported-governance-subject-kind" });
      continue;
    }
    const kind = asset.kind as "skill" | "agent" | "mcp";
    const id = packId ?? mcpId!;
    const material: Material =
      packId === undefined
        ? {
            kind: "configuration-only",
            declarationDigest: asset.contentDigest,
            sourceInputDigest: source.revision.contentDigest,
          }
        : {
            kind: "source-files",
            treeDigest: `sha256:${component.componentTreeSha256}`,
            files: component.files.map((file) => ({ path: file.path, digest: file.digest })),
          };
    const scope =
      material.kind === "source-files"
        ? {
            kind: "source-files" as const,
            description:
              "Exact first-party pack files and the declared AIH pack manifest; no execution or organization admission.",
          }
        : {
            kind: "configuration-only" as const,
            description:
              "Exact built-in declaration and compiler input; no server code, execution, or organization admission.",
          };
    const profile = {
      format: "aih-first-party-qualification-profile",
      version: 1,
      asset: {
        assetId: asset.id,
        sourceId: source.id,
        sourceRevisionId: source.revision.id,
        contentDigest: asset.contentDigest,
      },
      compiler: {
        id: source.compiler.id,
        version: source.compiler.version,
        inputFormat: source.inputFormat,
      },
      subject: { kind, id },
      scope,
      material,
      scanner: {
        catalog: {
          owner: output.catalog.owner,
          repository: output.catalog.repository,
          pinnedCommit: output.catalog.pinnedCommit,
          sourceTreeSha256: output.catalog.sourceTreeSha256,
          coverageDigest: output.catalog.coverageDigest,
        },
        component: {
          componentId,
          componentTreeSha256: component.componentTreeSha256,
          paths: [...component.paths],
        },
        observation: { ...observation },
      },
    };
    const bytes = canonicalStrictJsonBytesV1(profile);
    const governanceSource = { type: "aih" as const, release, revision: sha256(bytes) };
    const sourceDigest = governanceDecisionSourceDigestV2(governanceSource);
    const subject = {
      kind,
      id,
      source: governanceSource,
      sourceDigest,
      subjectDigest: governanceDecisionSubjectDigestV2({ kind, id, sourceDigest }),
    };
    candidates.push({
      asset: profile.asset,
      sourceContentDigest: source.revision.contentDigest,
      compiler: {
        id: source.compiler.id,
        version: source.compiler.version,
        inputFormat: "built-in/v1",
      },
      subject,
      material,
      profile: { bytes, sha256: governanceSource.revision },
    });
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((left, right) => left.asset.assetId.localeCompare(right.asset.assetId));
  unsupported.sort((left, right) => left.assetId.localeCompare(right.assetId));
  return Object.freeze({
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze(candidate))),
    unsupported: Object.freeze(unsupported.map((item) => Object.freeze(item))),
  });
}
