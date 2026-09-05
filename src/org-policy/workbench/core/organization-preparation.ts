import { createHash } from "node:crypto";
import { canonicalStrictJsonSha256V1 } from "../../../contract/strict-json-v1.js";
import {
  type ArtifactIntakeItemV1,
  artifactIntakeItemSourceDigestV1,
} from "../../../trust/artifact-intake.js";
import {
  type OperationalExactArtifactScanV1,
  operationalExactArtifactScanPayloadV1,
} from "../../../trust/scan.js";
import {
  type CatalogCompilerAssemblyInputV1,
  compileOrganizationManifestAssemblyInputV1,
} from "../catalog-bundle.js";
import { compileOrganizationManifestV1 } from "../compilers/organization-manifest.js";
import type {
  AuthoringCatalogBundleV1,
  WorkbenchAuthoringSourceV1,
  WorkbenchSourceInputsV1,
} from "../contracts.js";

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function exactSourcePath(item: ArtifactIntakeItemV1): string | undefined {
  return item.source.path;
}

function sourceInputsForOrganizationManifestV1(
  manifestBytes: string,
  sources: CatalogCompilerAssemblyInputV1["sources"],
): WorkbenchSourceInputsV1 {
  const byteLength = Buffer.byteLength(manifestBytes, "utf8");
  const bytesBase64 = Buffer.from(manifestBytes, "utf8").toString("base64");
  const inputs: Record<string, WorkbenchAuthoringSourceV1> = {};
  for (const source of Object.values(sources)) {
    if (!source.policyInputRequired) continue;
    inputs[source.id] = {
      kind: "organization-manifest",
      sourceId: source.id,
      sourceRevisionId: source.revision.id,
      inputFormat: "organization-authoring-manifest/v1",
      digest: source.revision.contentDigest,
      byteLength,
      bytesBase64,
    };
  }
  return inputs;
}
const freshOrganizationPreparations = new WeakMap<
  object,
  Readonly<{ assembly: CatalogCompilerAssemblyInputV1; sourceInputs: WorkbenchSourceInputsV1 }>
>();

/** Opaque same-process prepared result; structural lookalikes have no assembly authority. */
export interface FreshOrganizationPreparationV1 {
  readonly kind: "fresh-organization-preparation/v1";
}

/**
 * Converts only an opaque same-process operational scan witness into generic
 * compiler evidence. The manifest's scanSubject is an explicit, exact join;
 * asset labels and IDs are never used to guess a scanned source.
 */
export function prepareOrganizationManifestWithFreshScanV1(
  manifestBytes: string,
  witness: OperationalExactArtifactScanV1,
  now: string,
): FreshOrganizationPreparationV1 {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== now)
    throw new TypeError("fresh organization preparation time must be canonical ISO-8601");
  const payload = operationalExactArtifactScanPayloadV1(witness);
  if (payload === undefined) throw new TypeError("fresh organization scan custody is unavailable");
  const compiled = compileOrganizationManifestV1(manifestBytes);
  const assets = new Map(
    compiled.declarations.map((entry) => [entry.declaration.id, entry.declaration]),
  );
  if (Object.keys(compiled.scanSubjects).length !== assets.size) {
    throw new TypeError("every organization manifest asset needs an explicit scanSubject");
  }

  const intakeById = new Map(payload.intake.items.map((item) => [item.id, item]));
  const mappedIntakeIds = new Set<string>();
  const evidence: AuthoringCatalogBundleV1["evidence"] = {};
  const preparationContextDigest = freshOrganizationPreparationContextDigestV1(
    manifestBytes,
    witness,
  );
  for (const [assetId, subject] of Object.entries(compiled.scanSubjects)) {
    const asset = assets.get(assetId);
    const intake = intakeById.get(subject.intakeItemId);
    if (asset === undefined || intake === undefined) {
      throw new TypeError(
        `organization manifest scanSubject is missing an exact intake item: ${assetId}`,
      );
    }
    if (mappedIntakeIds.has(intake.id)) {
      throw new TypeError(`organization manifest scanSubject duplicates intake item ${intake.id}`);
    }
    mappedIntakeIds.add(intake.id);
    if (intake.source.type === "npm" && intake.source.integrity === undefined) {
      throw new TypeError(
        `fresh organization npm intake requires exact registry integrity: ${intake.id}`,
      );
    }
    if (
      intake.kind !== subject.kind ||
      exactSourcePath(intake) !== subject.path ||
      artifactIntakeItemSourceDigestV1(intake) !== subject.sourceDigest
    ) {
      throw new TypeError(
        `organization manifest scanSubject does not match exact intake pin ${intake.id}`,
      );
    }
    const record = payload.records.get(intake.id);
    const treeDigest = payload.treeDigests.get(intake.id);
    const scanProblem = payload.problems[intake.id];
    const matchingRecord =
      record !== undefined &&
      record.kind === subject.kind &&
      record.source.path === subject.path &&
      record.sourceDigest === subject.sourceDigest &&
      record.sourceDigest === artifactIntakeItemSourceDigestV1(intake) &&
      treeDigest !== undefined &&
      scanProblem === undefined &&
      (intake.source.type !== "npm" ||
        (record.observed.type === "npm" &&
          record.observed.registryIntegrity === intake.source.integrity))
        ? record
        : undefined;
    const detectorComplete =
      matchingRecord?.state !== "missing" &&
      matchingRecord?.detectors.some((entry) => entry.required) === true &&
      matchingRecord.detectors.every((entry) => !entry.required || entry.status === "pass");
    const observedAt =
      matchingRecord === undefined ? Number.NaN : Date.parse(matchingRecord.scan.observedAt);
    const validUntil =
      matchingRecord === undefined ? Number.NaN : Date.parse(matchingRecord.scan.validUntil);
    const current =
      detectorComplete &&
      Number.isFinite(observedAt) &&
      Number.isFinite(validUntil) &&
      observedAt <= timestamp &&
      timestamp < validUntil;
    const expired = detectorComplete && Number.isFinite(validUntil) && timestamp >= validUntil;
    const passed = detectorComplete && matchingRecord?.state === "verified";
    const failed = detectorComplete && matchingRecord?.state === "failed";
    const coverage = detectorComplete ? "complete" : "none";
    const missingDetectors = (matchingRecord?.detectors ?? [])
      .filter((entry) => entry.required && entry.status !== "pass")
      .map((entry) => entry.id)
      .sort();
    const verification =
      current && matchingRecord !== undefined
        ? {
            state: "verified" as const,
            verifiedAt: matchingRecord.scan.observedAt,
            validUntil: matchingRecord.scan.validUntil,
            contextDigest: preparationContextDigest,
          }
        : { state: expired ? ("stale" as const) : ("missing" as const) };
    evidence[`evidence:${assetId}`] = {
      id: `evidence:${assetId}`,
      projectionVersion: "evidence-summary/v1",
      subjects: [
        {
          assetId,
          sourceId: asset.sourceId,
          sourceRevisionId: asset.sourceRevisionId,
          contentDigest: asset.contentDigest,
        },
      ],
      evidenceDigest:
        matchingRecord === undefined || treeDigest === undefined
          ? sha256(`organization-fresh-scan-missing/v1:${assetId}:${subject.sourceDigest}`)
          : `sha256:${canonicalStrictJsonSha256V1({
              domain: "aih-fresh-organization-evidence/v1",
              recordEvidenceDigest: matchingRecord.evidenceDigest,
              treeDigest,
            })}`,
      coveredPaths: [subject.path],
      verification,
      scan: passed
        ? { outcome: "pass", coverage }
        : failed
          ? { outcome: "failed", coverage }
          : { outcome: "unknown", coverage: "none" },
      qualification: { state: "unknown" },
      findings: [
        ...(matchingRecord?.findings ?? []),
        ...missingDetectors.map((id) => `required detector is unavailable: ${id}`),
        ...(matchingRecord === undefined ? ["fresh scan evidence is missing"] : []),
        ...(matchingRecord?.state === "missing" ? ["fresh scan coverage is incomplete"] : []),
        ...(scanProblem === undefined ? [] : [`fresh scan failed: ${scanProblem}`]),
      ]
        .sort()
        .slice(0, 50),
    };
  }
  if (mappedIntakeIds.size !== intakeById.size) {
    throw new TypeError("fresh organization intake has an unmapped item");
  }

  const assembly = compileOrganizationManifestAssemblyInputV1(manifestBytes);
  const preparation: FreshOrganizationPreparationV1 = Object.freeze({
    kind: "fresh-organization-preparation/v1",
  });
  const preparedAssembly = Object.freeze({ ...assembly, evidence });
  freshOrganizationPreparations.set(
    preparation,
    Object.freeze({
      assembly: preparedAssembly,
      sourceInputs: sourceInputsForOrganizationManifestV1(manifestBytes, preparedAssembly.sources),
    }),
  );
  return preparation;
}

/** Internal catalog bridge. It rejects fabricated or cloned prepared values. */
export function consumeFreshOrganizationPreparationV1(
  preparation: unknown,
): CatalogCompilerAssemblyInputV1 | undefined {
  if (typeof preparation !== "object" || preparation === null) return undefined;
  const prepared = freshOrganizationPreparations.get(preparation);
  return prepared === undefined ? undefined : structuredClone(prepared.assembly);
}

/** Exact manifest inputs emitted only from an opaque witnessed preparation. */
export function freshOrganizationPreparationSourceInputsV1(
  preparation: unknown,
): WorkbenchSourceInputsV1 | undefined {
  if (typeof preparation !== "object" || preparation === null) return undefined;
  const prepared = freshOrganizationPreparations.get(preparation);
  return prepared === undefined ? undefined : structuredClone(prepared.sourceInputs);
}
/** Stable custody context binds the exact manifest and intake bytes for callers that audit preparation. */
export function freshOrganizationPreparationContextDigestV1(
  manifestBytes: string,
  witness: OperationalExactArtifactScanV1,
): string {
  const payload = operationalExactArtifactScanPayloadV1(witness);
  if (payload === undefined) throw new TypeError("fresh organization scan custody is unavailable");
  const entries = <T>(values: ReadonlyMap<string, T>) =>
    [...values.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `sha256:${canonicalStrictJsonSha256V1({
    domain: "aih-fresh-organization-preparation/v1",
    manifestDigest: sha256(manifestBytes),
    intakeDigest: sha256(payload.intakeBytes),
    records: entries(payload.records),
    treeDigests: entries(payload.treeDigests),
    problems: Object.entries(payload.problems).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  })}`;
}
