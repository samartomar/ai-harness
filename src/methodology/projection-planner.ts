import { createHash } from "node:crypto";
import { z } from "zod";
import {
  classifySyntheticMethodology,
  SyntheticMethodologyDigestSchema,
  SyntheticMethodologyInputSchema,
  SyntheticMethodologyPathSchema,
  SyntheticMethodologySourceLocatorSchema,
} from "./classifier.js";

const MAX_SYNTHETIC_PROJECTION_ENTRIES = 32;
const COMPONENT_ID_SCHEMA = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const PROJECTION_OWNER = "aih-methodology-v1";
const PROJECTION_ROOT = "methodology/v1/";

interface ManifestEntryObject {
  id: string;
  source: {
    locator: string;
    sourceDigest: string;
    contentDigest: string;
  };
  target: string;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalManifestEntries(entries: readonly ManifestEntryObject[]): ManifestEntryObject[] {
  return entries
    .map((entry) => ({
      id: entry.id,
      source: {
        locator: entry.source.locator,
        sourceDigest: entry.source.sourceDigest,
        contentDigest: entry.source.contentDigest,
      },
      target: entry.target,
    }))
    .sort(
      (left, right) =>
        compareCodeUnits(left.target, right.target) || compareCodeUnits(left.id, right.id),
    );
}

function manifestDigest(entries: readonly ManifestEntryObject[]): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        owner: PROJECTION_OWNER,
        entries: canonicalManifestEntries(entries),
      }),
      "utf8",
    )
    .digest("hex")}`;
}

export const SyntheticMethodologyProjectionSourceSchema = z
  .object({
    locator: SyntheticMethodologySourceLocatorSchema,
    sourceDigest: SyntheticMethodologyDigestSchema,
    contentDigest: SyntheticMethodologyDigestSchema,
  })
  .strict();

export const SyntheticMethodologyProjectionTargetSchema = z
  .object({
    path: SyntheticMethodologyPathSchema,
    owner: z.enum([PROJECTION_OWNER, "external"]),
  })
  .strict();

export const SyntheticMethodologyProjectionMappingSchema = z
  .object({
    id: COMPONENT_ID_SCHEMA,
    target: SyntheticMethodologyProjectionTargetSchema,
  })
  .strict();

export const SyntheticMethodologyProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    classification: SyntheticMethodologyInputSchema,
    mappings: z
      .array(SyntheticMethodologyProjectionMappingSchema)
      .min(1)
      .max(MAX_SYNTHETIC_PROJECTION_ENTRIES),
  })
  .strict()
  .superRefine((projection, ctx) => {
    const ids = new Set<string>();
    for (const [index, mapping] of projection.mappings.entries()) {
      if (ids.has(mapping.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["mappings", index, "id"],
          message: "synthetic projection mappings must have unique component ids",
        });
      }
      ids.add(mapping.id);
    }
  });

export const SyntheticMethodologyProjectionFindingCodeSchema = z.enum([
  "METHODOLOGY_SYNTHETIC_ADMISSION_DENIED",
  "METHODOLOGY_SYNTHETIC_ADMISSION_MAPPING_MISMATCH",
  "METHODOLOGY_SYNTHETIC_DESTINATION_COLLISION",
  "METHODOLOGY_SYNTHETIC_TARGET_UNOWNED",
]);

export const SyntheticMethodologyProjectionFindingSchema = z
  .object({
    code: SyntheticMethodologyProjectionFindingCodeSchema,
    disposition: z.literal("blocked"),
    target: SyntheticMethodologyPathSchema,
  })
  .strict();

const OwnedProjectionPathSchema = SyntheticMethodologyPathSchema.refine(
  (path) => path.startsWith(PROJECTION_ROOT),
  { message: "manifest targets must remain under the owned methodology projection root" },
);

export const SyntheticMethodologyProjectionManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: z.literal(PROJECTION_OWNER),
    entries: z
      .array(
        z
          .object({
            id: COMPONENT_ID_SCHEMA,
            source: SyntheticMethodologyProjectionSourceSchema,
            target: OwnedProjectionPathSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_SYNTHETIC_PROJECTION_ENTRIES),
    digest: SyntheticMethodologyDigestSchema,
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>();
    const targets = new Set<string>();
    const sources = new Set<string>();
    for (const [index, entry] of manifest.entries.entries()) {
      if (ids.has(entry.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "id"],
          message: "manifest component ids must be unique",
        });
      }
      if (targets.has(entry.target)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "target"],
          message: "manifest targets must be unique",
        });
      }
      if (sources.has(entry.source.locator)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "source", "locator"],
          message: "manifest source locators must be unique",
        });
      }
      ids.add(entry.id);
      targets.add(entry.target);
      sources.add(entry.source.locator);
    }

    const canonical = canonicalManifestEntries(manifest.entries);
    if (JSON.stringify(manifest.entries) !== JSON.stringify(canonical)) {
      ctx.addIssue({
        code: "custom",
        path: ["entries"],
        message: "manifest entries must use canonical target and component ordering",
      });
    }
    if (manifest.digest !== manifestDigest(canonical)) {
      ctx.addIssue({
        code: "custom",
        path: ["digest"],
        message: "manifest digest must bind its canonical manifest entries",
      });
    }
  });

export const SyntheticMethodologyProjectionBoundarySchema = z
  .object({
    providerExecution: z.literal(false),
    hostExecution: z.literal(false),
    reads: z.literal(false),
    writes: z.literal(false),
    cli: z.literal(false),
  })
  .strict();

export const SyntheticMethodologyProjectionPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(["planned", "blocked"]),
    manifest: SyntheticMethodologyProjectionManifestSchema.nullable(),
    findings: z.array(SyntheticMethodologyProjectionFindingSchema).max(96),
    boundary: SyntheticMethodologyProjectionBoundarySchema,
  })
  .strict()
  .superRefine((plan, ctx) => {
    const findings = new Set<string>();
    for (const [index, finding] of plan.findings.entries()) {
      const key = `${finding.target}\u0000${finding.code}`;
      if (findings.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["findings", index],
          message: "synthetic projection findings must be unique",
        });
      }
      findings.add(key);
    }
    const canonical = [...plan.findings].sort(
      (left, right) =>
        compareCodeUnits(left.target, right.target) || compareCodeUnits(left.code, right.code),
    );
    if (JSON.stringify(plan.findings) !== JSON.stringify(canonical)) {
      ctx.addIssue({
        code: "custom",
        path: ["findings"],
        message: "synthetic projection findings must use canonical target and code ordering",
      });
    }
    if (plan.state === "planned") {
      if (plan.manifest === null) {
        ctx.addIssue({
          code: "custom",
          path: ["manifest"],
          message: "a planned synthetic projection requires a manifest",
        });
      }
      if (plan.findings.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["findings"],
          message: "a planned synthetic projection cannot contain findings",
        });
      }
    } else {
      if (plan.manifest !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["manifest"],
          message: "a blocked synthetic projection cannot contain a manifest",
        });
      }
      if (plan.findings.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["findings"],
          message: "a blocked synthetic projection requires a finding",
        });
      }
    }
  });

type SyntheticMethodologyProjection = z.infer<typeof SyntheticMethodologyProjectionSchema>;
type SyntheticMethodologyProjectionFinding = z.infer<
  typeof SyntheticMethodologyProjectionFindingSchema
>;

export const SYNTHETIC_METHODOLOGY_PROJECTION_BOUNDARY = Object.freeze({
  providerExecution: false,
  hostExecution: false,
  reads: false,
  writes: false,
  cli: false,
});

function canonicalFindings(
  findings: Map<string, SyntheticMethodologyProjectionFinding>,
): SyntheticMethodologyProjectionFinding[] {
  return [...findings.values()].sort(
    (left, right) =>
      compareCodeUnits(left.target, right.target) || compareCodeUnits(left.code, right.code),
  );
}

/**
 * Plan only caller-supplied synthetic objects. This module has no filesystem,
 * process, provider, host, command, or executor capability.
 */
export function planSyntheticMethodologyProjection(value: unknown) {
  const projection: SyntheticMethodologyProjection =
    SyntheticMethodologyProjectionSchema.parse(value);
  const classification = classifySyntheticMethodology(projection.classification);
  const findings = new Map<string, SyntheticMethodologyProjectionFinding>();
  function block(
    code: z.infer<typeof SyntheticMethodologyProjectionFindingCodeSchema>,
    target: string,
  ): void {
    findings.set(`${target}\u0000${code}`, { code, disposition: "blocked", target });
  }

  if (classification.disposition !== "admitted") {
    for (const mapping of projection.mappings) {
      block("METHODOLOGY_SYNTHETIC_ADMISSION_DENIED", mapping.target.path);
    }
    return SyntheticMethodologyProjectionPlanSchema.parse({
      schemaVersion: 1,
      state: "blocked",
      manifest: null,
      findings: canonicalFindings(findings),
      boundary: SYNTHETIC_METHODOLOGY_PROJECTION_BOUNDARY,
    });
  }

  const admitted = new Set(classification.admitted);
  const mapped = new Set(projection.mappings.map((mapping) => mapping.id));
  for (const mapping of projection.mappings) {
    if (!admitted.has(mapping.id)) {
      block("METHODOLOGY_SYNTHETIC_ADMISSION_MAPPING_MISMATCH", mapping.target.path);
    }
  }
  for (const id of classification.admitted) {
    if (!mapped.has(id)) {
      block("METHODOLOGY_SYNTHETIC_ADMISSION_MAPPING_MISMATCH", PROJECTION_ROOT.slice(0, -1));
    }
  }

  const targets = new Map<string, number>();
  for (const mapping of projection.mappings) {
    targets.set(mapping.target.path, (targets.get(mapping.target.path) ?? 0) + 1);
  }

  for (const mapping of projection.mappings) {
    if (
      mapping.target.owner !== PROJECTION_OWNER ||
      !mapping.target.path.startsWith(PROJECTION_ROOT)
    ) {
      block("METHODOLOGY_SYNTHETIC_TARGET_UNOWNED", mapping.target.path);
    }
    if ((targets.get(mapping.target.path) ?? 0) > 1) {
      block("METHODOLOGY_SYNTHETIC_DESTINATION_COLLISION", mapping.target.path);
    }
  }

  const canonical = canonicalFindings(findings);
  if (canonical.length > 0) {
    return SyntheticMethodologyProjectionPlanSchema.parse({
      schemaVersion: 1,
      state: "blocked",
      manifest: null,
      findings: canonical,
      boundary: SYNTHETIC_METHODOLOGY_PROJECTION_BOUNDARY,
    });
  }

  const artifacts = new Map(
    projection.classification.artifacts.map((artifact) => [artifact.id, artifact]),
  );
  const entries = canonicalManifestEntries(
    projection.mappings.map((mapping) => {
      const artifact = artifacts.get(mapping.id);
      if (artifact === undefined) {
        throw new Error("admitted synthetic artifacts must be present in the closed candidate");
      }
      return {
        id: mapping.id,
        source: {
          locator: artifact.sourceIdentity.locator,
          sourceDigest: artifact.sourceIdentity.digest,
          contentDigest: artifact.content.digest,
        },
        target: mapping.target.path,
      };
    }),
  );
  const manifest = {
    schemaVersion: 1 as const,
    owner: PROJECTION_OWNER,
    entries,
  };
  const digest = manifestDigest(entries);

  return SyntheticMethodologyProjectionPlanSchema.parse({
    schemaVersion: 1,
    state: "planned",
    manifest: { ...manifest, digest },
    findings: [],
    boundary: SYNTHETIC_METHODOLOGY_PROJECTION_BOUNDARY,
  });
}
