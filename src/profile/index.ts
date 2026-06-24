import {
  type Action,
  type CommandSpec,
  type Plan,
  type PlanContext,
  plan,
  writeText,
} from "../internals/plan.js";
import { type RepoStack, scanRepo } from "./scan.js";
import {
  renderEfCoreMdc,
  renderNodeMdc,
  renderServerlessMdc,
  renderStackMdc,
} from "./templates.js";

/** Fallback recursion depth when `--max-depth` is absent or unparseable. */
const DEFAULT_MAX_DEPTH = 8;

function resolveMaxDepth(raw: unknown): number {
  const n = Number(raw ?? DEFAULT_MAX_DEPTH);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_DEPTH;
}

function isNode(stack: RepoStack): boolean {
  return stack.languages.some((l) => l.endsWith("/Node.js"));
}

/**
 * Profile the repository at `ctx.root` and synthesize Cursor stack rules tailored
 * to what the repo ACTUALLY is: a stack rule plus only the language/framework
 * rules that apply (Node JS-or-TS, Serverless/AWS, .NET). Root bootloaders
 * (`CLAUDE.md`, etc.) are NOT written here — they are owned by `aih bootstrap-ai`
 * (the Layer-2 canon), which carries the detected stack in its `RULE_ROUTER.md`.
 * Content is derived purely from detected signature files + the project's own
 * package.json, so a given tree always yields the same plan and never invents
 * commands or a language the repo doesn't use.
 */
function profilePlan(ctx: PlanContext): Plan {
  const stack = scanRepo(ctx.root, { maxDepth: resolveMaxDepth(ctx.options.maxDepth) });

  const actions: Action[] = [
    writeText(
      ".cursor/rules/01-stack.mdc",
      renderStackMdc(stack),
      "Cursor rule: detected stack and the repo's real build/test/lint commands",
    ),
  ];

  if (isNode(stack)) {
    actions.push(
      writeText(
        ".cursor/rules/02-node.mdc",
        renderNodeMdc(stack.hasTypeScript),
        `Cursor rule: ${stack.hasTypeScript ? "TypeScript" : "JavaScript"}/Node.js conventions`,
      ),
    );
  }

  if (stack.frameworks.includes("Serverless Framework") || stack.frameworks.includes("AWS SAM")) {
    actions.push(
      writeText(
        ".cursor/rules/03-serverless.mdc",
        renderServerlessMdc(stack),
        "Cursor rule: Serverless Framework / AWS Lambda conventions",
      ),
    );
  }

  if (stack.languages.includes(".NET")) {
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
  summary: "Profile the repository's stack and synthesize Cursor stack rules",
  options: [
    { flags: "--max-depth <n>", description: "max directory recursion depth", default: "8" },
  ],
  plan: profilePlan,
};
