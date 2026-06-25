import { frontmatter, lines } from "../internals/render.js";
import type { RepoStack } from "./scan.js";

/**
 * Render the generated artifacts for a profiled repo. Deterministic string
 * builders (no dates, stable ordering) so golden-file tests stay stable. The
 * `.mdc` files carry stack-specific Cursor rules; root bootloaders are owned by
 * `aih bootstrap-ai`, not profile. Crucially, only facts/commands the repo
 * ACTUALLY has are emitted — no invented `vitest`/`lint` commands.
 */

function joinOr(values: string[], fallback: string): string {
  return values.length > 0 ? values.join(", ") : fallback;
}

/** The lines describing detected stack facets, omitting empty ones. */
function stackFacts(stack: RepoStack): string[] {
  const out = [`- Languages: ${joinOr(stack.languages, "none detected")}`];
  if (stack.frameworks.length > 0) out.push(`- Frameworks: ${stack.frameworks.join(", ")}`);
  if (stack.cloud.length > 0) out.push(`- Cloud: ${stack.cloud.join(", ")}`);
  if (stack.deployment.length > 0) out.push(`- Deployment: ${stack.deployment.join(", ")}`);
  if (stack.packageManager) out.push(`- Package manager: ${stack.packageManager}`);
  if (stack.isMonorepo) {
    out.push(`- Monorepo: ${stack.workspaceTool ?? "multiple packages"} workspace`);
  }
  return out;
}

/** Note appended for monorepos so a single root command isn't taken as authoritative per-package. */
function monorepoNote(stack: RepoStack): string {
  const tool = stack.workspaceTool ?? "multi-package";
  return `This is a ${tool} monorepo: the commands above run at the workspace root and fan out to packages; an individual package may define its own. Confirm the command for the package you are editing before relying on a single root command.`;
}

/** Command bullets — only commands the repo actually defines. */
function commandLines(stack: RepoStack, prefix: string): string[] {
  const out: string[] = [];
  if (stack.testRunner) out.push(`${prefix}Test: \`${stack.testRunner}\``);
  if (stack.buildCommand) out.push(`${prefix}Build: \`${stack.buildCommand}\``);
  if (stack.lintCommand) out.push(`${prefix}Lint: \`${stack.lintCommand}\``);
  if (out.length === 0) {
    out.push(`${prefix}No test/build/lint script is defined — add one before relying on it.`);
  }
  return out;
}

/** The primary Cursor rule: a stack summary plus the detected commands. */
export function renderStackMdc(stack: RepoStack): string {
  const fm = frontmatter({
    description: "Detected project stack and canonical build/test/lint commands.",
    globs: ["**/*"],
    alwaysApply: false,
  });
  return lines(
    fm,
    "",
    "# Stack",
    "",
    stackFacts(stack),
    "",
    "# Commands",
    "",
    commandLines(stack, "- Use "),
    stack.isMonorepo ? ["", monorepoNote(stack)] : [],
    "",
    "Prefer these exact commands over guessing equivalents. If a command is",
    "missing here, it is not configured in the repo — do not invent one.",
  );
}

/**
 * Node conventions rule — TypeScript or JavaScript flavored to match what the
 * repo actually is (`hasTypeScript`). Emitted by `aih profile` only for Node repos.
 */
export function renderNodeMdc(hasTypeScript: boolean): string {
  if (hasTypeScript) {
    return lines(
      frontmatter({
        description: "TypeScript / Node.js conventions for this repository.",
        globs: ["**/*.ts", "**/*.tsx"],
        alwaysApply: false,
      }),
      "",
      "# TypeScript",
      "",
      "- Add explicit parameter and return types to exported functions.",
      "- Avoid `any`; narrow `unknown` at boundaries with type guards or zod.",
      "- Use immutable updates (spread / new objects) instead of mutation.",
      "- Handle errors explicitly; never silently swallow a rejection.",
    );
  }
  return lines(
    frontmatter({
      description: "JavaScript / Node.js conventions for this repository.",
      globs: ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
      alwaysApply: false,
    }),
    "",
    "# JavaScript (Node.js)",
    "",
    "- This is a plain JavaScript project — do not add TypeScript syntax or a build step.",
    "- Use JSDoc type annotations where they aid clarity.",
    "- Prefer `const`/`let` and small pure functions; avoid mutating shared state.",
    "- Validate external input (events, request bodies) before use.",
    "- Handle promise rejections explicitly; never swallow errors.",
  );
}

/** Serverless / AWS Lambda guidance, emitted when the Serverless Framework / AWS is detected. */
export function renderServerlessMdc(stack: RepoStack): string {
  const cloud = stack.cloud.includes("AWS") ? "AWS" : (stack.cloud[0] ?? "the cloud provider");
  return lines(
    frontmatter({
      description: `Serverless Framework / ${cloud} Lambda conventions for this repository.`,
      globs: ["serverless.yml", "serverless.yaml", "src/**/*.js", "src/**/*.ts"],
      alwaysApply: false,
    }),
    "",
    "# Serverless / Lambda",
    "",
    "- Handlers must stay thin: validate the event, delegate to a service, return a typed response.",
    "- Read configuration and table/bucket names from environment variables, never hardcode ARNs.",
    `- Deploy with the Serverless Framework (\`npx serverless deploy\`); never mutate ${cloud} resources by hand.`,
    "- Reuse SDK clients across invocations (module scope), not per-request.",
    "- Scope IAM to least privilege per function in `serverless.yml`.",
  );
}

/**
 * EF Core async rules, emitted only when a .NET stack is detected. Mirrors the
 * canonical guidance: async DB access, no sync-over-async, `AsNoTracking` reads.
 */
export function renderEfCoreMdc(): string {
  return lines(
    frontmatter({
      description: "Entity Framework Core async data-access rules for .NET code.",
      globs: ["**/*.cs"],
      alwaysApply: false,
    }),
    "",
    "# EF Core async",
    "",
    "- Use the async APIs (`ToListAsync`, `FirstOrDefaultAsync`, `SaveChangesAsync`).",
    "- Never block on a Task with `.Result` or `.Wait()` (no sync-over-async).",
    "- Use `AsNoTracking()` for read-only queries.",
    "- Pass a `CancellationToken` through async data-access methods.",
  );
}
