import { posix, win32 } from "node:path";
import { z } from "zod";

const GIT_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9:._-]*$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function hasNoControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

const SafeTextSchema = z.string().trim().min(1).max(500).refine(hasNoControlCharacters, {
  message: "value must not contain control characters",
});

const AbsolutePathSchema = SafeTextSchema.refine(
  (value) => posix.isAbsolute(value) || win32.isAbsolute(value),
  { message: "source root must be an absolute path" },
);

export const MethodologySourceSchema = z
  .object({
    type: z.literal("local-git"),
    repository: z.string().regex(REPOSITORY),
    root: AbsolutePathSchema,
    requestedRef: SafeTextSchema,
    resolvedCommit: z.string().regex(GIT_COMMIT),
  })
  .strict();

export const MethodologyAdapterSchema = z
  .object({
    id: z.string().regex(ID),
    contractVersion: z.number().int().positive(),
    implementationHash: z.string().regex(SHA256),
  })
  .strict();

export const MethodologyProviderSchema = z
  .object({
    id: z.string().regex(ID),
    kind: z.enum(["skill-pack", "host-plugin", "standalone-runtime", "hybrid-runtime"]),
    source: MethodologySourceSchema,
    adapter: MethodologyAdapterSchema,
  })
  .strict();

const RuntimeMapSchema = z
  .record(z.string().regex(ID), SafeTextSchema)
  .refine((runtimes) => Object.keys(runtimes).length > 0, {
    message: "at least one runtime version is required",
  });

export const MethodologyHostSchema = z
  .object({
    id: z.string().regex(ID),
    version: SafeTextSchema,
    build: SafeTextSchema,
    contractVersion: SafeTextSchema,
    coverage: z.enum(["complete", "partial", "unknown"]),
    scope: z.enum(["project", "profile", "machine"]),
    isolationMode: z.enum([
      "project-native",
      "profile-home",
      "standalone",
      "machine-exclusive",
      "unknown",
    ]),
    operatingSystem: z.enum(["windows", "linux", "macos"]),
    operatingSystemVersion: SafeTextSchema,
    architecture: z.enum(["x64", "arm64"]),
    runtimes: RuntimeMapSchema,
  })
  .strict();

export const MethodologyIntentSchema = z
  .object({
    selectedBy: SafeTextSchema,
    selectedAt: z.iso.datetime({ offset: true }),
    reason: SafeTextSchema,
  })
  .strict();

export const MethodologyProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: MethodologyProviderSchema,
    host: MethodologyHostSchema,
    policyVersion: SafeTextSchema,
    intent: MethodologyIntentSchema.optional(),
  })
  .strict();

export type MethodologyProposal = z.infer<typeof MethodologyProposalSchema>;

export function parseMethodologyProposal(value: unknown): MethodologyProposal {
  return MethodologyProposalSchema.parse(value);
}
