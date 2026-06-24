import {
  type CommandSpec,
  type Plan,
  type PlanContext,
  plan,
  writeText,
} from "../internals/plan.js";
import { scanRepo } from "./scan.js";
import {
  renderClaudeMd,
  renderEfCoreMdc,
  renderStackMdc,
  renderTypescriptMdc,
} from "./templates.js";

/** Fallback recursion depth when `--max-depth` is absent or unparseable. */
const DEFAULT_MAX_DEPTH = 8;

function resolveMaxDepth(raw: unknown): number {
  const n = Number(raw ?? DEFAULT_MAX_DEPTH);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_DEPTH;
}

/**
 * Profile the repository at `ctx.root` and synthesize tailored agent config:
 * a thin `CLAUDE.md` pointer and Cursor `.mdc` rules. All artifacts are local
 * writes (no remote mutation); content is derived purely from detected signature
 * files so a given tree always yields the same plan.
 */
function profilePlan(ctx: PlanContext): Plan {
  const stack = scanRepo(ctx.root, { maxDepth: resolveMaxDepth(ctx.options.maxDepth) });

  const actions = [
    writeText(
      "CLAUDE.md",
      renderClaudeMd(stack, ctx.contextDir),
      "Thin CLAUDE.md pointer routing agents to the canonical context dir",
    ),
    writeText(
      ".cursor/rules/01-stack.mdc",
      renderStackMdc(stack),
      "Cursor rule: detected stack and canonical build/test/lint commands",
    ),
  ];

  if (stack.languages.includes("TypeScript/Node.js")) {
    actions.push(
      writeText(
        ".cursor/rules/02-typescript.mdc",
        renderTypescriptMdc(),
        "Cursor rule: TypeScript/Node.js conventions",
      ),
    );
  }

  if (stack.languages.includes(".NET Core")) {
    actions.push(
      writeText(
        ".cursor/rules/03-efcore.mdc",
        renderEfCoreMdc(),
        "Cursor rule: EF Core async data-access rules",
      ),
    );
  }

  return plan("profile", ...actions);
}

export const command: CommandSpec = {
  name: "profile",
  summary: "Profile the repository's stack and synthesize CLAUDE.md + cursor rules",
  options: [
    { flags: "--max-depth <n>", description: "max directory recursion depth", default: "8" },
  ],
  plan: profilePlan,
};
