import { z } from "zod";
import type { BaselineCatalog } from "../../baseline-evidence/catalog.js";
import type { readVendorBaselineLock } from "../../baseline-evidence/vendor.js";
import {
  type PolicyAuthoringFramework,
  policyAuthoringAssetKind,
  policyAuthoringCurationKind,
  policyAuthoringPreferredSelectionSourcePath,
  policyAuthoringSelectionSourcePaths,
} from "../catalog-provider-types.js";
import snapshot from "../superpowers-content-metadata.snapshot.json";

type SourceSnapshot = ReturnType<typeof readVendorBaselineLock>["sources"][number];
const visibleText = z
  .string()
  .min(1)
  .max(2_000)
  .refine(
    (value) => !/\p{C}/u.test(value) && value === value.normalize("NFC") && value === value.trim(),
  );
const contentMetadata = z
  .object({
    version: z.literal(1),
    repository: z.literal("obra/Superpowers"),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    agents: z.tuple([]),
    skills: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
            title: visibleText,
            path: visibleText,
            summary: visibleText,
            usageContext: visibleText,
            allowedTools: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]*$/)).max(32),
            sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .parse(snapshot);
const metadataById = new Map<string, (typeof contentMetadata.skills)[number]>(
  contentMetadata.skills.map((entry) => {
    if (entry.path !== `skills/${entry.id}/SKILL.md`)
      throw new Error("Superpowers metadata path mismatch");
    return [`skill:${entry.id}`, entry] as const;
  }),
);
if (metadataById.size !== contentMetadata.skills.length)
  throw new Error("Duplicate Superpowers metadata");
export interface PrepareSuperpowersCatalogSourceV1Input {
  baseline: BaselineCatalog;
  sourceSnapshot: SourceSnapshot;
}

/** Direct, source-local Superpowers preparation from already-normalized pinned input. */
export function prepareSuperpowersCatalogSourceV1(
  input: PrepareSuperpowersCatalogSourceV1Input,
): PolicyAuthoringFramework {
  const { baseline, sourceSnapshot } = input;
  if (
    baseline.id !== "superpowers" ||
    baseline.owner !== sourceSnapshot.owner ||
    baseline.repo !== sourceSnapshot.repo ||
    baseline.pinnedSha !== sourceSnapshot.pinnedSha ||
    sourceSnapshot.id !== baseline.id
  )
    throw new Error("Superpowers baseline input does not match its vetted source snapshot");
  if (
    contentMetadata.commit !== baseline.pinnedSha ||
    contentMetadata.repository !== `${baseline.owner}/${baseline.repo}`
  )
    throw new Error("Superpowers content metadata does not match its pinned source");
  const vetted = new Map(sourceSnapshot.components.map((component) => [component.id, component]));
  const componentIds = new Set(baseline.components.map((component) => component.id));
  if ([...metadataById.keys()].some((id) => !componentIds.has(id)))
    throw new Error("Superpowers content metadata names an item outside its pinned catalog");
  return {
    id: "superpowers",
    repository: `${baseline.owner}/${baseline.repo}`,
    commit: baseline.pinnedSha,
    assets: baseline.components.map((component) => {
      const vet = vetted.get(component.id);
      const metadata = metadataById.get(component.id);
      if (component.id.startsWith("skill:") && metadata === undefined)
        throw new Error(`Superpowers ${component.id} has no source-authored metadata`);
      return {
        id: component.id,
        kind: policyAuthoringAssetKind(component.id),
        ...(metadata === undefined
          ? {}
          : {
              metadata: {
                title: metadata.title,
                summary: metadata.summary,
                usageContext: metadata.usageContext,
                allowedTools: metadata.allowedTools,
                sourcePath: metadata.path,
                sourceSha256: metadata.sourceSha256,
              },
            }),
        ...(policyAuthoringCurationKind(component.id) === undefined
          ? {}
          : { curationKind: policyAuthoringCurationKind(component.id) }),
        source: {
          repository: `${baseline.owner}/${baseline.repo}`,
          commit: baseline.pinnedSha,
          path: policyAuthoringPreferredSelectionSourcePath(component.id, component.paths) ?? "",
        },
        sourcePaths: policyAuthoringSelectionSourcePaths(component.id, component.paths),
        ...(vet === undefined
          ? {}
          : {
              vet: {
                verdict: vet.verdict,
                treeSha256: vet.treeSha256,
                analyzers: vet.analyzers.map((entry) => ({
                  name: entry.name,
                  version: entry.version,
                })),
                findings: vet.findings.map((entry) => ({
                  code: entry.code,
                  ...(typeof entry.count === "number" ? { count: entry.count } : {}),
                  detail: entry.detail,
                })),
              },
            }),
      };
    }),
  };
}
