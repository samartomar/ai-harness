import type { PlanContext } from "../internals/plan.js";
import { missingProjectionParts, sameJson } from "../org-policy/drift.js";
import { scanRepo } from "../profile/scan.js";
import { LARGE_REPO_FILE_THRESHOLD, trackedFileCount } from "../scale-safety.js";
import { PROJECT_CONTRACT_FILE, type ProjectContract, type ScaleClass } from "./schema.js";
import { synthesizeContract } from "./synth.js";

type ContractCommandFacts = ProjectContract["commands"];

interface ContractFactsSubset {
  commands: ContractCommandFacts;
  scale: { class: ScaleClass; isMonorepo: boolean };
  entrypoints: string[];
  languages: string[];
  frameworks: string[];
  cloud: string[];
  databases: string[];
  deployment: string[];
  packageManager?: string;
  sensitivePaths: string[];
  workspaces?: unknown;
}

export type ContractFreshness =
  | { status: "fresh"; fields: string[] }
  | { status: "stale"; fields: string[] }
  | { status: "deferred"; fields: string[]; trackedFiles: number };

function factsSubset(contract: ProjectContract): ContractFactsSubset {
  const maybeFuture = contract as ProjectContract & { workspaces?: unknown };
  return {
    commands: contract.commands,
    scale: { class: contract.scale.class, isMonorepo: contract.scale.isMonorepo },
    entrypoints: contract.entrypoints,
    languages: contract.languages,
    frameworks: contract.frameworks,
    cloud: contract.cloud,
    databases: contract.databases,
    deployment: contract.deployment,
    ...(contract.packageManager !== undefined ? { packageManager: contract.packageManager } : {}),
    sensitivePaths: contract.sensitivePaths,
    ...(maybeFuture.workspaces !== undefined ? { workspaces: maybeFuture.workspaces } : {}),
  };
}

function fieldFromDiff(diff: string): string {
  const marker = diff.match(/^(.*?)(?: missing| expected )/);
  return marker?.[1] ?? diff;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function contractStaleFields(committed: ProjectContract, fresh: ProjectContract): string[] {
  const actual = factsSubset(committed);
  const expected = factsSubset(fresh);
  if (sameJson(actual, expected)) return [];

  const diffs = [
    ...missingProjectionParts(actual, expected),
    ...missingProjectionParts(expected, actual),
  ];
  return uniqueSorted(diffs.map(fieldFromDiff));
}

export async function contractFreshness(
  ctx: PlanContext,
  contextDir: string,
  committed: ProjectContract,
): Promise<ContractFreshness> {
  const live = await trackedFileCount(ctx);
  if (live !== undefined && live >= LARGE_REPO_FILE_THRESHOLD) {
    return { status: "deferred", fields: [], trackedFiles: live };
  }

  const scanCtx = { ...ctx, contextDir };
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir });
  const fields = contractStaleFields(committed, await synthesizeContract(scanCtx, stack));
  return fields.length > 0 ? { status: "stale", fields } : { status: "fresh", fields: [] };
}

export function contractStaleDetail(contextDir: string, fields: readonly string[]): string {
  const shown = fields.slice(0, 8).join(", ");
  const more = fields.length > 8 ? `, +${fields.length - 8} more` : "";
  return `contract drifted from the live repo: ${shown}${more} in ${contextDir}/${PROJECT_CONTRACT_FILE} - re-run \`aih contract --apply\``;
}
