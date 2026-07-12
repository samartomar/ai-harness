import { z } from "zod";
import { SettingsError } from "../errors.js";
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
      { owner: "samartomar", repo: "ECC", pinnedSha: "16563d4a30f17d097cc4629f6d97e02adf823016" },
      {
        owner: "obra",
        repo: "Superpowers",
        pinnedSha: "d884ae04edebef577e82ff7c4e143debd0bbec99",
      },
    ],
    installVerb: "`aih ecc` / `aih superpowers`",
  },
  {
    id: "gstack",
    label: "gstack",
    sources: [
      {
        owner: "garrytan",
        repo: "gstack",
        pinnedSha: "11de390be1be6849eb9a15f91ff4922dd16c589a",
      },
    ],
    installVerb: "the pinned garrytan/gstack install path",
  },
  {
    id: "gsd",
    label: "GSD",
    sources: [
      {
        owner: "open-gsd",
        repo: "gsd-core",
        pinnedSha: "8f2ebbe9bfbb98a1fc15cab36c3f6d5618eac341",
      },
    ],
    installVerb: "the pinned open-gsd/gsd-core install path",
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
