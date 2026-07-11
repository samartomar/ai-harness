import { z } from "zod";
import type { BaselineCatalog } from "../baseline-evidence/catalog.js";
import shippedPreview from "../baseline-evidence/ecc-install-preview.json";
import { AihError } from "../errors.js";
import { type Cli, SUPPORTED_CLIS } from "../internals/clis.js";
import { digest, type Plan, plan } from "../internals/plan.js";
import type { EccComponentSelection } from "./components.js";

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

function physicalOperationKey(operation: ContingentEccInstallOperation): string {
  return [operation.kind, operation.destination, operation.source ?? ""].join("\0");
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
  return structuredClone(parseEccInstallPreview(shippedPreview));
}

function assertBoundToCatalog(artifact: EccInstallPreviewArtifact, catalog: BaselineCatalog): void {
  if (
    artifact.source.owner !== catalog.owner ||
    artifact.source.repo !== catalog.repo ||
    artifact.source.pinnedSha !== catalog.pinnedSha
  ) {
    throw new AihError(
      `shipped ECC install preview does not bind ${catalog.owner}/${catalog.repo}@${catalog.pinnedSha}`,
      "AIH_CONFIG",
    );
  }
}

function selectedComponentIds(
  selection: EccComponentSelection | undefined,
): Set<string> | undefined {
  if (selection === undefined || selection.scope === "full") return undefined;
  return new Set([...selection.components, ...selection.mcps]);
}

export function contingentEccInstallPreviewPlan(input: {
  artifact?: EccInstallPreviewArtifact;
  catalog: BaselineCatalog;
  clis: readonly Cli[];
  selection?: EccComponentSelection;
  runtimeComponentIds?: readonly string[];
}): Plan {
  const artifact = parseEccInstallPreview(input.artifact ?? readEccInstallPreview());
  assertBoundToCatalog(artifact, input.catalog);
  const targets = new Set(input.clis);
  const components = selectedComponentIds(input.selection);
  for (const component of input.runtimeComponentIds ?? []) components?.add(component);
  const selectedOperations = artifact.operations
    .filter(
      (operation) =>
        targets.has(operation.target) &&
        (components === undefined || components.has(operation.componentId)),
    )
    .sort((left, right) => operationKey(left).localeCompare(operationKey(right)));
  const physicalOperations = new Map<string, ContingentEccInstallOperation>();
  for (const operation of selectedOperations) {
    const key = physicalOperationKey(operation);
    if (!physicalOperations.has(key)) physicalOperations.set(key, operation);
  }
  const operations = [...physicalOperations.values()].sort((left, right) =>
    operationKey(left).localeCompare(operationKey(right)),
  );
  const text = [
    `Contingent on evidence authorization for ${artifact.source.owner}/${artifact.source.repo}@${artifact.source.pinnedSha}.`,
    ...operations.map(
      (operation) =>
        `- ${operation.target} · ${operation.componentId} · ${operation.kind} · ${operation.source ?? "(generated)"} -> ${operation.destination}`,
    ),
  ].join("\n");
  return plan(
    "ecc: contingent install preview",
    digest("contingent ECC install preview", text, {
      contingentOn: "evidence-authorization",
      pinnedSha: artifact.source.pinnedSha,
      operations,
    }),
  );
}
