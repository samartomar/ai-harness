import { z } from "zod";

export const WORKBENCH_MINIMUM_CORE_VERSION = "0.6.0" as const;
export const WORKBENCH_MAX_POLICY_BYTES = 1_000_000;
const MAX_STATE_BYTES = 900_000;
const MAX_AGGREGATE_PINS = 5_000;
const MAX_DRAFT_BASE64_CHARACTERS = 800_000;
const MAX_DRAFT_DECODED_BYTES = 600_000;

/** Cheap aggregate checks run before nested schema parsing on imported state. */
export function workbenchStateBudgetIssueV1(value: unknown): string | undefined {
  const issue = "Workbench state exceeds its aggregate budget or contains malformed collections";
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return issue;
    const state = value as Record<string, unknown>;
    const roots = state.roots,
      requests = state.requests,
      exclusions = state.exclusions,
      drafts = state.drafts;
    if (
      !Array.isArray(roots) ||
      !Array.isArray(requests) ||
      !Array.isArray(exclusions) ||
      !Array.isArray(drafts)
    )
      return issue;
    let pins = roots.length + requests.length + exclusions.length;
    if (pins > MAX_AGGREGATE_PINS || drafts.length > 1_000) return issue;
    for (const root of roots) {
      if (!root || typeof root !== "object" || !Array.isArray(root.resolvedItems)) return issue;
      pins += root.resolvedItems.length;
      if (pins > MAX_AGGREGATE_PINS) return issue;
    }
    let encoded = 0,
      decoded = 0;
    for (const draft of drafts) {
      const declaration = draft && typeof draft === "object" ? draft.declaration : undefined;
      if (
        !declaration ||
        typeof declaration !== "object" ||
        typeof declaration.bytesBase64 !== "string" ||
        !Number.isSafeInteger(declaration.byteLength) ||
        declaration.byteLength < 1
      )
        return issue;
      encoded += declaration.bytesBase64.length;
      decoded += declaration.byteLength;
      if (encoded > MAX_DRAFT_BASE64_CHARACTERS || decoded > MAX_DRAFT_DECODED_BYTES) return issue;
    }
    const bytes = JSON.stringify(value);
    if (typeof bytes !== "string" || new TextEncoder().encode(bytes).byteLength > MAX_STATE_BYTES)
      return issue;
    return undefined;
  } catch {
    return issue;
  }
}

/** Matches the Workbench's pretty JSON export, including its trailing newline. */
export function workbenchPolicyFitsByteLimitV1(value: unknown): boolean {
  try {
    const bytes = JSON.stringify(value, null, 2);
    return (
      typeof bytes === "string" &&
      new TextEncoder().encode(bytes + "\n").byteLength <= WORKBENCH_MAX_POLICY_BYTES
    );
  } catch {
    return false;
  }
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const DigestSchema = z.string().regex(SHA256);
const noHiddenCharacters = (value: string) =>
  value === value.normalize("NFC") && !/\p{C}/u.test(value);
const CatalogIdSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(noHiddenCharacters, "must be NFC text without hidden characters");
const BoundedTextSchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine(noHiddenCharacters, "must be NFC text without hidden characters");
const SafeRelativePathSchema = BoundedTextSchema.refine(
  (value) =>
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes("\\") &&
    !/[\\%?#:]/.test(value) &&
    !value.endsWith("/") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
  "must be a safe relative POSIX path",
);
const SourceLocatorSchema = BoundedTextSchema;

export const SourceRevisionV1Schema = z
  .object({
    id: CatalogIdSchema,
    contentDigest: DigestSchema,
  })
  .strict();

export const SourceDescriptorV1Schema = z
  .object({
    id: CatalogIdSchema,
    distributor: z
      .object({
        kind: z.enum(["git", "package", "organization", "built-in", "aih"]),
        locator: SourceLocatorSchema,
      })
      .strict(),
    upstreamOrigin: z
      .object({
        kind: z.enum(["git", "package", "organization", "built-in", "aih"]),
        locator: SourceLocatorSchema,
      })
      .strict(),
    inputFormat: BoundedTextSchema,
    policyInputRequired: z.literal(true).optional(),
    revision: SourceRevisionV1Schema,
    compiler: z
      .object({
        id: CatalogIdSchema,
        version: z.string().min(1).max(80),
      })
      .strict(),
  })
  .strict();

/** Compiler output has no action or projector authority. Core assembles those fields. */
export const CompilerAssetDeclarationV1Schema = z
  .object({
    id: CatalogIdSchema,
    sourceId: CatalogIdSchema,
    sourceRevisionId: CatalogIdSchema,
    contentDigest: DigestSchema,
    originalPath: SafeRelativePathSchema,
    derivation: z.enum([
      "upstream",
      "modified-copy",
      "organization-declaration",
      "built-in",
      "core-derived",
    ]),
    kind: z
      .string()
      .min(1)
      .max(80)
      .refine(noHiddenCharacters, "must be NFC text without hidden characters"),
    label: z
      .string()
      .min(1)
      .max(500)
      .refine(noHiddenCharacters, "must be NFC text without hidden characters"),
    detailChunkId: CatalogIdSchema,
    declaredHostCapabilities: z.array(z.string().min(1).max(160)).max(50),
    exclusiveSlot: z.enum(["methodology"]).optional(),
    methodologyKey: CatalogIdSchema.optional(),
  })
  .strict()
  .superRefine((asset, ctx) => {
    if (asset.exclusiveSlot === "methodology" && asset.methodologyKey === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["methodologyKey"],
        message: "Methodology assets require a methodology key.",
      });
    }
    if (asset.exclusiveSlot === undefined && asset.methodologyKey !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["methodologyKey"],
        message: "Only methodology assets may carry a methodology key.",
      });
    }
  });

const ProjectorIdSchema = z.enum(["mcp-managed-settings", "usage-hook"]);
const AuthoringActionSchema = z.enum([
  "select-control",
  "record-selection",
  "record-request",
  "prepare-approval",
  "inspect-evidence",
]);

export const AuthoringAssetV1Schema = CompilerAssetDeclarationV1Schema.extend({
  authoring: z
    .object({
      action: AuthoringActionSchema,
      projectorId: ProjectorIdSchema.optional(),
      supportedTargets: z.array(z.enum(["claude", "codex", "kiro"])).max(3),
    })
    .strict(),
}).superRefine((asset, ctx) => {
  const control = asset.authoring.action === "select-control";
  if (control && asset.authoring.projectorId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["authoring", "projectorId"],
      message: "Selectable controls require a Core-owned projector id.",
    });
  }
  if (control && asset.authoring.supportedTargets.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["authoring", "supportedTargets"],
      message: "Selectable controls require at least one supported target.",
    });
  }
  if (!control && asset.authoring.projectorId !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["authoring", "projectorId"],
      message: "Only selectable controls may carry a projector id.",
    });
  }
  if (!control && asset.authoring.supportedTargets.length !== 0)
    ctx.addIssue({
      code: "custom",
      path: ["authoring", "supportedTargets"],
      message: "Only selectable controls may carry supported targets.",
    });
  if (new Set(asset.authoring.supportedTargets).size !== asset.authoring.supportedTargets.length)
    ctx.addIssue({
      code: "custom",
      path: ["authoring", "supportedTargets"],
      message: "Supported targets must be unique.",
    });
  if (
    asset.authoring.supportedTargets.some(
      (target, index, values) => index > 0 && target < values[index - 1]!,
    )
  )
    ctx.addIssue({
      code: "custom",
      path: ["authoring", "supportedTargets"],
      message: "Supported targets must use canonical order.",
    });
});

export interface CoreAuthoringCapabilityRegistryEntryV1 {
  assetId: string;
  sourceId: string;
  sourceRevisionId: string;
  contentDigest: string;
  action:
    | "select-control"
    | "record-selection"
    | "record-request"
    | "prepare-approval"
    | "inspect-evidence";
  projectorId?: "mcp-managed-settings" | "usage-hook";
  supportedTargets: readonly ("claude" | "codex" | "kiro")[];
}

/** Core-only assembly joins declarations with this closed registry before bundling. */
export function assembleAuthoringAssetV1(
  declaration: z.infer<typeof CompilerAssetDeclarationV1Schema>,
  registry: readonly CoreAuthoringCapabilityRegistryEntryV1[],
): z.infer<typeof AuthoringAssetV1Schema> {
  const matches = registry.filter(
    (entry) =>
      entry.assetId === declaration.id &&
      entry.sourceId === declaration.sourceId &&
      entry.sourceRevisionId === declaration.sourceRevisionId &&
      entry.contentDigest === declaration.contentDigest,
  );
  if (matches.length > 1) throw new Error("ambiguous Core authoring capability");
  const match = matches[0];
  const authoring =
    match === undefined
      ? { action: "record-request" as const, supportedTargets: [] }
      : {
          action: match.action,
          ...(match.projectorId === undefined ? {} : { projectorId: match.projectorId }),
          supportedTargets: [...match.supportedTargets],
        };
  return AuthoringAssetV1Schema.parse({ ...declaration, authoring });
}

export const CatalogRelationV1Schema = z
  .object({
    fromAssetId: CatalogIdSchema,
    toAssetId: CatalogIdSchema,
    kind: z.enum(["requires", "member", "conflicts"]),
    membership: z.enum(["required", "optional"]).optional(),
  })
  .strict()
  .superRefine((relation, ctx) => {
    if (relation.kind === "member" && relation.membership === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["membership"],
        message: "Member relations must state whether membership is required or optional.",
      });
    }
    if (relation.kind !== "member" && relation.membership !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["membership"],
        message: "Only member relations may state membership semantics.",
      });
    }
  });

export const SelectionTemplateRootV1Schema = z
  .object({
    assetId: CatalogIdSchema,
    mode: z.enum(["select", "structural"]),
    includeOptionalMembers: z.boolean(),
  })
  .strict()
  .superRefine((root, ctx) => {
    if (root.mode === "structural" && root.includeOptionalMembers) {
      ctx.addIssue({
        code: "custom",
        path: ["includeOptionalMembers"],
        message: "Structural roots cannot expand optional members.",
      });
    }
  });

export const SelectionTemplateV1Schema = z
  .object({
    id: CatalogIdSchema,
    digest: DigestSchema,
    roots: z.array(SelectionTemplateRootV1Schema).min(1).max(1_000),
    exclusions: z.array(CatalogIdSchema).max(10_000),
  })
  .strict();

export const EvidenceSummaryV1Schema = z
  .object({
    id: CatalogIdSchema,
    projectionVersion: z.literal("evidence-summary/v1"),
    subjects: z
      .array(
        z
          .object({
            assetId: CatalogIdSchema,
            sourceId: CatalogIdSchema,
            sourceRevisionId: CatalogIdSchema,
            contentDigest: DigestSchema,
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
    evidenceDigest: DigestSchema,
    coveredPaths: z.array(SafeRelativePathSchema).min(1).max(10_000),
    verification: z
      .object({
        state: z.enum(["verified", "unverified", "missing", "stale"]),
        verifiedAt: z.string().datetime().optional(),
        contextDigest: DigestSchema.optional(),
        validUntil: z.string().datetime().optional(),
      })
      .strict(),
    scan: z
      .object({
        outcome: z.enum(["pass", "failed", "unknown"]),
        coverage: z.enum(["complete", "partial", "none"]),
      })
      .strict(),
    qualification: z.object({ state: z.enum(["qualified", "unqualified", "unknown"]) }).strict(),
    findings: z.array(z.string().min(1).max(1_000)).max(50),
  })
  .strict()
  .superRefine((value, ctx) => {
    const verified = value.verification.state === "verified";
    const custody =
      value.verification.verifiedAt !== undefined &&
      value.verification.contextDigest !== undefined &&
      value.verification.validUntil !== undefined;
    if (
      verified &&
      (!custody ||
        Date.parse(value.verification.validUntil!) <= Date.parse(value.verification.verifiedAt!))
    )
      ctx.addIssue({
        code: "custom",
        path: ["verification"],
        message: "Verified evidence requires ordered verification time, context, and validity.",
      });
    if (
      !verified &&
      (value.verification.verifiedAt !== undefined ||
        value.verification.contextDigest !== undefined ||
        value.verification.validUntil !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        path: ["verification"],
        message: "Only verified evidence may carry custody timestamps or context.",
      });
    if (value.scan.outcome === "pass" && value.scan.coverage !== "complete")
      ctx.addIssue({
        code: "custom",
        path: ["scan"],
        message: "A passing scan requires complete coverage.",
      });
  });

declare const corePreparedEvidence: unique symbol;
/** This brand is deliberately unavailable from parsed artifact JSON. */
export type CorePreparedEvidenceSummaryV1 = z.infer<typeof EvidenceSummaryV1Schema> & {
  readonly [corePreparedEvidence]: true;
};

export const WorkbenchOriginV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("administrator") }).strict(),
  z.object({ kind: z.literal("template"), id: CatalogIdSchema, digest: DigestSchema }).strict(),
  z.object({ kind: z.literal("legacy-unattributed") }).strict(),
]);
export type WorkbenchOriginV1 = z.infer<typeof WorkbenchOriginV1Schema>;
export function workbenchOriginKey(origin: WorkbenchOriginV1): string {
  if (origin.kind === "administrator") return "administrator";
  if (origin.kind === "legacy-unattributed") return "legacy-unattributed";
  return `template:${origin.id}\u0000${origin.digest}`;
}
export const WorkbenchRootV1Schema = SelectionTemplateRootV1Schema.extend({
  origin: WorkbenchOriginV1Schema,
  sourceId: CatalogIdSchema,
  sourceRevisionId: CatalogIdSchema,
  contentDigest: DigestSchema,
  resolvedItems: z
    .array(
      z
        .object({
          assetId: CatalogIdSchema,
          sourceId: CatalogIdSchema,
          sourceRevisionId: CatalogIdSchema,
          contentDigest: DigestSchema,
        })
        .strict(),
    )
    .min(1)
    .max(50_000),
}).superRefine((root, ctx) => {
  const own = root.resolvedItems.find((item) => item.assetId === root.assetId);
  if (
    own === undefined ||
    own.sourceId !== root.sourceId ||
    own.sourceRevisionId !== root.sourceRevisionId ||
    own.contentDigest !== root.contentDigest
  )
    ctx.addIssue({
      code: "custom",
      path: ["resolvedItems"],
      message: "Resolved pins must include the root's exact identity.",
    });
  const ids = root.resolvedItems.map((item) => item.assetId);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => index > 0 && id < ids[index - 1]!)
  )
    ctx.addIssue({
      code: "custom",
      path: ["resolvedItems"],
      message: "Resolved pins must be unique and canonically ordered.",
    });
});
export const WorkbenchRequestV1Schema = z
  .object({
    assetId: CatalogIdSchema,
    origin: WorkbenchOriginV1Schema,
    sourceId: CatalogIdSchema,
    sourceRevisionId: CatalogIdSchema,
    contentDigest: DigestSchema,
  })
  .strict();
export const WorkbenchDraftV1Schema = z
  .object({
    id: CatalogIdSchema,
    declaration: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("organization-manifest"),
          digest: DigestSchema,
          byteLength: z.number().int().min(1).max(1_000_000),
          bytesBase64: z
            .string()
            .min(4)
            .max(1_333_336)
            .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        })
        .strict(),
      z
        .object({
          kind: z.enum(["imported-policy", "imported-evidence"]),
          digest: DigestSchema,
          byteLength: z.number().int().min(1).max(1_000_000),
          bytesBase64: z
            .string()
            .min(4)
            .max(1_333_336)
            .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        })
        .strict(),
    ]),
  })
  .strict();
/** Exact declaration inputs transported with V3 policy; these confer no evidence or effect. */
export const WorkbenchAuthoringSourceV1Schema = z
  .object({
    kind: z.literal("organization-manifest"),
    sourceId: CatalogIdSchema,
    sourceRevisionId: CatalogIdSchema,
    inputFormat: z.literal("organization-authoring-manifest/v1"),
    digest: DigestSchema,
    byteLength: z.number().int().min(1).max(600_000),
    bytesBase64: z
      .string()
      .min(4)
      .max(800_000)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict();
export type WorkbenchAuthoringSourceV1 = z.infer<typeof WorkbenchAuthoringSourceV1Schema>;
export type WorkbenchSourceInputsV1 = Readonly<Record<string, WorkbenchAuthoringSourceV1>>;

export function workbenchAuthoringSourcesBudgetIssueV1(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const issue = "Authoring sources exceed their aggregate budget or contain malformed inputs";
  try {
    if (!Array.isArray(value) || value.length > 64) return issue;
    let encoded = 0,
      decoded = 0;
    for (const source of value) {
      if (
        !source ||
        typeof source !== "object" ||
        typeof source.bytesBase64 !== "string" ||
        !Number.isSafeInteger(source.byteLength) ||
        source.byteLength < 1
      )
        return issue;
      encoded += source.bytesBase64.length;
      decoded += source.byteLength;
      if (encoded > 800_000 || decoded > 600_000) return issue;
    }
    return undefined;
  } catch {
    return issue;
  }
}
export const WorkbenchAuthoringSourcesV1Schema = z
  .array(WorkbenchAuthoringSourceV1Schema)
  .min(1)
  .max(64)
  .superRefine((sources, ctx) => {
    const issue = workbenchAuthoringSourcesBudgetIssueV1(sources);
    if (issue) ctx.addIssue({ code: "custom", message: issue });
    const ids = sources.map((source) => source.sourceId);
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id, index) => index > 0 && id < ids[index - 1]!)
    )
      ctx.addIssue({
        code: "custom",
        message: "Authoring sources must be unique and canonically ordered",
      });
  });

export const WorkbenchExclusionV1Schema = z
  .object({
    assetId: CatalogIdSchema,
    origin: WorkbenchOriginV1Schema,
    sourceId: CatalogIdSchema,
    sourceRevisionId: CatalogIdSchema,
    contentDigest: DigestSchema,
  })
  .strict();
export const WorkbenchStateV1Schema = z
  .object({
    roots: z.array(WorkbenchRootV1Schema).max(10_000),
    exclusions: z.array(WorkbenchExclusionV1Schema).max(10_000),
    requests: z.array(WorkbenchRequestV1Schema).max(10_000),
    drafts: z.array(WorkbenchDraftV1Schema).max(1_000),
  })
  .strict()
  .superRefine((state, ctx) => {
    const budgetIssue = workbenchStateBudgetIssueV1(state);
    if (budgetIssue) {
      ctx.addIssue({ code: "custom", message: budgetIssue });
      return;
    }
    const ordered = (items: readonly { assetId: string; origin: WorkbenchOriginV1 }[]) =>
      items.map((item) => `${item.assetId}\u0000${workbenchOriginKey(item.origin)}`);
    for (const [path, keys] of [
      ["roots", ordered(state.roots)],
      ["requests", ordered(state.requests)],
    ] as const)
      if (
        new Set(keys).size !== keys.length ||
        keys.some((key, index) => index > 0 && key < keys[index - 1]!)
      )
        ctx.addIssue({
          code: "custom",
          path: [path],
          message: "Items must be unique and canonically ordered.",
        });
    for (const [path, values] of [
      ["exclusions", ordered(state.exclusions)],
      ["drafts", state.drafts.map((draft) => draft.id)],
    ] as const)
      if (
        new Set(values).size !== values.length ||
        values.some((value, index) => index > 0 && value < values[index - 1]!)
      )
        ctx.addIssue({
          code: "custom",
          path: [path],
          message: "Items must be unique and canonically ordered.",
        });
  });

export const WorkbenchSelectionExportV1Schema = WorkbenchStateV1Schema.safeExtend({
  selectionVersion: z.literal("workbench-selection/v1"),
  roots: z.array(WorkbenchRootV1Schema).max(10_000),
  exclusions: z.array(WorkbenchExclusionV1Schema).max(10_000),
  requests: z.array(WorkbenchRequestV1Schema).max(10_000),
  drafts: z.array(WorkbenchDraftV1Schema).max(1_000),
}).strict();
export type WorkbenchSelectionExportV1 = z.infer<typeof WorkbenchSelectionExportV1Schema>;

export const WorkbenchActionV1Schema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("record-request"),
      assetId: CatalogIdSchema,
      origin: WorkbenchOriginV1Schema,
    })
    .strict(),
  z
    .object({
      type: z.literal("remove-request"),
      assetId: CatalogIdSchema,
      origin: WorkbenchOriginV1Schema,
    })
    .strict(),
  z
    .object({
      type: z.literal("select-root"),
      assetId: CatalogIdSchema,
      origin: WorkbenchOriginV1Schema,
      mode: z.enum(["select", "structural"]).optional(),
      includeOptionalMembers: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("remove-root"),
      assetId: CatalogIdSchema,
      origin: WorkbenchOriginV1Schema,
    })
    .strict(),
  z.object({ type: z.literal("apply-template"), templateId: CatalogIdSchema }).strict(),
  z
    .object({
      type: z.literal("add-exclusion"),
      assetId: CatalogIdSchema,
      origin: WorkbenchOriginV1Schema,
    })
    .strict(),
  z
    .object({
      type: z.literal("remove-exclusion"),
      assetId: CatalogIdSchema,
      origin: WorkbenchOriginV1Schema,
    })
    .strict(),
  z
    .object({
      type: z.literal("remove-template"),
      templateId: CatalogIdSchema,
      digest: DigestSchema,
    })
    .strict(),
  z.object({ type: z.literal("add-draft"), draft: WorkbenchDraftV1Schema }).strict(),
  z.object({ type: z.literal("remove-draft"), id: CatalogIdSchema }).strict(),
  z.object({ type: z.literal("restore-state"), state: WorkbenchStateV1Schema }).strict(),
]);
export type WorkbenchActionV1 = z.infer<typeof WorkbenchActionV1Schema>;
export const AuthoringCatalogBundleV1Schema = z
  .object({
    version: z.literal("authoring-catalog-bundle/v1"),
    sources: z.record(CatalogIdSchema, SourceDescriptorV1Schema),
    assets: z.record(CatalogIdSchema, AuthoringAssetV1Schema),
    groups: z.record(
      CatalogIdSchema,
      z
        .object({
          id: CatalogIdSchema,
          label: z
            .string()
            .min(1)
            .max(500)
            .refine(noHiddenCharacters, "must be NFC text without hidden characters"),
          assetIds: z.array(CatalogIdSchema).max(50_000),
        })
        .strict(),
    ),
    relations: z.array(CatalogRelationV1Schema).max(100_000),
    templates: z.record(CatalogIdSchema, SelectionTemplateV1Schema),
    evidence: z.record(CatalogIdSchema, EvidenceSummaryV1Schema),
    provenance: z.object({ bundleDigest: DigestSchema }).strict(),
    detailChunks: z.record(
      CatalogIdSchema,
      z.object({ bytes: z.string().min(1).max(1_000_000), digest: DigestSchema }).strict(),
    ),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    const assetExists = (assetId: string) => bundle.assets[assetId] !== undefined;
    for (const [sourceId, source] of Object.entries(bundle.sources)) {
      if (source.id !== sourceId) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", sourceId, "id"],
          message: "Source key must match id.",
        });
      }
    }
    for (const [assetId, asset] of Object.entries(bundle.assets)) {
      if (asset.id !== assetId) {
        ctx.addIssue({
          code: "custom",
          path: ["assets", assetId, "id"],
          message: "Asset key must match id.",
        });
      }
      const source = bundle.sources[asset.sourceId];
      if (source === undefined || source.revision.id !== asset.sourceRevisionId) {
        ctx.addIssue({
          code: "custom",
          path: ["assets", assetId, "sourceRevisionId"],
          message: "Asset source and immutable source revision must exist in the bundle.",
        });
      }
      if (bundle.detailChunks[asset.detailChunkId] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["assets", assetId, "detailChunkId"],
          message: "Asset detail chunk must exist in the bundle.",
        });
      }
    }
    for (const [groupId, group] of Object.entries(bundle.groups)) {
      if (group.id !== groupId || group.assetIds.some((assetId) => !assetExists(assetId))) {
        ctx.addIssue({
          code: "custom",
          path: ["groups", groupId],
          message: "Group references an unknown asset.",
        });
      }
    }
    for (const [index, relation] of bundle.relations.entries()) {
      if (!assetExists(relation.fromAssetId) || !assetExists(relation.toAssetId)) {
        ctx.addIssue({
          code: "custom",
          path: ["relations", index],
          message: "Relation references an unknown asset.",
        });
      }
    }
    for (const [templateId, template] of Object.entries(bundle.templates)) {
      if (
        template.id !== templateId ||
        template.roots.some((root) => !assetExists(root.assetId)) ||
        template.exclusions.some((id) => !assetExists(id))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["templates", templateId],
          message: "Template references an unknown asset.",
        });
      }
    }
    const relationKeys = new Set<string>();
    for (const [index, relation] of bundle.relations.entries()) {
      const endpoints =
        relation.kind === "conflicts" && relation.toAssetId < relation.fromAssetId
          ? [relation.toAssetId, relation.fromAssetId]
          : [relation.fromAssetId, relation.toAssetId];
      const key = `${endpoints[0]}\u0000${endpoints[1]}`;
      const target = bundle.assets[relation.toAssetId];
      if (relation.fromAssetId === relation.toAssetId || relationKeys.has(key))
        ctx.addIssue({
          code: "custom",
          path: ["relations", index],
          message: "Relations must be unique and cannot be self-referential.",
        });
      relationKeys.add(key);
      if (
        relation.kind !== "conflicts" &&
        target !== undefined &&
        target.authoring.action !== "select-control" &&
        target.authoring.action !== "record-selection"
      )
        ctx.addIssue({
          code: "custom",
          path: ["relations", index, "toAssetId"],
          message: "Closure relations may target only selectable controls or selection records.",
        });
    }
    for (const [groupId, group] of Object.entries(bundle.groups))
      if (
        group.id !== groupId ||
        new Set(group.assetIds).size !== group.assetIds.length ||
        group.assetIds.some((id, index) => index > 0 && id < group.assetIds[index - 1]!)
      )
        ctx.addIssue({
          code: "custom",
          path: ["groups", groupId],
          message: "Group ids and members must be unique and canonically ordered.",
        });
    for (const [templateId, template] of Object.entries(bundle.templates)) {
      const roots = template.roots.map((root) => root.assetId);
      if (
        new Set(roots).size !== roots.length ||
        roots.some((id, index) => index > 0 && id < roots[index - 1]!) ||
        new Set(template.exclusions).size !== template.exclusions.length ||
        template.exclusions.some(
          (id, index) => index > 0 && id < template.exclusions[index - 1]!,
        ) ||
        roots.some((id) => template.exclusions.includes(id))
      )
        ctx.addIssue({
          code: "custom",
          path: ["templates", templateId],
          message: "Template roots and exclusions must be unique, ordered, and disjoint.",
        });
    }
    for (const [evidenceId, evidence] of Object.entries(bundle.evidence)) {
      const subjectIds = evidence.subjects.map((subject) => subject.assetId);
      if (
        evidence.id !== evidenceId ||
        new Set(subjectIds).size !== subjectIds.length ||
        subjectIds.some((id, index) => index > 0 && id < subjectIds[index - 1]!) ||
        new Set(evidence.coveredPaths).size !== evidence.coveredPaths.length ||
        evidence.coveredPaths.some(
          (path, index) => index > 0 && path < evidence.coveredPaths[index - 1]!,
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["evidence", evidenceId],
          message:
            "Evidence key, subjects, and covered paths must be unique and canonically ordered.",
        });
      if (
        evidence.subjects.some((subject) => {
          const asset = bundle.assets[subject.assetId];
          return (
            asset === undefined ||
            asset.sourceId !== subject.sourceId ||
            asset.sourceRevisionId !== subject.sourceRevisionId ||
            asset.contentDigest !== subject.contentDigest
          );
        })
      )
        ctx.addIssue({
          code: "custom",
          path: ["evidence", evidenceId],
          message: "Evidence subject must exactly match an asset identity.",
        });
    }
  });

export type AuthoringCatalogBundleV1 = z.infer<typeof AuthoringCatalogBundleV1Schema>;
export type AuthoringAssetV1 = z.infer<typeof AuthoringAssetV1Schema>;
export type CompilerAssetDeclarationV1 = z.infer<typeof CompilerAssetDeclarationV1Schema>;
export type WorkbenchStateV1 = z.infer<typeof WorkbenchStateV1Schema>;
export type WorkbenchRootV1 = z.infer<typeof WorkbenchRootV1Schema>;
export type WorkbenchRequestV1 = z.infer<typeof WorkbenchRequestV1Schema>;
export type WorkbenchDraftV1 = z.infer<typeof WorkbenchDraftV1Schema>;
export type EvidenceSummaryV1 = z.infer<typeof EvidenceSummaryV1Schema>;

export function parseAuthoringCatalogBundleV1(value: unknown): AuthoringCatalogBundleV1 {
  return AuthoringCatalogBundleV1Schema.parse(value);
}
