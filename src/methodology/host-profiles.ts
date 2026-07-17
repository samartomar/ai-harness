import { z } from "zod";
import { SyntheticMethodologyDigestSchema, SyntheticMethodologyPathSchema } from "./classifier.js";
import { SyntheticMethodologyProjectionManifestSchema } from "./projection-planner.js";
import {
  MethodologyClaimsSchema,
  MethodologyCompatibilitySchema,
  MethodologyHostAdapterIdSchema,
} from "./schema.js";

const MAX_MAPPINGS = 32;
const ComponentIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const SyntheticProfileIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const SyntheticProjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

export const SyntheticMethodologyHostSurfaceSchema = z.enum([
  "project-projection",
  "host-built-in",
  "user-rules",
  "team-rules",
  "managed-policy",
  "plugin",
  "hook",
  "mcp",
  "compatibility",
  "remote-instruction",
]);

const REQUIRED_SURFACES = new Set(SyntheticMethodologyHostSurfaceSchema.options);
// One tuple denial, each non-projection surface, six findings per supplied mapping,
// and one missing-manifest mapping finding per bounded manifest entry.
const MAX_HOST_FINDINGS = 1 + (REQUIRED_SURFACES.size - 1) + MAX_MAPPINGS * 7;

export const SyntheticMethodologyHostProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SyntheticProfileIdSchema,
    project: SyntheticProjectIdSchema,
    hostAdapter: MethodologyHostAdapterIdSchema,
    compatibility: MethodologyCompatibilitySchema,
    posture: z.enum(["advisory", "unsupported"]),
    surfaces: z
      .array(
        z
          .object({
            id: SyntheticMethodologyHostSurfaceSchema,
            presence: z.enum(["present", "absent", "unknown"]),
            precedence: z.number().int().min(0).max(15),
          })
          .strict(),
      )
      .length(REQUIRED_SURFACES.size),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.hostAdapter !== `${profile.compatibility.host}-static-v1`) {
      ctx.addIssue({
        code: "custom",
        path: ["hostAdapter"],
        message: "synthetic host profile adapter must bind its exact compatibility host",
      });
    }
    const ids = new Set<string>();
    for (const [index, surface] of profile.surfaces.entries()) {
      if (ids.has(surface.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["surfaces", index, "id"],
          message: "synthetic host surfaces must be unique",
        });
      }
      ids.add(surface.id);
    }
    for (const surface of REQUIRED_SURFACES) {
      if (!ids.has(surface)) {
        ctx.addIssue({
          code: "custom",
          path: ["surfaces"],
          message: "synthetic host profiles must declare every logical surface",
        });
      }
    }
  });

export const SyntheticMethodologyHostMappingSchema = z
  .object({
    id: ComponentIdSchema,
    manifestDigest: SyntheticMethodologyDigestSchema,
    profile: SyntheticProfileIdSchema,
    project: SyntheticProjectIdSchema,
    hostAdapter: MethodologyHostAdapterIdSchema,
    compatibility: MethodologyCompatibilitySchema,
    destination: z.literal("project-projection"),
  })
  .strict();

export const SyntheticMethodologyHostMappingInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    profile: SyntheticMethodologyHostProfileSchema,
    manifest: SyntheticMethodologyProjectionManifestSchema,
    mappings: z.array(SyntheticMethodologyHostMappingSchema).min(1).max(MAX_MAPPINGS),
  })
  .strict()
  .superRefine((input, ctx) => {
    const ids = new Set<string>();
    for (const [index, mapping] of input.mappings.entries()) {
      if (ids.has(mapping.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["mappings", index, "id"],
          message: "synthetic host mappings must have unique component ids",
        });
      }
      ids.add(mapping.id);
    }
  });

export const SyntheticMethodologyHostFindingCodeSchema = z.enum([
  "METHODOLOGY_SYNTHETIC_HOST_DESTINATION_UNAVAILABLE",
  "METHODOLOGY_SYNTHETIC_HOST_MANIFEST_DIGEST_MISMATCH",
  "METHODOLOGY_SYNTHETIC_HOST_MANIFEST_MAPPING_MISMATCH",
  "METHODOLOGY_SYNTHETIC_HOST_MAPPING_ADAPTER_MISMATCH",
  "METHODOLOGY_SYNTHETIC_HOST_MAPPING_COMPATIBILITY_MISMATCH",
  "METHODOLOGY_SYNTHETIC_HOST_MAPPING_PROFILE_MISMATCH",
  "METHODOLOGY_SYNTHETIC_HOST_MAPPING_PROJECT_MISMATCH",
  "METHODOLOGY_SYNTHETIC_HOST_PRECEDENCE_CONFLICT",
  "METHODOLOGY_SYNTHETIC_HOST_SURFACE_UNKNOWN",
  "METHODOLOGY_SYNTHETIC_HOST_TUPLE_UNSUPPORTED",
]);

export const SyntheticMethodologyHostFindingSchema = z
  .object({
    code: SyntheticMethodologyHostFindingCodeSchema,
    disposition: z.literal("blocked"),
    component: ComponentIdSchema.optional(),
    surface: SyntheticMethodologyHostSurfaceSchema.optional(),
  })
  .strict()
  .superRefine((finding, ctx) => {
    const expectsComponent =
      finding.code === "METHODOLOGY_SYNTHETIC_HOST_MANIFEST_DIGEST_MISMATCH" ||
      finding.code === "METHODOLOGY_SYNTHETIC_HOST_MANIFEST_MAPPING_MISMATCH" ||
      finding.code === "METHODOLOGY_SYNTHETIC_HOST_MAPPING_ADAPTER_MISMATCH" ||
      finding.code === "METHODOLOGY_SYNTHETIC_HOST_MAPPING_COMPATIBILITY_MISMATCH" ||
      finding.code === "METHODOLOGY_SYNTHETIC_HOST_MAPPING_PROFILE_MISMATCH" ||
      finding.code === "METHODOLOGY_SYNTHETIC_HOST_MAPPING_PROJECT_MISMATCH";
    const expectsSurface =
      finding.code === "METHODOLOGY_SYNTHETIC_HOST_DESTINATION_UNAVAILABLE" ||
      finding.code === "METHODOLOGY_SYNTHETIC_HOST_PRECEDENCE_CONFLICT" ||
      finding.code === "METHODOLOGY_SYNTHETIC_HOST_SURFACE_UNKNOWN";
    if (expectsComponent !== (finding.component !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["component"],
        message: "this synthetic host finding must use its fixed component disposition",
      });
    }
    if (expectsSurface !== (finding.surface !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["surface"],
        message: "this synthetic host finding must use its fixed surface disposition",
      });
    }
  });

export const SyntheticMethodologyHostBoundarySchema = z
  .object({
    providerExecution: z.literal(false),
    providerFetch: z.literal(false),
    hostExecution: z.literal(false),
    filesystem: z.literal(false),
    writes: z.literal(false),
    cli: z.literal(false),
    executor: z.literal(false),
    network: z.literal(false),
    packageManager: z.literal(false),
    hostNativeWrites: z.literal(false),
  })
  .strict();

const SubjectSchema = z
  .object({
    profile: SyntheticProfileIdSchema,
    project: SyntheticProjectIdSchema,
    hostAdapter: MethodologyHostAdapterIdSchema,
    compatibility: MethodologyCompatibilitySchema,
  })
  .strict()
  .superRefine((subject, ctx) => {
    if (subject.hostAdapter !== `${subject.compatibility.host}-static-v1`) {
      ctx.addIssue({
        code: "custom",
        path: ["hostAdapter"],
        message: "synthetic host assessment adapter must bind its exact compatibility host",
      });
    }
  });

const OwnedResultTargetSchema = SyntheticMethodologyPathSchema.refine(
  (path) => path.startsWith("methodology/v1/"),
  { message: "synthetic host mapping sources must remain under the owned projection root" },
);

const ResultMappingSchema = z
  .object({
    id: ComponentIdSchema,
    sourceTarget: OwnedResultTargetSchema,
    destination: z.literal("project-projection"),
  })
  .strict();

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compatibilityEquals(
  left: z.infer<typeof MethodologyCompatibilitySchema>,
  right: z.infer<typeof MethodologyCompatibilitySchema>,
): boolean {
  return (
    left.host === right.host &&
    left.hostVersion === right.hostVersion &&
    left.executableSha256 === right.executableSha256 &&
    left.os === right.os &&
    left.architecture === right.architecture &&
    left.runtime === right.runtime &&
    left.policyContext === right.policyContext
  );
}

function findingKey(finding: z.infer<typeof SyntheticMethodologyHostFindingSchema>): string {
  return `${finding.component ?? ""}\u0000${finding.code}\u0000${finding.surface ?? ""}`;
}

function canonicalFindings(
  findings: readonly z.infer<typeof SyntheticMethodologyHostFindingSchema>[],
) {
  return [...findings].sort((left, right) => compareCodeUnits(findingKey(left), findingKey(right)));
}

export const SyntheticMethodologyHostAssessmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(["advisory", "blocked"]),
    manifestDigest: SyntheticMethodologyDigestSchema,
    subject: SubjectSchema,
    mappings: z.array(ResultMappingSchema).max(MAX_MAPPINGS),
    findings: z.array(SyntheticMethodologyHostFindingSchema).max(MAX_HOST_FINDINGS),
    claims: MethodologyClaimsSchema,
    boundary: SyntheticMethodologyHostBoundarySchema,
  })
  .strict()
  .superRefine((assessment, ctx) => {
    const mappingIds = new Set<string>();
    for (const [index, mapping] of assessment.mappings.entries()) {
      if (mappingIds.has(mapping.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["mappings", index, "id"],
          message: "synthetic host assessment mappings must be unique",
        });
      }
      mappingIds.add(mapping.id);
    }
    const canonicalMappings = [...assessment.mappings].sort((left, right) =>
      compareCodeUnits(left.id, right.id),
    );
    if (JSON.stringify(assessment.mappings) !== JSON.stringify(canonicalMappings)) {
      ctx.addIssue({
        code: "custom",
        path: ["mappings"],
        message: "synthetic host assessment mappings must use canonical component ordering",
      });
    }
    const findingKeys = new Set<string>();
    for (const [index, finding] of assessment.findings.entries()) {
      const key = findingKey(finding);
      if (findingKeys.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["findings", index],
          message: "synthetic host assessment findings must be unique",
        });
      }
      findingKeys.add(key);
    }
    if (
      JSON.stringify(assessment.findings) !== JSON.stringify(canonicalFindings(assessment.findings))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["findings"],
        message: "synthetic host assessment findings must use canonical ordering",
      });
    }
    if (assessment.state === "advisory") {
      if (assessment.mappings.length === 0 || assessment.findings.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["state"],
          message: "an advisory synthetic host assessment requires mappings and no findings",
        });
      }
    } else if (assessment.mappings.length > 0 || assessment.findings.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["state"],
        message: "a blocked synthetic host assessment requires findings and no mappings",
      });
    }
  });

export const SYNTHETIC_METHODOLOGY_HOST_BOUNDARY = Object.freeze({
  providerExecution: false,
  providerFetch: false,
  hostExecution: false,
  filesystem: false,
  writes: false,
  cli: false,
  executor: false,
  network: false,
  packageManager: false,
  hostNativeWrites: false,
});

const SYNTHETIC_METHODOLOGY_HOST_CLAIMS = Object.freeze({
  installed: false,
  active: false,
  isolated: false,
  switchable: false,
  concurrent: false,
  conflictFree: false,
});

/**
 * Evaluates caller-supplied synthetic host records only. This module has no filesystem,
 * process, provider, host, command, executor, network, or package-manager capability.
 */
export function evaluateSyntheticMethodologyHostMappings(value: unknown) {
  const input = SyntheticMethodologyHostMappingInputSchema.parse(value);
  const findings = new Map<string, z.infer<typeof SyntheticMethodologyHostFindingSchema>>();
  const block = (
    code: z.infer<typeof SyntheticMethodologyHostFindingCodeSchema>,
    details: Omit<
      z.infer<typeof SyntheticMethodologyHostFindingSchema>,
      "code" | "disposition"
    > = {},
  ) => {
    const finding = { code, disposition: "blocked" as const, ...details };
    findings.set(findingKey(finding), finding);
  };

  const { profile } = input;
  if (profile.posture === "unsupported") block("METHODOLOGY_SYNTHETIC_HOST_TUPLE_UNSUPPORTED");

  const projectionSurface = profile.surfaces.find((surface) => surface.id === "project-projection");
  if (projectionSurface === undefined || projectionSurface.presence !== "present") {
    block("METHODOLOGY_SYNTHETIC_HOST_DESTINATION_UNAVAILABLE", {
      surface: "project-projection",
    });
  } else {
    for (const surface of profile.surfaces) {
      if (surface.id === "project-projection") continue;
      if (surface.presence === "unknown") {
        block("METHODOLOGY_SYNTHETIC_HOST_SURFACE_UNKNOWN", { surface: surface.id });
      } else if (
        surface.presence === "present" &&
        surface.precedence <= projectionSurface.precedence
      ) {
        block("METHODOLOGY_SYNTHETIC_HOST_PRECEDENCE_CONFLICT", { surface: surface.id });
      }
    }
  }

  const manifestById = new Map(input.manifest.entries.map((entry) => [entry.id, entry]));
  const mappingById = new Map(input.mappings.map((mapping) => [mapping.id, mapping]));
  for (const mapping of input.mappings) {
    if (mapping.profile !== profile.id) {
      block("METHODOLOGY_SYNTHETIC_HOST_MAPPING_PROFILE_MISMATCH", { component: mapping.id });
    }
    if (mapping.project !== profile.project) {
      block("METHODOLOGY_SYNTHETIC_HOST_MAPPING_PROJECT_MISMATCH", { component: mapping.id });
    }
    if (mapping.hostAdapter !== profile.hostAdapter) {
      block("METHODOLOGY_SYNTHETIC_HOST_MAPPING_ADAPTER_MISMATCH", { component: mapping.id });
    }
    if (mapping.manifestDigest !== input.manifest.digest) {
      block("METHODOLOGY_SYNTHETIC_HOST_MANIFEST_DIGEST_MISMATCH", { component: mapping.id });
    }
    if (!compatibilityEquals(mapping.compatibility, profile.compatibility)) {
      block("METHODOLOGY_SYNTHETIC_HOST_MAPPING_COMPATIBILITY_MISMATCH", {
        component: mapping.id,
      });
    }
    if (!manifestById.has(mapping.id)) {
      block("METHODOLOGY_SYNTHETIC_HOST_MANIFEST_MAPPING_MISMATCH", { component: mapping.id });
    }
  }
  for (const entry of input.manifest.entries) {
    if (!mappingById.has(entry.id)) {
      block("METHODOLOGY_SYNTHETIC_HOST_MANIFEST_MAPPING_MISMATCH", { component: entry.id });
    }
  }

  const canonical = canonicalFindings([...findings.values()]);
  const subject = {
    profile: profile.id,
    project: profile.project,
    hostAdapter: profile.hostAdapter,
    compatibility: profile.compatibility,
  };
  if (canonical.length > 0) {
    return SyntheticMethodologyHostAssessmentSchema.parse({
      schemaVersion: 1,
      state: "blocked",
      manifestDigest: input.manifest.digest,
      subject,
      mappings: [],
      findings: canonical,
      claims: SYNTHETIC_METHODOLOGY_HOST_CLAIMS,
      boundary: SYNTHETIC_METHODOLOGY_HOST_BOUNDARY,
    });
  }

  const mappings = input.manifest.entries
    .map((entry) => ({
      id: entry.id,
      sourceTarget: entry.target,
      destination: "project-projection" as const,
    }))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  return SyntheticMethodologyHostAssessmentSchema.parse({
    schemaVersion: 1,
    state: "advisory",
    manifestDigest: input.manifest.digest,
    subject,
    mappings,
    findings: [],
    claims: SYNTHETIC_METHODOLOGY_HOST_CLAIMS,
    boundary: SYNTHETIC_METHODOLOGY_HOST_BOUNDARY,
  });
}
