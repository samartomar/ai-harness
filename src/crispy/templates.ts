/**
 * Deterministic content for the CRISPY workspace. Every template flows through
 * `render` helpers so golden tests stay stable (no dates, fixed ordering, single
 * trailing newline). Per the blueprint's "Under-40" rule, each stage template
 * embeds FEWER than 40 instruction bullets — a tight, high-signal checklist beats
 * an exhaustive one that dilutes the model's attention.
 */
import { lines } from "../internals/render.js";
import { STAGES, type Stage } from "./stages.js";

/** Hard ceiling on instruction bullets per stage template (blueprint Under-40). */
export const MAX_BULLETS = 40;

/** Superpowers / ECC plugin install commands — emitted as a doc, never executed. */
export const INSTALL_COMMANDS: readonly string[] = [
  "claude /plugin marketplace add obra/superpowers-marketplace",
  "claude /plugin install superpowers@claude-plugins-official",
] as const;

/**
 * Per-stage instruction bullets (no leading "- "; the renderer adds it). Kept
 * deliberately short — well under {@link MAX_BULLETS} — so the checklist stays a
 * checklist, not a wall of prose.
 */
const STAGE_BULLETS: Record<string, readonly string[]> = {
  context: [
    "Map the repo: entrypoints, modules, and the boundary you must not cross.",
    "State the goal in one sentence and the hard constraints beneath it.",
    "List the nearest peer files; their conventions are the spec.",
    "Capture the inputs, outputs, and invariants the change must preserve.",
    "Note what is explicitly OUT of scope for this work.",
  ],
  research: [
    "Search existing implementations before writing anything new.",
    "Pull primary docs for every library or API you will touch.",
    "Record reusable patterns, gotchas, and version-specific details.",
    "Prefer adopting a proven approach over net-new code.",
    "Cite each finding so the next stage can trust it.",
  ],
  iterate: [
    "Sketch two or three approaches; do not commit yet.",
    "Pressure-test each against the constraints from `context`.",
    "Kill the weakest option early and say why.",
    "Keep the surviving approach small and reversible.",
    "Write down the open questions the next stage must close.",
  ],
  structure: [
    "Name the modules and files the change introduces or touches.",
    "Define the types and the data flow between them.",
    "Mark the seams: what is pure, what does I/O, what is a boundary.",
    "Keep files focused; extract helpers before they grow large.",
    "Show how the shape stays faithful to the peer conventions.",
  ],
  plan: [
    "Break the work into ordered, independently verifiable steps.",
    "Attach a checkpoint (test or command) to each step.",
    "Front-load the riskiest step so failure surfaces early.",
    "Flag dependencies between steps explicitly.",
    "Define done: the exact checks that must be green.",
  ],
  synthesize: [
    "Fold research, structure, and plan into one coherent brief.",
    "Resolve every contradiction between the prior artifacts.",
    "Restate the final approach and the acceptance checks.",
    "Confirm nothing crosses the boundary set in `context`.",
    "Hand the implementer a brief that needs no back-reference.",
  ],
  implement: [
    "Execute the synthesized brief step by step.",
    "Run each step's checkpoint before moving on.",
    "Diff your output against the peer files and conventions.",
    "Report ship-list, skipped-list, and unverified-list.",
    "Stop at the boundary; leave remote/cloud steps as docs.",
  ],
};

/** Render one bullet list, prefixing each item with "- ". */
function bulletList(items: readonly string[]): string {
  return items.map((b) => `- ${b}`).join("\n");
}

/**
 * The markdown artifact for a stage: a titled header, its purpose, a short
 * instruction checklist, and a working-notes section the human fills in. The
 * embedded checklist is guaranteed `< MAX_BULLETS` lines.
 */
export function stageTemplate(stage: Stage): string {
  const bullets = STAGE_BULLETS[stage.name] ?? [];
  return lines(
    `# CRISPY — ${stage.name}`,
    "",
    `> ${stage.purpose}`,
    "",
    "## Instructions",
    "",
    bulletList(bullets),
    "",
    "## Working notes",
    "",
    "<!-- Fill this in as you complete the stage; the next stage reads it. -->",
  );
}

/** Count the instruction bullets a stage template embeds (for the Under-40 guard). */
export function bulletCount(stageName: string): number {
  return (STAGE_BULLETS[stageName] ?? []).length;
}

/** The workspace README: explains CRISPY and the stage-gate to a human. */
export function readmeTemplate(): string {
  const rows = STAGES.map((s) => `- \`${s.artifact}\` — **${s.name}**: ${s.purpose}`);
  return lines(
    "# CRISPY workspace",
    "",
    "CRISPY is a deterministic context-engineering loop. Each stage writes one",
    "markdown artifact here; control flow lives in `aih crispy`, not in prompts.",
    "",
    "## Stages",
    "",
    rows,
    "",
    "## Stage gate",
    "",
    "Stages advance in order. `aih crispy --stage <name>` only writes a stage's",
    "artifact once the PRIOR stage's artifact exists, so the chain can never skip",
    "ahead. Run `aih crispy --stage context` first, then walk forward.",
    "",
    "## Authoring rule",
    "",
    "Keep each stage's instruction list short — under 40 bullets. A tight checklist",
    "carries more signal than an exhaustive one.",
  );
}

/** Render the STATE.md stage tracker. `done` marks which artifacts already exist. */
export function stateTemplate(done: ReadonlySet<string> = new Set()): string {
  const rows = STAGES.map((s, i) => {
    const mark = done.has(s.name) ? "x" : " ";
    return `- [${mark}] ${i + 1}. ${s.name} — \`${s.artifact}\``;
  });
  return lines(
    "# CRISPY state",
    "",
    "Stage tracker. A checked box means the stage's artifact has been written.",
    "",
    rows,
  );
}

/** The install-commands doc body (Superpowers / ECC orchestration), for a human. */
export function installDocText(): string {
  return lines(
    "Install the Superpowers / ECC orchestration plugins (run these yourself):",
    "",
    bulletList(INSTALL_COMMANDS),
    "",
    "These wire up the agent orchestration layer that drives the CRISPY stages.",
    "aih emits them as guidance and never runs them for you.",
  );
}
