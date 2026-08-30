import { z } from "zod";
import {
  canonicalStrictJsonSha256V1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import type { Check } from "../internals/verify.js";
import {
  ArtifactIntakeDirectorySourceV2Schema,
  type ArtifactIntakeItemV1,
  type ArtifactIntakeItemV2,
  ArtifactIntakeSourceV1Schema,
  type ArtifactIntakeV1,
  type ArtifactIntakeV2,
  artifactEvidenceRecordIdV1,
  artifactIntakeDigestV1,
  artifactIntakeDigestV2,
  artifactIntakeItemSourceDigestV1,
  artifactIntakeItemSourceDigestV2,
  effectiveArtifactIntakeItemsV1,
  effectiveArtifactIntakeItemsV2,
} from "./artifact-intake.js";
import { type DirectoryResolutionV1, DirectoryResolutionV1Schema } from "./directory-resolution.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const evidenceState = z.enum(["verified", "failed", "missing"]);
const itemKind = z.enum(["mcp", "skill", "agent"]);
const evidenceId = z.string().regex(/^scan-[a-z0-9][a-z0-9._-]{0,127}-[a-f0-9]{12}$/);
const detectorId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const finding = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);

function validSha512Sri(value: string): boolean {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (match?.[1] === undefined) return false;
  const decoded = Buffer.from(match[1], "base64");
  return decoded.length === 64 && decoded.toString("base64") === match[1];
}

export const ArtifactObservedSourceV1Schema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("npm"),
      tarballSha256: digest,
      registryIntegrity: z.string().refine(validSha512Sri).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("github"),
      commit: z.string().regex(/^[a-f0-9]{40}$/),
    })
    .strict(),
]);

const detector = z
  .object({
    id: detectorId,
    required: z.boolean(),
    status: z.enum(["pass", "fail", "missing"]),
  })
  .strict();

const evidenceRecordShape = z
  .object({
    id: evidenceId,
    itemId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    candidate: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    kind: itemKind,
    accountableOwner: z.string().email().max(320),
    source: ArtifactIntakeSourceV1Schema,
    sourceDigest: digest,
    scanDigest: digest,
    evidenceDigest: digest,
    state: evidenceState,
    waivable: z.literal(false),
    authority: z.object({ state: z.literal("not-authority") }).strict(),
    detectors: z.array(detector).max(64),
    findings: z.array(finding).max(128),
    observed: ArtifactObservedSourceV1Schema,
  })
  .strict();

type EvidenceRecordShape = z.infer<typeof evidenceRecordShape>;

function withoutEvidenceDigest(
  record: EvidenceRecordShape,
): Omit<EvidenceRecordShape, "evidenceDigest"> {
  const { evidenceDigest: _evidenceDigest, ...unsigned } = record;
  return unsigned;
}

export function artifactEvidenceDigestV1(
  record: Omit<EvidenceRecordShape, "evidenceDigest">,
): string {
  return `sha256:${canonicalStrictJsonSha256V1({
    domain: "aih-preflight-evidence/v1",
    record,
  })}`;
}

export const ArtifactEvidenceRecordV1Schema = evidenceRecordShape.superRefine((value, context) => {
  const expectedSourceDigest = `sha256:${canonicalStrictJsonSha256V1(value.source)}`;
  if (value.sourceDigest !== expectedSourceDigest) {
    context.addIssue({ code: "custom", path: ["sourceDigest"], message: "source digest mismatch" });
  }
  const expectedId = artifactEvidenceRecordIdV1(value.itemId, value.sourceDigest);
  if (value.id !== expectedId) {
    context.addIssue({ code: "custom", path: ["id"], message: "evidence identifier mismatch" });
  }
  if (value.candidate !== value.itemId) {
    context.addIssue({ code: "custom", path: ["candidate"], message: "candidate mismatch" });
  }
  if (value.source.type !== value.observed.type) {
    context.addIssue({ code: "custom", path: ["observed"], message: "observed source mismatch" });
  }
  if (
    value.source.type === "github" &&
    value.observed.type === "github" &&
    value.observed.commit !== value.source.commit
  ) {
    context.addIssue({
      code: "custom",
      path: ["observed", "commit"],
      message: "observed commit mismatch",
    });
  }
  if (
    value.source.type === "npm" &&
    value.source.integrity !== undefined &&
    value.observed.type === "npm" &&
    value.observed.registryIntegrity !== value.source.integrity
  ) {
    context.addIssue({
      code: "custom",
      path: ["observed", "registryIntegrity"],
      message: "observed registry integrity mismatch",
    });
  }
  if (artifactEvidenceDigestV1(withoutEvidenceDigest(value)) !== value.evidenceDigest) {
    context.addIssue({
      code: "custom",
      path: ["evidenceDigest"],
      message: "evidence digest mismatch",
    });
  }
});

export type ArtifactEvidenceRecordV1 = z.infer<typeof ArtifactEvidenceRecordV1Schema>;
export type ArtifactObservedSourceV1 = z.infer<typeof ArtifactObservedSourceV1Schema>;

export interface ArtifactEvidenceRecordInputV1 {
  intake: ArtifactIntakeV1;
  item: ArtifactIntakeItemV1;
  state: z.infer<typeof evidenceState>;
  observed: ArtifactObservedSourceV1;
  analyzersRun: readonly string[];
  checks: readonly Check[];
  findings: readonly string[];
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedDetectorId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
  return normalized.length > 0 ? normalized : "aih-native";
}

function canonicalEvidenceChecksV1(checks: readonly Check[]): object[] {
  return checks.map((check) => ({
    name: check.name,
    verdict: check.verdict,
    ...(check.detail === undefined ? {} : { detail: check.detail }),
    ...(check.code === undefined ? {} : { code: check.code }),
    ...(check.location === undefined
      ? {}
      : {
          location: {
            uri: check.location.uri,
            ...(check.location.startLine === undefined
              ? {}
              : { startLine: check.location.startLine }),
          },
        }),
    ...(check.fingerprint === undefined ? {} : { fingerprint: check.fingerprint }),
  }));
}

export function artifactEvidenceRecordV1(
  input: ArtifactEvidenceRecordInputV1,
): ArtifactEvidenceRecordV1 {
  const effective = effectiveArtifactIntakeItemsV1(input.intake).find(
    (candidate) => candidate.id === input.item.id,
  );
  if (effective === undefined) throw new TypeError(`intake item is absent: ${input.item.id}`);
  const sourceDigest = artifactIntakeItemSourceDigestV1(effective);
  const detectors = [...new Set(input.analyzersRun.map(normalizedDetectorId))]
    .sort(ordinalCompare)
    .map((id) => ({ id, required: false, status: "pass" as const }));
  const findings = [...new Set(input.findings)].sort(ordinalCompare);
  const unsigned = {
    id: artifactEvidenceRecordIdV1(effective.id, sourceDigest),
    itemId: effective.id,
    candidate: effective.id,
    kind: effective.kind,
    accountableOwner: effective.accountableOwner,
    source: effective.source,
    sourceDigest,
    scanDigest: `sha256:${canonicalStrictJsonSha256V1(canonicalEvidenceChecksV1(input.checks))}`,
    state: input.state,
    waivable: false as const,
    authority: { state: "not-authority" as const },
    detectors,
    findings,
    observed: input.observed,
  };
  return ArtifactEvidenceRecordV1Schema.parse({
    ...unsigned,
    evidenceDigest: artifactEvidenceDigestV1(unsigned),
  });
}

const result = z
  .object({
    itemId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    kind: itemKind,
    state: evidenceState,
    evidenceId: evidenceId.optional(),
    sourceDigest: digest.optional(),
    problem: z.string().min(1).max(500).optional(),
  })
  .strict();

const evidenceBundleShape = z
  .object({
    format: z.literal("aih-preflight-evidence-bundle"),
    version: z.literal(1),
    intakeDigest: digest,
    results: z.array(result).min(1).max(100),
    evidence: z.array(ArtifactEvidenceRecordV1Schema).max(100),
    bundleDigest: digest,
  })
  .strict();

type EvidenceBundleShape = z.infer<typeof evidenceBundleShape>;

function withoutBundleDigest(
  bundle: EvidenceBundleShape,
): Omit<EvidenceBundleShape, "bundleDigest"> {
  const { bundleDigest: _bundleDigest, ...unsigned } = bundle;
  return unsigned;
}

export function artifactEvidenceBundleDigestV1(
  bundle: Omit<EvidenceBundleShape, "bundleDigest">,
): string {
  return `sha256:${canonicalStrictJsonSha256V1({
    domain: "aih-preflight-evidence-bundle/v1",
    bundle,
  })}`;
}

export const ArtifactEvidenceBundleV1Schema = evidenceBundleShape.superRefine((value, context) => {
  if (artifactEvidenceBundleDigestV1(withoutBundleDigest(value)) !== value.bundleDigest) {
    context.addIssue({ code: "custom", path: ["bundleDigest"], message: "bundle digest mismatch" });
  }
  if (new Set(value.results.map((entry) => entry.itemId)).size !== value.results.length) {
    context.addIssue({ code: "custom", path: ["results"], message: "duplicate result item" });
  }
  if (new Set(value.evidence.map((entry) => entry.id)).size !== value.evidence.length) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "duplicate evidence record" });
  }
  const resultByItem = new Map(value.results.map((entry) => [entry.itemId, entry]));
  const evidenceByItem = new Map<string, ArtifactEvidenceRecordV1[]>();
  for (const record of value.evidence) {
    const records = evidenceByItem.get(record.itemId) ?? [];
    records.push(record);
    evidenceByItem.set(record.itemId, records);
  }
  for (const [index, record] of value.evidence.entries()) {
    const matching = resultByItem.get(record.itemId);
    if (matching === undefined) {
      context.addIssue({
        code: "custom",
        path: ["evidence", index],
        message: "orphaned evidence record",
      });
      continue;
    }
    if (
      matching.kind !== record.kind ||
      matching.state !== record.state ||
      matching.evidenceId !== record.id ||
      matching.sourceDigest !== record.sourceDigest ||
      matching.problem !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence", index],
        message: "result does not match evidence record",
      });
    }
  }
  for (const [index, entry] of value.results.entries()) {
    const records = evidenceByItem.get(entry.itemId) ?? [];
    if (records.length === 0) {
      if (
        entry.state !== "missing" ||
        entry.problem === undefined ||
        entry.evidenceId !== undefined ||
        entry.sourceDigest !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["results", index],
          message: "missing result must describe the problem without evidence claims",
        });
      }
    } else if (records.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["results", index],
        message: "result must identify exactly one evidence record",
      });
    }
  }
});

export type ArtifactEvidenceBundleV1 = z.infer<typeof ArtifactEvidenceBundleV1Schema>;

export function createArtifactEvidenceBundleV1(
  intake: ArtifactIntakeV1,
  records: readonly ArtifactEvidenceRecordV1[],
  problems: Readonly<Record<string, string>> = {},
): ArtifactEvidenceBundleV1 {
  const byItem = new Map(records.map((record) => [record.itemId, record]));
  const evidence = [...records].sort((left, right) => ordinalCompare(left.id, right.id));
  const unsigned = {
    format: "aih-preflight-evidence-bundle" as const,
    version: 1 as const,
    intakeDigest: artifactIntakeDigestV1(intake),
    results: effectiveArtifactIntakeItemsV1(intake).map((item) => {
      const record = byItem.get(item.id);
      if (record === undefined) {
        return {
          itemId: item.id,
          kind: item.kind,
          state: "missing" as const,
          problem: problems[item.id] ?? "not scanned",
        };
      }
      return {
        itemId: item.id,
        kind: item.kind,
        state: record.state,
        evidenceId: record.id,
        sourceDigest: record.sourceDigest,
      };
    }),
    evidence,
  };
  return ArtifactEvidenceBundleV1Schema.parse({
    ...unsigned,
    bundleDigest: artifactEvidenceBundleDigestV1(unsigned),
  });
}

export function parseArtifactEvidenceBundleV1Text(text: string): ArtifactEvidenceBundleV1 {
  return ArtifactEvidenceBundleV1Schema.parse(
    parseStrictJsonObjectV1(text, "artifact evidence bundle"),
  );
}

const resolutionId = z.string().regex(/^resolve-[a-z0-9][a-z0-9._-]{0,127}-[a-f0-9]{12}$/);

const directoryResolutionRecordShape = z
  .object({
    id: resolutionId,
    itemId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    kind: z.literal("mcp"),
    accountableOwner: z.string().email().max(320),
    source: ArtifactIntakeDirectorySourceV2Schema,
    sourceDigest: digest,
    authority: z.object({ state: z.literal("not-authority") }).strict(),
    resolution: DirectoryResolutionV1Schema,
    resolutionDigest: digest,
  })
  .strict();

type DirectoryResolutionRecordShapeV2 = z.infer<typeof directoryResolutionRecordShape>;

function withoutResolutionDigest(
  record: DirectoryResolutionRecordShapeV2,
): Omit<DirectoryResolutionRecordShapeV2, "resolutionDigest"> {
  const { resolutionDigest: _resolutionDigest, ...unsigned } = record;
  return unsigned;
}

export function artifactDirectoryResolutionDigestV2(
  record: Omit<DirectoryResolutionRecordShapeV2, "resolutionDigest">,
): string {
  return `sha256:${canonicalStrictJsonSha256V1({
    domain: "aih-directory-resolution/v2",
    record,
  })}`;
}

export const ArtifactDirectoryResolutionRecordV2Schema = directoryResolutionRecordShape.superRefine(
  (value, context) => {
    const expectedSourceDigest = `sha256:${canonicalStrictJsonSha256V1(value.source)}`;
    if (value.sourceDigest !== expectedSourceDigest) {
      context.addIssue({
        code: "custom",
        path: ["sourceDigest"],
        message: "directory source digest mismatch",
      });
    }
    const expectedId = `resolve-${value.itemId}-${expectedSourceDigest.slice(-64, -52)}`;
    if (value.id !== expectedId) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "directory resolution identifier mismatch",
      });
    }
    if (
      value.resolution.claim.provider !== value.source.provider ||
      value.resolution.claim.discoveryUrl !== value.source.url
    ) {
      context.addIssue({
        code: "custom",
        path: ["resolution", "claim"],
        message: "directory resolution claim does not match its source",
      });
    }
    if (
      artifactDirectoryResolutionDigestV2(withoutResolutionDigest(value)) !== value.resolutionDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["resolutionDigest"],
        message: "directory resolution digest mismatch",
      });
    }
  },
);

export type ArtifactDirectoryResolutionRecordV2 = z.infer<
  typeof ArtifactDirectoryResolutionRecordV2Schema
>;

export interface ArtifactDirectoryResolutionRecordInputV2 {
  intake: ArtifactIntakeV2;
  item: ArtifactIntakeItemV2;
  resolution: DirectoryResolutionV1;
}

export function artifactDirectoryResolutionRecordV2(
  input: ArtifactDirectoryResolutionRecordInputV2,
): ArtifactDirectoryResolutionRecordV2 {
  const effective = effectiveArtifactIntakeItemsV2(input.intake).find(
    (candidate) => candidate.id === input.item.id,
  );
  if (effective === undefined) throw new TypeError(`intake item is absent: ${input.item.id}`);
  if (effective.kind !== "mcp" || effective.source.type !== "directory") {
    throw new TypeError(`intake item is not a directory MCP candidate: ${input.item.id}`);
  }
  const sourceDigest = artifactIntakeItemSourceDigestV2(effective);
  const unsigned = {
    id: `resolve-${effective.id}-${sourceDigest.slice(-64, -52)}`,
    itemId: effective.id,
    kind: effective.kind,
    accountableOwner: effective.accountableOwner,
    source: effective.source,
    sourceDigest,
    authority: { state: "not-authority" as const },
    resolution: DirectoryResolutionV1Schema.parse(input.resolution),
  };
  return ArtifactDirectoryResolutionRecordV2Schema.parse({
    ...unsigned,
    resolutionDigest: artifactDirectoryResolutionDigestV2(unsigned),
  });
}

const resultV2 = result.extend({
  resolutionId: resolutionId.optional(),
  resolutionDigest: digest.optional(),
});

const evidenceBundleShapeV2 = z
  .object({
    format: z.literal("aih-preflight-evidence-bundle"),
    version: z.literal(2),
    intakeDigest: digest,
    results: z.array(resultV2).min(1).max(100),
    evidence: z.array(ArtifactEvidenceRecordV1Schema).max(100),
    resolutions: z.array(ArtifactDirectoryResolutionRecordV2Schema).max(100),
    bundleDigest: digest,
  })
  .strict();

type EvidenceBundleShapeV2 = z.infer<typeof evidenceBundleShapeV2>;

function withoutBundleDigestV2(
  bundle: EvidenceBundleShapeV2,
): Omit<EvidenceBundleShapeV2, "bundleDigest"> {
  const { bundleDigest: _bundleDigest, ...unsigned } = bundle;
  return unsigned;
}

export function artifactEvidenceBundleDigestV2(
  bundle: Omit<EvidenceBundleShapeV2, "bundleDigest">,
): string {
  return `sha256:${canonicalStrictJsonSha256V1({
    domain: "aih-preflight-evidence-bundle/v2",
    bundle,
  })}`;
}

export const ArtifactEvidenceBundleV2Schema = evidenceBundleShapeV2.superRefine(
  (value, context) => {
    if (artifactEvidenceBundleDigestV2(withoutBundleDigestV2(value)) !== value.bundleDigest) {
      context.addIssue({
        code: "custom",
        path: ["bundleDigest"],
        message: "bundle digest mismatch",
      });
    }
    if (new Set(value.results.map((entry) => entry.itemId)).size !== value.results.length) {
      context.addIssue({ code: "custom", path: ["results"], message: "duplicate result item" });
    }
    if (new Set(value.evidence.map((entry) => entry.id)).size !== value.evidence.length) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "duplicate evidence record",
      });
    }
    if (new Set(value.resolutions.map((entry) => entry.id)).size !== value.resolutions.length) {
      context.addIssue({
        code: "custom",
        path: ["resolutions"],
        message: "duplicate directory resolution record",
      });
    }
    const resultByItem = new Map(value.results.map((entry) => [entry.itemId, entry]));
    const evidenceByItem = new Map(value.evidence.map((entry) => [entry.itemId, entry]));
    const resolutionByItem = new Map(value.resolutions.map((entry) => [entry.itemId, entry]));
    if (evidenceByItem.size !== value.evidence.length) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "multiple evidence records for one item",
      });
    }
    if (resolutionByItem.size !== value.resolutions.length) {
      context.addIssue({
        code: "custom",
        path: ["resolutions"],
        message: "multiple directory resolutions for one item",
      });
    }
    for (const [index, record] of value.evidence.entries()) {
      const matching = resultByItem.get(record.itemId);
      if (
        matching === undefined ||
        matching.kind !== record.kind ||
        matching.state !== record.state ||
        matching.evidenceId !== record.id ||
        matching.sourceDigest !== record.sourceDigest ||
        matching.problem !== undefined ||
        matching.resolutionId !== undefined ||
        matching.resolutionDigest !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["evidence", index],
          message: "result does not match evidence record",
        });
      }
    }
    for (const [index, record] of value.resolutions.entries()) {
      const matching = resultByItem.get(record.itemId);
      if (
        matching === undefined ||
        matching.kind !== "mcp" ||
        matching.state !== "missing" ||
        matching.problem === undefined ||
        matching.evidenceId !== undefined ||
        matching.sourceDigest !== undefined ||
        matching.resolutionId !== record.id ||
        matching.resolutionDigest !== record.resolutionDigest
      ) {
        context.addIssue({
          code: "custom",
          path: ["resolutions", index],
          message: "result does not match directory resolution record",
        });
      }
    }
    for (const [index, entry] of value.results.entries()) {
      const evidenceRecord = evidenceByItem.get(entry.itemId);
      const resolutionRecord = resolutionByItem.get(entry.itemId);
      if (evidenceRecord !== undefined && resolutionRecord !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["results", index],
          message: "result cannot claim scan evidence and directory resolution",
        });
      } else if (evidenceRecord === undefined && resolutionRecord === undefined) {
        if (
          entry.state !== "missing" ||
          entry.problem === undefined ||
          entry.evidenceId !== undefined ||
          entry.sourceDigest !== undefined ||
          entry.resolutionId !== undefined ||
          entry.resolutionDigest !== undefined
        ) {
          context.addIssue({
            code: "custom",
            path: ["results", index],
            message: "missing result must describe the problem without evidence claims",
          });
        }
      }
    }
  },
);

export type ArtifactEvidenceBundleV2 = z.infer<typeof ArtifactEvidenceBundleV2Schema>;

export function createArtifactEvidenceBundleV2(
  intake: ArtifactIntakeV2,
  records: readonly ArtifactEvidenceRecordV1[],
  resolutions: readonly ArtifactDirectoryResolutionRecordV2[],
  problems: Readonly<Record<string, string>> = {},
): ArtifactEvidenceBundleV2 {
  const items = effectiveArtifactIntakeItemsV2(intake);
  const byItem = new Map(records.map((record) => [record.itemId, record]));
  const resolutionByItem = new Map(resolutions.map((record) => [record.itemId, record]));
  for (const record of records) {
    const item = items.find((candidate) => candidate.id === record.itemId);
    if (
      item === undefined ||
      item.source.type === "directory" ||
      item.kind !== record.kind ||
      item.accountableOwner !== record.accountableOwner ||
      artifactIntakeItemSourceDigestV2(item) !== record.sourceDigest
    ) {
      throw new TypeError(`scan evidence does not match version 2 intake item: ${record.itemId}`);
    }
  }
  for (const record of resolutions) {
    const item = items.find((candidate) => candidate.id === record.itemId);
    if (
      item === undefined ||
      item.source.type !== "directory" ||
      item.kind !== "mcp" ||
      item.accountableOwner !== record.accountableOwner ||
      artifactIntakeItemSourceDigestV2(item) !== record.sourceDigest
    ) {
      throw new TypeError(`directory resolution does not match intake item: ${record.itemId}`);
    }
  }
  const evidence = [...records].sort((left, right) => ordinalCompare(left.id, right.id));
  const orderedResolutions = [...resolutions].sort((left, right) =>
    ordinalCompare(left.id, right.id),
  );
  const unsigned = {
    format: "aih-preflight-evidence-bundle" as const,
    version: 2 as const,
    intakeDigest: artifactIntakeDigestV2(intake),
    results: items.map((item) => {
      const record = byItem.get(item.id);
      if (record !== undefined) {
        return {
          itemId: item.id,
          kind: item.kind,
          state: record.state,
          evidenceId: record.id,
          sourceDigest: record.sourceDigest,
        };
      }
      const resolution = resolutionByItem.get(item.id);
      if (resolution !== undefined) {
        return {
          itemId: item.id,
          kind: item.kind,
          state: "missing" as const,
          problem: problems[item.id] ?? "exact source selection and scan required",
          resolutionId: resolution.id,
          resolutionDigest: resolution.resolutionDigest,
        };
      }
      return {
        itemId: item.id,
        kind: item.kind,
        state: "missing" as const,
        problem: problems[item.id] ?? "not scanned",
      };
    }),
    evidence,
    resolutions: orderedResolutions,
  };
  return ArtifactEvidenceBundleV2Schema.parse({
    ...unsigned,
    bundleDigest: artifactEvidenceBundleDigestV2(unsigned),
  });
}

export function parseArtifactEvidenceBundleV2Text(text: string): ArtifactEvidenceBundleV2 {
  return ArtifactEvidenceBundleV2Schema.parse(
    parseStrictJsonObjectV1(text, "artifact evidence bundle"),
  );
}

export type ArtifactEvidenceReconciliationStateV1 =
  | "verified"
  | "failed"
  | "missing"
  | "stale"
  | "mismatched"
  | "replayed";

export interface ArtifactEvidenceReconciliationV1 {
  itemId: string;
  kind: "mcp" | "skill" | "agent";
  state: ArtifactEvidenceReconciliationStateV1;
  authorized: false;
  evidenceId?: string;
}

export function reconcileArtifactEvidenceV1(
  intake: ArtifactIntakeV1,
  bundles: readonly ArtifactEvidenceBundleV1[],
): ArtifactEvidenceReconciliationV1[] {
  const records = bundles.flatMap((bundle) => bundle.evidence);
  return effectiveArtifactIntakeItemsV1(intake).map((item) => {
    const itemRecords = records.filter((record) => record.itemId === item.id);
    const sourceDigest = artifactIntakeItemSourceDigestV1(item);
    const current = itemRecords.filter((record) => record.sourceDigest === sourceDigest);
    if (itemRecords.length === 0) {
      return { itemId: item.id, kind: item.kind, state: "missing", authorized: false };
    }
    if (current.length === 0) {
      return { itemId: item.id, kind: item.kind, state: "stale", authorized: false };
    }
    if (
      current.some(
        (record) =>
          record.kind !== item.kind ||
          record.accountableOwner !== item.accountableOwner ||
          canonicalStrictJsonSha256V1(record.source) !== canonicalStrictJsonSha256V1(item.source),
      )
    ) {
      return { itemId: item.id, kind: item.kind, state: "mismatched", authorized: false };
    }
    const byId = new Map<string, Set<string>>();
    for (const record of current) {
      const digests = byId.get(record.id) ?? new Set<string>();
      digests.add(record.evidenceDigest);
      byId.set(record.id, digests);
    }
    if ([...byId.values()].some((digests) => digests.size > 1)) {
      return {
        itemId: item.id,
        kind: item.kind,
        state: "replayed",
        authorized: false,
        evidenceId: current.at(-1)?.id,
      };
    }
    const latest = current.at(-1);
    if (latest === undefined) throw new Error("expected current evidence record");
    return {
      itemId: item.id,
      kind: item.kind,
      state: latest.state,
      authorized: false,
      evidenceId: latest.id,
    };
  });
}
