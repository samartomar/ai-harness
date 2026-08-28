import { z } from "zod";
import { SettingsError } from "../errors.js";
import { isLegacyGstackId, LEGACY_GSTACK_MIGRATION_DIAGNOSTIC } from "./legacy-config.js";
import type { CommandOption } from "./plan.js";

export interface BaselineRepoSource {
  owner: string;
  repo: string;
  pinnedSha: string;
}

export interface BaselineSource {
  id: string;
  label: string;
  sources: readonly BaselineRepoSource[];
  installVerb: string;
}

export const DEFAULT_BASELINE_SOURCE_ID = "ecc";

export const BASELINE_SOURCES = [
  {
    id: "ecc",
    label: "ECC + Superpowers",
    sources: [
      {
        owner: "samartomar",
        repo: "ECC",
        pinnedSha: "5caf398a91599029a176ca6d806409b00d1052c4",
      },
      {
        owner: "obra",
        repo: "Superpowers",
        pinnedSha: "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9",
      },
    ],
    installVerb: "`aih ecc` / `aih superpowers`",
  },
] as const satisfies readonly BaselineSource[];

export type BaselineSourceId = (typeof BASELINE_SOURCES)[number]["id"];

const BASELINE_SOURCE_IDS = BASELINE_SOURCES.map((s) => s.id) as [
  BaselineSourceId,
  ...BaselineSourceId[],
];

export function baselineSourceIds(sources: readonly BaselineSource[] = BASELINE_SOURCES): string[] {
  return sources.map((s) => s.id);
}

export function isBaselineSourceId(value: unknown): value is BaselineSourceId {
  return typeof value === "string" && BASELINE_SOURCE_IDS.includes(value as BaselineSourceId);
}

export const BaselineSourceIdSchema = z.enum(BASELINE_SOURCE_IDS);

export const BASELINE_OPTION: CommandOption = {
  flags: "--baseline <id>",
  description: `Layer-1 canon baseline: ${baselineSourceIds().join("|")} (default ecc)`,
};

export function resolveBaselineSource(
  options: Record<string, unknown>,
  persisted?: unknown,
): (typeof BASELINE_SOURCES)[number] {
  const raw = options.baseline ?? persisted ?? DEFAULT_BASELINE_SOURCE_ID;
  if (isBaselineSourceId(raw)) {
    return BASELINE_SOURCES.find((s) => s.id === raw) ?? BASELINE_SOURCES[0];
  }
  if (isLegacyGstackId(raw)) {
    throw new SettingsError(LEGACY_GSTACK_MIGRATION_DIAGNOSTIC);
  }
  throw new SettingsError(
    `unknown --baseline ${JSON.stringify(raw)}; expected one of: ${baselineSourceIds().join("|")}`,
  );
}

export function describeBaselineSource(source: BaselineSource): string {
  return source.sources
    .map((repo) => `${repo.owner}/${repo.repo}@${repo.pinnedSha.slice(0, 12)}`)
    .join(" + ");
}

export function baselineRepoRefs(source: BaselineSource): string {
  return source.sources.map((repo) => `${repo.owner}/${repo.repo}`).join(" + ");
}
