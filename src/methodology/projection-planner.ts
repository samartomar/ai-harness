import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SyntheticMethodologyDigestSchema,
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

export const SyntheticMethodologyProjectionEntrySchema = z
  .object({
    id: COMPONENT_ID_SCHEMA,
    admission: z.literal("admitted"),
    source: SyntheticMethodologyProjectionSourceSchema,
    target: SyntheticMethodologyProjectionTargetSchema,
  })
  .strict();

export const SyntheticMethodologyProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z
      .array(SyntheticMethodologyProjectionEntrySchema)
      .min(1)
      .max(MAX_SYNTHETIC_PROJECTION_ENTRIES),
  })
  .strict()
  .superRefine((projection, ctx) => {
    const ids = new Set<string>();
    for (const [index, entry] of projection.entries.entries()) {
      if (ids.has(entry.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "id"],
          message: "synthetic projection entries must have unique component ids",
        });
      }
      ids.add(entry.id);
    }
  });

export const SyntheticMethodologyProjectionFindingCodeSchema = z.enum([
  "METHODOLOGY_SYNTHETIC_DESTINATION_COLLISION",
  "METHODOLOGY_SYNTHETIC_SOURCE_IDENTITY_AMBIGUOUS",
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
  const targets = new Map<string, number>();
  const sources = new Map<string, number>();
  for (const entry of projection.entries) {
    targets.set(entry.target.path, (targets.get(entry.target.path) ?? 0) + 1);
    sources.set(entry.source.locator, (sources.get(entry.source.locator) ?? 0) + 1);
  }

  const findings = new Map<string, SyntheticMethodologyProjectionFinding>();
  function block(
    code: z.infer<typeof SyntheticMethodologyProjectionFindingCodeSchema>,
    target: string,
  ): void {
    findings.set(`${target}\u0000${code}`, { code, disposition: "blocked", target });
  }

  for (const entry of projection.entries) {
    if (entry.target.owner !== PROJECTION_OWNER || !entry.target.path.startsWith(PROJECTION_ROOT)) {
      block("METHODOLOGY_SYNTHETIC_TARGET_UNOWNED", entry.target.path);
    }
    if ((targets.get(entry.target.path) ?? 0) > 1) {
      block("METHODOLOGY_SYNTHETIC_DESTINATION_COLLISION", entry.target.path);
    }
    if ((sources.get(entry.source.locator) ?? 0) > 1) {
      block("METHODOLOGY_SYNTHETIC_SOURCE_IDENTITY_AMBIGUOUS", entry.target.path);
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

  const entries = canonicalManifestEntries(
    projection.entries.map((entry) => ({
      id: entry.id,
      source: entry.source,
      target: entry.target.path,
    })),
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
