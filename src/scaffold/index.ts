import { posix } from "node:path";
import { CANON_OPTION, canonMode } from "../internals/canon-mode.js";
import { isTargeted } from "../internals/cli-detect.js";
import { aihIgnoreWrite } from "../internals/gitignore.js";
import type { Action, CommandSpec, PlanContext } from "../internals/plan.js";
import { doc, plan, writeJson, writeText } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { scanRepo } from "../profile/scan.js";
import { HOOKS_PATH_COMMAND, preCommitHook } from "./hooks.js";
import {
  architectureDoc,
  conventionsDoc,
  exampleSkillDoc,
  indexDoc,
  projectGuardrailsDoc,
  setupTasksDoc,
  tasksDoc,
  validationDoc,
} from "./templates.js";

/** Deny rules seeded into `.claude/settings.json` — keep secrets out of agent reach. */
const SETTINGS_DENY = ["Read(./.env*)", "Read(./secrets/**)"] as const;

/**
 * Scaffold the canonical context architecture for a repository: a tool-agnostic
 * context directory (INDEX + skeletons + an example skill), a `.claude/settings.json`
 * deny-list, and an opt-in pre-commit guardrail. Root bootloaders and the
 * `RULE_ROUTER` that point here are owned by `aih bootstrap-ai` (one writer per
 * file), so scaffold writes no adapters itself. Every path is relative to
 * `ctx.root`; the context dir name is `ctx.contextDir`, so a custom
 * `--context-dir ai-coding` lands content there. Pure planning — the executor
 * decides dry-run vs apply; nothing here writes or touches a remote system.
 */
function scaffoldPlan(ctx: PlanContext): ReturnType<typeof plan> {
  const dir = ctx.contextDir;
  const inDir = (...parts: string[]): string => posix.join(dir, ...parts);
  const legacy = canonMode(ctx) === "legacy";
  const actions: Action[] = [];

  // The full pre-contract doc family lands ONLY under `--canon legacy`. In compact
  // (the default) the repo CONTRACT replaces it: `aih contract` emits project.json +
  // project.md + setup.md, into which architecture/conventions fold and the rest
  // (INDEX/tasks/SETUP-TASKS/VALIDATION/project-guardrails/example-skill) retire. The
  // compiler never deletes, so legacy stays byte-identical for a team mid-migration.
  if (legacy) {
    // Populate the context from the real repo, not empty placeholders.
    const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
    actions.push(
      // 1. Canonical context directory. (Root bootloaders + RULE_ROUTER that point
      //    here are owned by `aih bootstrap-ai`, not scaffold — one writer per file.)
      writeText(inDir("INDEX.md"), indexDoc(dir), `${dir} routing index (write-once)`, {
        once: true,
      }),
      writeText(
        inDir("architecture.md"),
        architectureDoc(dir, stack),
        "architecture context (write-once; auto-populated from the detected stack)",
        { once: true },
      ),
      writeText(
        inDir("conventions.md"),
        conventionsDoc(dir, stack),
        "conventions context (write-once; seeded from the detected language/lint/test)",
        { once: true },
      ),
      writeText(inDir("tasks.md"), tasksDoc(dir), "active tasks/decisions ledger (write-once)", {
        once: true,
      }),
      writeText(
        inDir("skills", "example-skill", "SKILL.md"),
        exampleSkillDoc(),
        "example SKILL.md (write-once INDEX/SKILL pattern)",
        { once: true },
      ),
      // Agent-executable completion playbook — fill the skeletons from the code.
      writeText(
        inDir("SETUP-TASKS.md"),
        setupTasksDoc(dir, stack),
        "agent playbook: map context + enhance guardrails from the code",
      ),
      // Post-setup validation — agent checks the system + reports gaps/workarounds.
      writeText(
        inDir("VALIDATION.md"),
        validationDoc(dir, stack),
        "agent validation checklist → final user report (gaps to unblock + workarounds)",
      ),
      // Write-once guardrails seed the agent fleshes out (never overwritten).
      writeText(
        inDir("project-guardrails.md"),
        projectGuardrailsDoc(dir, stack),
        "project-specific guardrails seed (write-once; agent fills it)",
        { once: true },
      ),
    );
  }

  // 2. Repo hygiene: keep the harness's own backup/temp files out of git.
  actions.push(aihIgnoreWrite(ctx.root));

  // 3. Local guardrail: keep secrets out of the agent's read scope (merge, don't
  //    clobber). `.claude/settings.json` is Claude-specific — under `aih init` it
  //    lands only when Claude is a target (standalone `aih scaffold` always writes).
  if (isTargeted(ctx, "claude")) {
    actions.push(
      writeJson(
        posix.join(".claude", "settings.json"),
        { permissions: { deny: [...SETTINGS_DENY] } },
        "deny agent reads of .env / secrets in .claude/settings.json",
        { merge: true },
      ),
    );
  }

  actions.push(
    // 4. Local guardrail: pre-commit lint+test hook, opt-in via core.hooksPath.
    writeText(
      posix.join(".githooks", "pre-commit"),
      preCommitHook(),
      "pre-commit hook: runs the repo's lint/test scripts only if they exist",
      { mode: 0o755 },
    ),
    doc(
      "enable the pre-commit guardrail",
      lines(
        "Point git at the managed hooks directory (run once per clone):",
        "",
        `    ${HOOKS_PATH_COMMAND}`,
        "",
        "This is opt-in: the hook file is written, but git only uses it after you",
        "set core.hooksPath. Unset it any time with `git config --unset core.hooksPath`.",
      ),
    ),
  );

  return plan("scaffold", ...actions);
}

export const command: CommandSpec = {
  name: "scaffold",
  summary:
    "Scaffold repo hygiene + secret deny-list + pre-commit hook (and, under --canon legacy, the full context-doc family)",
  options: [CANON_OPTION],
  plan: scaffoldPlan,
};
