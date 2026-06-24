import { posix } from "node:path";
import { resolveClis } from "../internals/clis.js";
import type { Action, CommandSpec, PlanContext } from "../internals/plan.js";
import { doc, plan, writeJson, writeText } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { scanRepo } from "../profile/scan.js";
import { adaptersForClis } from "./adapters.js";
import { HOOKS_PATH_COMMAND, preCommitHook } from "./hooks.js";
import {
  architectureDoc,
  conventionsDoc,
  exampleSkillDoc,
  indexDoc,
  tasksDoc,
} from "./templates.js";

/** Deny rules seeded into `.claude/settings.json` — keep secrets out of agent reach. */
const SETTINGS_DENY = ["Read(./.env*)", "Read(./secrets/**)"] as const;

/**
 * Scaffold the canonical context architecture for a repository: a tool-agnostic
 * context directory (INDEX + skeletons + an example skill), thin pointer adapters
 * for every IDE/agent, a `.claude/settings.json` deny-list, and an opt-in
 * pre-commit guardrail. Every path is relative to `ctx.root`; the context dir
 * name is `ctx.contextDir`, so a custom `--context-dir ai-coding` lands content
 * (and every pointer) there. Pure planning — the executor decides dry-run vs
 * apply; nothing here writes or touches a remote system.
 */
function scaffoldPlan(ctx: PlanContext): ReturnType<typeof plan> {
  const dir = ctx.contextDir;
  const inDir = (...parts: string[]): string => posix.join(dir, ...parts);
  // Populate the context from the real repo, not empty placeholders.
  const stack = scanRepo(ctx.root, { maxDepth: 8 });
  // Only emit adapters for the CLIs the user targets (default: Claude Code).
  const clis = resolveClis(ctx.options);

  const actions: Action[] = [
    // 1. Canonical context directory.
    writeText(inDir("INDEX.md"), indexDoc(dir), `${dir} routing index (load order)`),
    writeText(
      inDir("architecture.md"),
      architectureDoc(dir, stack),
      "architecture context (auto-populated from the detected stack)",
    ),
    writeText(
      inDir("conventions.md"),
      conventionsDoc(dir, stack),
      "conventions context (seeded from the detected language/lint/test)",
    ),
    writeText(inDir("tasks.md"), tasksDoc(dir), "active tasks/decisions skeleton"),
    writeText(
      inDir("skills", "example-skill", "SKILL.md"),
      exampleSkillDoc(),
      "example SKILL.md (INDEX/SKILL pattern)",
    ),
  ];

  // 2. Thin IDE/agent adapters — pointers back to the context dir (<30 lines each),
  //    one per selected CLI (deduped: codex/antigravity/opencode/zed/kimi share AGENTS.md).
  for (const a of adaptersForClis(clis, dir)) {
    actions.push(writeText(a.path, a.contents, a.describe));
  }

  actions.push(
    // 3. Local guardrail: keep secrets out of the agent's read scope (merge, don't clobber).
    writeJson(
      posix.join(".claude", "settings.json"),
      { permissions: { deny: [...SETTINGS_DENY] } },
      "deny agent reads of .env / secrets in .claude/settings.json",
      { merge: true },
    ),

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
  summary: "Scaffold the canonical context dir, INDEX/SKILL docs and thin IDE adapters",
  options: [],
  plan: scaffoldPlan,
};
