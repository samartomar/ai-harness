import { lines } from "../internals/render.js";
import type { ProjectContract } from "./schema.js";

/**
 * The human mirror of `project.json` and the first-run setup seed. Both render
 * PURELY from the {@link ProjectContract} object (never re-scanning), through
 * {@link lines} so output stays byte-stable. `project.md` is FACTS ONLY — it carries
 * no working agreement / coding-convention prose (those live in the agent canon, one
 * canonical home); it is regenerated each run. `setup.md` is a write-once team seed.
 */

const CONFIDENCE_NOTE =
  "_`inferred` = derived from the stack, not declared in the repo — confirm before relying on it._";

/** Stack facts, omitting empty dimensions (no "none" filler rows except for languages). */
function stackBlock(c: ProjectContract): string[] {
  const out = [`- Languages: ${c.languages.length > 0 ? c.languages.join(", ") : "none detected"}`];
  if (c.frameworks.length > 0) out.push(`- Frameworks: ${c.frameworks.join(", ")}`);
  if (c.cloud.length > 0) out.push(`- Cloud: ${c.cloud.join(", ")}`);
  if (c.databases.length > 0) out.push(`- Databases: ${c.databases.join(", ")}`);
  if (c.deployment.length > 0) out.push(`- Deployment: ${c.deployment.join(", ")}`);
  if (c.packageManager) out.push(`- Package manager: ${c.packageManager}`);
  return out;
}

/** One row per detected command, value verbatim from the contract + its confidence tier. */
function commandsBlock(c: ProjectContract): string[] {
  const rows: string[] = [];
  const slots: Array<[string, ProjectContract["commands"]["test"]]> = [
    ["verify (completion gate)", c.commands.verify],
    ["typecheck", c.commands.typecheck],
    ["test", c.commands.test],
    ["build", c.commands.build],
    ["lint", c.commands.lint],
    ["start", c.commands.start],
    ["cdk synth", c.commands.cdkSynth],
    ["cdk diff", c.commands.cdkDiff],
  ];
  for (const [name, cmd] of slots) {
    if (cmd) rows.push(`- **${name}** — \`${cmd.value}\` _(${cmd.confidence})_`);
  }
  return rows.length > 0 ? rows : ["_No commands detected in the repo._"];
}

function externalActionsBlock(c: ProjectContract): string[] {
  if (!c.commands.cdkDeploy) return [];
  return [
    "### External actions (human approval required)",
    "",
    `- \`${c.commands.cdkDeploy.value}\` deploys live infrastructure; do not run to verify _(${c.commands.cdkDeploy.confidence})_`,
  ];
}

function workspaceCommandsBlock(c: ProjectContract): string[] {
  const rows: string[] = [];
  for (const [path, workspace] of Object.entries(c.workspaces ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const slots: Array<[string, ProjectContract["commands"]["test"]]> = [
      ["verify", workspace.commands.verify],
      ["typecheck", workspace.commands.typecheck],
      ["test", workspace.commands.test],
      ["build", workspace.commands.build],
      ["lint", workspace.commands.lint],
      ["start", workspace.commands.start],
    ];
    for (const [name, cmd] of slots) {
      if (cmd) rows.push(`- \`${path}\` **${name}** — \`${cmd.value}\` _(${cmd.confidence})_`);
    }
  }
  return rows;
}

function scaleLine(c: ProjectContract): string {
  if (c.scale.trackedFiles === undefined) return "- Scale: unknown (not a git repo).";
  const mono = c.scale.isMonorepo ? " · monorepo" : "";
  return `- ${c.scale.trackedFiles} tracked files · ${c.scale.class}${mono}`;
}

/** A backticked path list, or a single italic "none" line. */
function pathsOrNone(items: string[]): string[] {
  return items.length > 0 ? items.map((p) => `- \`${p}\``) : ["_None detected._"];
}

function mcpServersBlock(c: ProjectContract): string[] {
  return c.mcpServers.length > 0
    ? c.mcpServers.map((server) => `- \`${server}\``)
    : ["_No root `.mcp.json` servers detected._"];
}

function installCommand(packageManager: string | undefined): string | undefined {
  if (packageManager === undefined) return undefined;
  const commands: Record<string, string> = {
    npm: "npm install",
    pnpm: "pnpm install",
    yarn: "yarn install",
    bun: "bun install",
    poetry: "poetry install",
    uv: "uv sync",
    pip: "python -m pip install -r requirements.txt",
    pipenv: "pipenv install --dev",
    cargo: "cargo fetch",
  };
  return commands[packageManager] ?? `${packageManager} install`;
}

function mcpToolingBlock(c: ProjectContract): string[] {
  const detected =
    c.mcpServers.length > 0
      ? [
          "- Detected root `.mcp.json` servers:",
          ...c.mcpServers.map((server) => `  - \`${server}\``),
        ]
      : ["- No root `.mcp.json` servers detected yet."];
  return [
    "## 3. MCP and AI tooling",
    "",
    "- Review and apply the repo AI tooling surface: `aih init --apply`.",
    ...detected,
  ];
}

/**
 * The human-readable contract mirror. Regenerated from `project.json` every run, so the
 * header warns against hand-editing. Facts only — the working agreement is referenced,
 * never duplicated (locked decision #5; agent-behavior §6).
 */
export function projectContractDoc(dir: string, c: ProjectContract): string {
  const workspaceRows = workspaceCommandsBlock(c);
  const workspaceCommands = Object.values(c.workspaces ?? {}).flatMap((workspace) => [
    workspace.commands.test,
    workspace.commands.build,
    workspace.commands.lint,
    workspace.commands.start,
  ]);
  const hasInferred = [
    c.commands.test,
    c.commands.build,
    c.commands.lint,
    c.commands.start,
    c.commands.verify,
    c.commands.typecheck,
    c.commands.cdkSynth,
    c.commands.cdkDiff,
    c.commands.cdkDeploy,
    ...workspaceCommands,
  ].some((cmd) => cmd?.confidence === "inferred");
  return lines(
    "# Repo contract",
    "",
    `> Facts about how this repo is built and run — rendered from \`${dir}/project.json\`.`,
    "> Do not hand-edit; re-run `aih contract` to refresh. Working agreements live in the",
    "> agent canon (`RULE_ROUTER.md` → ECC / Superpowers), not here.",
    ...(c.description ? ["", c.description] : []),
    "",
    "## Stack",
    "",
    stackBlock(c),
    "",
    "## Commands",
    "",
    commandsBlock(c),
    ...(c.commands.cdkDeploy ? ["", externalActionsBlock(c)] : []),
    ...(workspaceRows.length > 0 ? ["", "### Workspace commands", "", workspaceRows] : []),
    ...(hasInferred ? ["", CONFIDENCE_NOTE] : []),
    "",
    "## Scale",
    "",
    scaleLine(c),
    "",
    "## Entry points",
    "",
    pathsOrNone(c.entrypoints),
    "",
    "## MCP servers",
    "",
    mcpServersBlock(c),
    "",
    "## Sensitive paths",
    "",
    "_Never read or log these — `aih` denies agent reads of them._",
    "",
    pathsOrNone(c.sensitivePaths),
    "",
    "## Known gaps",
    "",
    c.knownGaps.length > 0 ? c.knownGaps.map((g) => `- ${g}`) : ["_None — the contract is clean._"],
  );
}

/**
 * The first-run setup seed: install + verify, turn on the guardrails, close the gaps.
 * Write-once ({once:true}) — a team owns and edits it, so it embeds a snapshot of the
 * gaps; the LIVE gaps stay in the regenerated `project.md`/`project.json`. Kept short on
 * purpose — this is a checklist, not a playbook.
 */
export function setupDoc(dir: string, c: ProjectContract): string {
  const install = installCommand(c.packageManager);
  const installLine = install
    ? `- Install dependencies: \`${install}\`.`
    : "- Install dependencies with the repo's package manager (npm / pnpm / yarn / bun).";
  const verify: string[] = [];
  const partialChecks = [
    c.commands.typecheck,
    c.commands.test,
    c.commands.build,
    c.commands.lint,
  ].filter((cmd): cmd is NonNullable<ProjectContract["commands"]["test"]> => cmd !== undefined);
  if (c.commands.verify) {
    verify.push(`- Run the completion gate: \`${c.commands.verify.value}\`.`);
    if (partialChecks.length > 0) {
      verify.push(
        `- Fast partial checks: ${partialChecks.map((cmd) => `\`${cmd.value}\``).join(", ")}.`,
      );
    }
  } else {
    if (c.commands.typecheck) verify.push(`- Typecheck: \`${c.commands.typecheck.value}\``);
    if (c.commands.test) verify.push(`- Run the tests: \`${c.commands.test.value}\``);
    if (c.commands.build) verify.push(`- Build: \`${c.commands.build.value}\``);
    if (c.commands.lint) verify.push(`- Lint: \`${c.commands.lint.value}\``);
  }
  if (verify.length === 0) {
    verify.push(
      "- _No verify/test/lint command detected — add one and record it in `project.json`._",
    );
  }
  const gaps =
    c.knownGaps.length > 0
      ? c.knownGaps.map((g) => `- [ ] ${g}`)
      : ["- [x] No gaps reported — the contract is clean."];
  const largeRepo =
    c.scale.class === "large"
      ? [
          "",
          "## Large-repo safety",
          "",
          "This repo is large. Before broad analysis, enable a code graph",
          "(`aih mcp --apply` + `aih tools --apply`) or keep reconnaissance to bounded",
          "`rg`/`fd`. Run `aih doctor` and check `large-repo graph safety`.",
        ]
      : [];
  return lines(
    "# Setup",
    "",
    `> First-run setup for this repo, derived from \`${dir}/project.json\`. Write-once:`,
    "> edit it freely — `aih` will not overwrite your changes. The full contract is in",
    `> \`${dir}/project.md\`.`,
    "",
    "## 1. Install & verify",
    "",
    installLine,
    ...verify,
    "",
    "## 2. Turn on the guardrails (once per clone)",
    "",
    "- `git config core.hooksPath .githooks` — enables the pre-commit lint/test/secret hook.",
    "- `aih secrets --verify` — confirm no plaintext secrets are committed.",
    "",
    mcpToolingBlock(c),
    "",
    "## 4. Close the known gaps",
    "",
    gaps,
    ...largeRepo,
  );
}
