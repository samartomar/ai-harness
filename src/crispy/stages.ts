/**
 * The CRISPY framework: seven ordered context-engineering stages. Control flow is
 * deterministic and lives in code (not prompts) — `plan()` walks this list, gates
 * each stage on the prior artifact, and writes one markdown file per stage under
 * `${contextDir}/crispy/`. The ordinal prefix (`1-context.md`, …) keeps the
 * directory self-sorting and makes the gate dependency obvious on disk.
 */
export interface Stage {
  /** Stage key, also the `--stage` flag value. */
  readonly name: string;
  /** One-line purpose, embedded at the top of the artifact and in the index. */
  readonly purpose: string;
  /** Artifact filename written under `${contextDir}/crispy/` (ordinal-prefixed). */
  readonly artifact: string;
}

/**
 * Ordered CRISPY stages. The order IS the stage-gate: advancing to `STAGES[i]`
 * requires `STAGES[i-1].artifact` to already exist on disk.
 */
export const STAGES: readonly Stage[] = [
  {
    name: "context",
    purpose: "Gather the canonical context: repo map, constraints, and the boundary.",
    artifact: "1-context.md",
  },
  {
    name: "research",
    purpose: "Survey prior art, docs, and reusable implementations before writing.",
    artifact: "2-research.md",
  },
  {
    name: "iterate",
    purpose: "Refine the framing through cheap rounds; discard dead ends early.",
    artifact: "3-iterate.md",
  },
  {
    name: "structure",
    purpose: "Shape the solution: modules, types, data flow, and seams.",
    artifact: "4-structure.md",
  },
  {
    name: "plan",
    purpose: "Sequence the work into ordered, verifiable steps with checkpoints.",
    artifact: "5-plan.md",
  },
  {
    name: "synthesize",
    purpose: "Converge research, structure, and plan into one coherent brief.",
    artifact: "6-synthesize.md",
  },
  {
    name: "implement",
    purpose: "Execute the synthesized brief and verify against the checkpoints.",
    artifact: "7-implement.md",
  },
] as const;

/** Look up a stage by name (the `--stage` value), or `undefined` if unknown. */
export function findStage(name: string): Stage | undefined {
  return STAGES.find((s) => s.name === name);
}

/** Zero-based index of a stage in {@link STAGES}, or `-1` if not found. */
export function stageIndex(name: string): number {
  return STAGES.findIndex((s) => s.name === name);
}

/** The stage that must be completed before `name`, or `undefined` for the first stage. */
export function priorStage(name: string): Stage | undefined {
  const i = stageIndex(name);
  return i > 0 ? STAGES[i - 1] : undefined;
}
