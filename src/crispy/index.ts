import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import {
  type Action,
  type CommandSpec,
  doc,
  type PlanContext,
  plan,
  writeText,
} from "../internals/plan.js";
import { findStage, priorStage, STAGES, type Stage } from "./stages.js";
import { installDocText, readmeTemplate, stageTemplate, stateTemplate } from "./templates.js";

/** POSIX-style repo-relative path (forward slashes) for a file in the workspace. */
function workspaceRelPath(ctx: PlanContext, file: string): string {
  return `${ctx.contextDir}/crispy/${file}`;
}

/** Absolute path used only for gate checks via `readIfExists` (never for writes). */
function workspaceAbsPath(ctx: PlanContext, file: string): string {
  return join(ctx.root, ctx.contextDir, "crispy", file);
}

/** Which stages already have their artifact on disk (drives the STATE tracker). */
function completedStages(ctx: PlanContext): Set<string> {
  const done = new Set<string>();
  for (const s of STAGES) {
    if (readIfExists(workspaceAbsPath(ctx, s.artifact)) !== undefined) {
      done.add(s.name);
    }
  }
  return done;
}

/** `--init`: scaffold the workspace (README + empty STATE tracker) and install doc. */
function initPlan(ctx: PlanContext) {
  const done = completedStages(ctx);
  return plan(
    "crispy",
    writeText(
      workspaceRelPath(ctx, "README.md"),
      readmeTemplate(),
      "explain the CRISPY framework and stage gate",
    ),
    writeText(
      workspaceRelPath(ctx, "STATE.md"),
      stateTemplate(done),
      "initialize the CRISPY stage tracker",
    ),
    doc("install Superpowers / ECC orchestration plugins", installDocText()),
  );
}

/** A `doc` listing every stage — shown when no/unknown `--stage` was given. */
function stageListDoc(): Action {
  const rows = STAGES.map((s, i) => `${i + 1}. ${s.name} — ${s.purpose}`);
  const text = [
    "Pick a stage with --stage <name>. Stages run in order:",
    "",
    ...rows,
    "",
    "Run `aih crispy --init` first to scaffold the workspace.",
  ].join("\n");
  return doc("list the CRISPY stages", text);
}

/** The gate `doc` emitted when the prior stage's artifact is missing. */
function gateDoc(stage: Stage, prev: Stage): Action {
  return doc(
    `gate: complete \`${prev.name}\` before \`${stage.name}\``,
    `gate: complete \`${prev.name}\` first — ${stage.name} needs \`${prev.artifact}\` to exist.`,
  );
}

/**
 * Advance one stage: when the gate is satisfied, write the stage artifact and the
 * refreshed STATE tracker; always emit the install-commands doc. The new
 * artifact is reflected in the tracker by adding the current stage to `done`.
 */
function advancePlan(ctx: PlanContext, stage: Stage) {
  const done = completedStages(ctx);
  done.add(stage.name);
  return plan(
    "crispy",
    writeText(
      workspaceRelPath(ctx, stage.artifact),
      stageTemplate(stage),
      `write the CRISPY ${stage.name} artifact`,
    ),
    writeText(
      workspaceRelPath(ctx, "STATE.md"),
      stateTemplate(done),
      `mark the CRISPY ${stage.name} stage complete`,
    ),
    doc("install Superpowers / ECC orchestration plugins", installDocText()),
  );
}

/**
 * The CRISPY stage machine. Deterministic control flow in code: `--init`
 * scaffolds the workspace; otherwise `--stage` advances one step, gated on the
 * prior stage's artifact existing. Cloud/orchestration setup is emitted as a doc,
 * never run — the plan only ever writes local markdown.
 */
function crispyPlan(ctx: PlanContext) {
  if (ctx.options.init) {
    return initPlan(ctx);
  }

  const requested = String(ctx.options.stage ?? "");
  const stage = findStage(requested);
  if (!stage) {
    return plan("crispy", stageListDoc());
  }

  const prev = priorStage(stage.name);
  if (prev && readIfExists(workspaceAbsPath(ctx, prev.artifact)) === undefined) {
    return plan("crispy", gateDoc(stage, prev));
  }

  return advancePlan(ctx, stage);
}

export const command: CommandSpec = {
  name: "crispy",
  summary: "Run the CRISPY context-engineering stage machine (deterministic fs transactions)",
  options: [
    {
      flags: "--stage <stage>",
      description: "context|research|iterate|structure|plan|synthesize|implement",
    },
    { flags: "--init", description: "initialize the CRISPY workspace under the context dir" },
  ],
  plan: crispyPlan,
};
