import { z } from "zod";
import { loadFrameworkDescriptorSectionV1 } from "../catalog-package/framework-descriptors.js";
import { AihError } from "../errors.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";

const SafeText = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && code !== 127;
      }),
    "control characters are forbidden",
  );

const OperationSchema = z.object({
  target: z.enum(SUPPORTED_CLIS),
  kind: z.enum(["copy-file", "merge-json", "managed-block", "exec"]),
  source: SafeText.optional(),
  destination: SafeText,
  componentId: SafeText,
  contingentOn: z.literal("evidence-authorization"),
});

const ArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    pinnedSha: z.string().regex(/^[0-9a-f]{40}$/),
  }),
  operations: z.array(OperationSchema),
});

export type ContingentEccInstallOperation = z.infer<typeof OperationSchema>;
export type EccInstallPreviewArtifact = z.infer<typeof ArtifactSchema>;

function operationKey(operation: ContingentEccInstallOperation): string {
  return [
    operation.target,
    operation.componentId,
    operation.kind,
    operation.destination,
    operation.source ?? "",
  ].join("\0");
}

export function parseEccInstallPreview(value: unknown): EccInstallPreviewArtifact {
  const artifact = ArtifactSchema.parse(value);
  const keys = new Set<string>();
  for (const operation of artifact.operations) {
    const key = operationKey(operation);
    if (keys.has(key)) {
      throw new AihError("ECC install preview contains a duplicate operation", "AIH_CONFIG");
    }
    keys.add(key);
  }
  return artifact;
}

export function readEccInstallPreview(): EccInstallPreviewArtifact {
  return structuredClone(
    parseEccInstallPreview(loadFrameworkDescriptorSectionV1("ecc", "installPreview")),
  );
}
