import { z } from "zod";
import {
  canonicalStrictJsonSha256V1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import {
  type ArtifactIntakeItemV1,
  ArtifactIntakeSourceV1Schema,
  type ArtifactIntakeV1,
  artifactEvidenceRecordIdV1,
  artifactIntakeDigestV1,
  artifactIntakeItemSourceDigestV1,
  effectiveArtifactIntakeItemsV1,
} from "./artifact-intake.js";

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
    targets: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/))
      .min(1)
      .max(32),
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
  checks: unknown;
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
    targets: [...effective.targets],
    source: effective.source,
    sourceDigest,
    scanDigest: `sha256:${canonicalStrictJsonSha256V1(input.checks)}`,
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
