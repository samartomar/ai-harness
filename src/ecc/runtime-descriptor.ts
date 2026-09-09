import { createHash } from "node:crypto";
import { z } from "zod";
import { BaselineSourceEvidenceSchema } from "../baseline-evidence/schema.js";
import {
  assertSafeRelativePosixPathV1,
  canonicalStrictJsonBytesV1,
  deepFreezeStrictJsonV1,
} from "../contract/strict-json-v1.js";
import { evidenceExpiryV1 } from "../evidence-freshness.js";
import { ECC_RUNTIME_DECLARED_EVALUATION_CONTRACT_V1 } from "./runtime-descriptor-evaluation.js";

const MAX_RUNTIME_DESCRIPTOR_BYTES_V1 = 12 * 1024 * 1024;
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const rawSha256 = z.string().regex(/^[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const componentId = z.string().regex(/^[a-z0-9][a-z0-9:._-]*$/);
const sourceId = z.string().regex(/^source:[a-z0-9][a-z0-9._-]*$/);
const safePath = z
  .string()
  .min(1)
  .max(4_000)
  .superRefine((value, ctx) => {
    try {
      assertSafeRelativePosixPathV1(value, "runtime descriptor path");
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
    }
  });

const RuntimeComponentSchema = z
  .object({
    id: componentId,
    kind: z.string().regex(/^[a-z][a-z0-9-]*$/),
    primaryPath: safePath,
    paths: z.array(safePath).min(1).max(10_000),
    files: z
      .array(z.object({ path: safePath, digest: sha256 }).strict())
      .min(1)
      .max(20_000),
    treeSha256: rawSha256,
    identityTreeSha256: rawSha256,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.paths).size !== value.paths.length)
      ctx.addIssue({ code: "custom", path: ["paths"], message: "duplicate component path" });
    if (![...value.paths].sort().every((path, index) => path === value.paths[index]))
      ctx.addIssue({ code: "custom", path: ["paths"], message: "component paths must be sorted" });
    if (!value.paths.includes(value.primaryPath))
      ctx.addIssue({
        code: "custom",
        path: ["primaryPath"],
        message: "primary path must be covered",
      });
    if (
      new Set(value.files.map((file) => file.path)).size !== value.files.length ||
      ![...value.files]
        .map((file) => file.path)
        .sort()
        .every((path, index) => path === value.files[index]?.path) ||
      value.files.some(
        (file) =>
          !value.paths.some((path) => file.path === path || file.path.startsWith(`${path}/`)),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["files"],
        message: "invalid component file projection",
      });
  });

const RuntimeRelationSchema = z
  .object({
    from: componentId,
    to: componentId,
    kind: z.enum(["requires", "member"]),
    membership: z.enum(["required", "optional"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "member" && value.membership === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["membership"],
        message: "member relation requires membership",
      });
    if (value.kind !== "member" && value.membership !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["membership"],
        message: "only member relation has membership",
      });
  });

const RuntimeRiderRelationSchema = z.object({ from: componentId, to: componentId }).strict();

const RuntimeRevisionRelationSchema = z
  .object({
    componentId,
    sourceId,
    sourceRevisionId: gitSha,
    contentDigest: sha256,
  })
  .strict();

/**
 * Immutable provenance for the original Scanner custody check. These dates
 * establish when the archived attestation was valid; they are deliberately
 * separate from the report-freshness deadline derived from `reportSignedAt`.
 */
const RuntimeCustodyPublicationSchema = z
  .object({
    publicationSha256: rawSha256,
    requestSha256: rawSha256,
    receiptSha256: rawSha256,
    reportSignedAt: z.string().datetime(),
    reportVerificationExpiresAt: z.string().datetime(),
    attestedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const signedAt = Date.parse(value.reportSignedAt);
    const attestedAt = Date.parse(value.attestedAt);
    const expiresAt = Date.parse(value.reportVerificationExpiresAt);
    if (
      !Number.isFinite(signedAt) ||
      !Number.isFinite(attestedAt) ||
      !Number.isFinite(expiresAt) ||
      signedAt > attestedAt ||
      attestedAt >= expiresAt
    )
      ctx.addIssue({ code: "custom", message: "invalid original Scanner custody window" });
  });

export const EccRuntimeAdapterCompatibilityV1Schema = z
  .object({
    contractVersion: z.literal("ecc-governed-materialization-targets/v1"),
    contractDigest: sha256,
    targets: z
      .array(z.enum(["claude", "codex", "kimi", "cursor", "opencode", "kiro"]))
      .min(1)
      .max(6),
    outcomes: z
      .array(
        z.union([
          z
            .object({
              componentId,
              path: safePath,
              target: z.enum(["claude", "codex", "kimi", "cursor", "opencode", "kiro"]),
              state: z.literal("mapped"),
              scope: z.enum(["project", "home"]),
              relative: safePath,
            })
            .strict(),
          z
            .object({
              componentId,
              path: safePath,
              target: z.enum(["claude", "codex", "kimi", "cursor", "opencode", "kiro"]),
              state: z.literal("refused"),
              reason: z.string().min(1).max(1_000),
            })
            .strict(),
        ]),
      )
      .max(200_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.targets).size !== value.targets.length)
      ctx.addIssue({ code: "custom", path: ["targets"], message: "duplicate adapter target" });
    if (![...value.targets].sort().every((target, index) => target === value.targets[index]))
      ctx.addIssue({
        code: "custom",
        path: ["targets"],
        message: "adapter targets must be sorted",
      });
    const outcomes = new Set<string>();
    for (const [index, outcome] of value.outcomes.entries()) {
      const key = `${outcome.componentId}\0${outcome.path}\0${outcome.target}`;
      if (outcomes.has(key))
        ctx.addIssue({
          code: "custom",
          path: ["outcomes", index],
          message: "duplicate adapter outcome",
        });
      outcomes.add(key);
    }
    const outcomeKeys = value.outcomes.map(
      (outcome) => `${outcome.componentId}\0${outcome.path}\0${outcome.target}`,
    );
    if (![...outcomeKeys].sort().every((key, index) => key === outcomeKeys[index]))
      ctx.addIssue({
        code: "custom",
        path: ["outcomes"],
        message: "adapter outcomes must be sorted",
      });
  });

export const EccRuntimeDescriptorV1Schema = z
  .object({
    version: z.literal("ecc-runtime-descriptor/v1"),
    source: z.object({ repository, commit: gitSha, treeSha256: rawSha256 }).strict(),
    compilerInputDigest: sha256,
    evidence: z
      .object({
        rawReport: BaselineSourceEvidenceSchema,
        rawReportDigest: sha256,
        custodyPublications: z.array(RuntimeCustodyPublicationSchema).min(1).max(1_000),
        validUntil: z.string().datetime(),
        coreDerivedEvaluationDigest: sha256,
        projectionContractDigest: sha256,
        mappings: z
          .array(
            z
              .object({
                componentId,
                rawComponentIds: z.array(componentId).min(1).max(4_096),
              })
              .strict(),
          )
          .min(1)
          .max(4_096),
      })
      .strict(),
    components: z.array(RuntimeComponentSchema).min(1).max(4_096),
    revisionRelations: z.array(RuntimeRevisionRelationSchema).min(1).max(4_096),
    relations: z.array(RuntimeRelationSchema).max(100_000),
    /** Runtime-only fidelity: the baseline compiler's generic requires edge intentionally loses rider provenance. */
    riderRelations: z.array(RuntimeRiderRelationSchema).max(100_000),
    adapterCompatibility: EccRuntimeAdapterCompatibilityV1Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const [index, component] of value.components.entries()) {
      if (ids.has(component.id))
        ctx.addIssue({
          code: "custom",
          path: ["components", index, "id"],
          message: "duplicate component",
        });
      ids.add(component.id);
    }
    if (
      ![...value.components]
        .map((item) => item.id)
        .sort()
        .every((id, index) => id === value.components[index]?.id)
    )
      ctx.addIssue({ code: "custom", path: ["components"], message: "components must be sorted" });
    const revisions = new Set<string>();
    for (const [index, relation] of value.revisionRelations.entries()) {
      if (!ids.has(relation.componentId))
        ctx.addIssue({
          code: "custom",
          path: ["revisionRelations", index],
          message: "unknown revision component",
        });
      if (revisions.has(relation.componentId))
        ctx.addIssue({
          code: "custom",
          path: ["revisionRelations", index],
          message: "duplicate revision component",
        });
      revisions.add(relation.componentId);
    }
    if (revisions.size !== ids.size)
      ctx.addIssue({
        code: "custom",
        path: ["revisionRelations"],
        message: "missing revision component",
      });
    if (
      ![...value.revisionRelations]
        .map((relation) => relation.componentId)
        .sort()
        .every((id, index) => id === value.revisionRelations[index]?.componentId)
    )
      ctx.addIssue({
        code: "custom",
        path: ["revisionRelations"],
        message: "revision relations must be sorted",
      });
    const mappings = new Set<string>();
    for (const [index, mapping] of value.evidence.mappings.entries()) {
      if (!ids.has(mapping.componentId) || mappings.has(mapping.componentId))
        ctx.addIssue({
          code: "custom",
          path: ["evidence", "mappings", index],
          message: "invalid descriptor evidence mapping",
        });
      mappings.add(mapping.componentId);
      if (
        new Set(mapping.rawComponentIds).size !== mapping.rawComponentIds.length ||
        ![...mapping.rawComponentIds]
          .sort()
          .every((id, rawIndex) => id === mapping.rawComponentIds[rawIndex]) ||
        mapping.rawComponentIds.some(
          (id) => !value.evidence.rawReport.components.some((component) => component.id === id),
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["evidence", "mappings", index],
          message: "invalid raw report component mapping",
        });
    }
    if (mappings.size !== ids.size)
      ctx.addIssue({
        code: "custom",
        path: ["evidence", "mappings"],
        message: "missing descriptor evidence mapping",
      });
    if (
      ![...value.evidence.mappings]
        .map((mapping) => mapping.componentId)
        .sort()
        .every((id, index) => id === value.evidence.mappings[index]?.componentId)
    )
      ctx.addIssue({
        code: "custom",
        path: ["evidence", "mappings"],
        message: "evidence mappings must be sorted",
      });
    if (
      value.evidence.rawReport.id !== "ecc" ||
      `${value.evidence.rawReport.owner}/${value.evidence.rawReport.repo}` !==
        value.source.repository ||
      value.evidence.rawReport.pinnedSha !== value.source.commit ||
      value.evidence.rawReport.sourceTreeSha256 !== value.source.treeSha256
    )
      ctx.addIssue({
        code: "custom",
        path: ["evidence", "rawReport"],
        message: "raw report does not bind descriptor source",
      });
    const custodyKeys = value.evidence.custodyPublications.map(
      (publication) =>
        `${publication.requestSha256}\0${publication.receiptSha256}\0${publication.publicationSha256}`,
    );
    if (
      custodyKeys.some((key, index) => custodyKeys.indexOf(key) !== index) ||
      ![...custodyKeys].sort().every((key, index) => key === custodyKeys[index])
    )
      ctx.addIssue({
        code: "custom",
        path: ["evidence", "custodyPublications"],
        message: "custody publications must be unique and sorted",
      });
    try {
      const signedAt = new Date(
        Math.min(
          ...value.evidence.custodyPublications.map((publication) =>
            Date.parse(publication.reportSignedAt),
          ),
        ),
      ).toISOString();
      if (Date.parse(value.evidence.validUntil) !== Date.parse(evidenceExpiryV1(signedAt)))
        ctx.addIssue({
          code: "custom",
          path: ["evidence", "validUntil"],
          message: "runtime descriptor freshness must derive from the earliest report signing date",
        });
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["evidence", "validUntil"],
        message: "invalid runtime descriptor freshness",
      });
    }
    if (
      value.evidence.projectionContractDigest !==
      `sha256:${createHash("sha256")
        .update(canonicalStrictJsonBytesV1(ECC_RUNTIME_DECLARED_EVALUATION_CONTRACT_V1))
        .digest("hex")}`
    )
      ctx.addIssue({
        code: "custom",
        path: ["evidence", "projectionContractDigest"],
        message: "unknown runtime declared evaluation contract",
      });
    for (const [index, relation] of value.relations.entries()) {
      if (!ids.has(relation.from) || !ids.has(relation.to))
        ctx.addIssue({
          code: "custom",
          path: ["relations", index],
          message: "unknown relation component",
        });
    }
    const relationKeys = value.relations.map(
      (relation) =>
        `${relation.from}\0${relation.to}\0${relation.kind}\0${relation.membership ?? ""}`,
    );
    if (
      relationKeys.some((key, index) => relationKeys.indexOf(key) !== index) ||
      ![...relationKeys].sort().every((key, index) => key === relationKeys[index])
    )
      ctx.addIssue({
        code: "custom",
        path: ["relations"],
        message: "relations must be unique and sorted",
      });
    const riderKeys = value.riderRelations.map((relation) => `${relation.from}\0${relation.to}`);
    if (
      riderKeys.some((key, index) => riderKeys.indexOf(key) !== index) ||
      ![...riderKeys].sort().every((key, index) => key === riderKeys[index]) ||
      value.riderRelations.some((relation) => !ids.has(relation.from) || !ids.has(relation.to))
    )
      ctx.addIssue({
        code: "custom",
        path: ["riderRelations"],
        message: "invalid rider relations",
      });
  });

export type EccRuntimeDescriptorV1 = z.infer<typeof EccRuntimeDescriptorV1Schema>;

export type EccRuntimeDescriptorSealV1 = Readonly<{ bytesBase64: string; sha256: string }>;

export interface PreparedEccRuntimeDescriptorV1 {
  readonly __opaquePreparedEccRuntimeDescriptorV1?: never;
}

const packageFacts = new WeakMap<object, readonly EccRuntimeDescriptorV1[]>();

export { currentEccRuntimeAdapterCompatibilityV1 } from "./runtime-adapter-compatibility.js";

function fail(): never {
  throw new TypeError(
    "ECC runtime descriptor is unavailable or inconsistent with authenticated source evidence",
  );
}

/**
 * A sealed historical descriptor can be replayed after its original custody
 * window has elapsed, but never when the underlying signed or attested facts
 * are in the future relative to the operational verifier.
 */
export function assertEccRuntimeDescriptorCustodyV1(
  descriptor: EccRuntimeDescriptorV1,
  now: string,
): void {
  const nowEpoch = Date.parse(now);
  if (!Number.isFinite(nowEpoch)) fail();
  for (const publication of descriptor.evidence.custodyPublications) {
    const signedAt = Date.parse(publication.reportSignedAt);
    const attestedAt = Date.parse(publication.attestedAt);
    const expiresAt = Date.parse(publication.reportVerificationExpiresAt);
    if (
      !Number.isFinite(signedAt) ||
      !Number.isFinite(attestedAt) ||
      !Number.isFinite(expiresAt) ||
      signedAt > attestedAt ||
      attestedAt >= expiresAt ||
      signedAt > nowEpoch ||
      attestedAt > nowEpoch
    )
      fail();
  }
}

/** Structural inspection only. Custody comes from the package or protected local receipt caller. */
export function inspectEccRuntimeDescriptorSealV1(
  seal: EccRuntimeDescriptorSealV1,
): EccRuntimeDescriptorV1 {
  const raw = Buffer.from(seal.bytesBase64, "base64");
  if (
    raw.length === 0 ||
    raw.length > MAX_RUNTIME_DESCRIPTOR_BYTES_V1 ||
    raw.toString("base64") !== seal.bytesBase64 ||
    seal.sha256 !== `sha256:${createHash("sha256").update(raw).digest("hex")}`
  )
    fail();
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    fail();
  }
  if (canonicalStrictJsonBytesV1(value).compare(raw) !== 0) fail();
  const descriptor = EccRuntimeDescriptorV1Schema.parse(value);
  if (
    descriptor.evidence.rawReportDigest !==
    `sha256:${createHash("sha256").update(canonicalStrictJsonBytesV1(descriptor.evidence.rawReport)).digest("hex")}`
  )
    fail();
  return deepFreezeStrictJsonV1(descriptor) as EccRuntimeDescriptorV1;
}

/** Package literals can register descriptors for later historical-runtime resolution; callers get copies. */
export function registerPackagedEccRuntimeDescriptorsV1(
  owner: object,
  seals: readonly EccRuntimeDescriptorSealV1[],
): void {
  if (packageFacts.has(owner)) fail();
  const descriptors = seals.map(inspectEccRuntimeDescriptorSealV1);
  const identities = new Set<string>();
  for (const descriptor of descriptors) {
    const identity = `${descriptor.source.repository}@${descriptor.source.commit}`;
    if (identities.has(identity)) fail();
    identities.add(identity);
  }
  packageFacts.set(owner, Object.freeze(descriptors));
}

export function packagedEccRuntimeDescriptorsV1(owner: object): readonly EccRuntimeDescriptorV1[] {
  const descriptors = packageFacts.get(owner);
  if (descriptors === undefined) return [];
  return structuredClone(descriptors);
}
