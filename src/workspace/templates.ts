import { lines } from "../internals/render.js";
import type { WorkspaceEdge, WorkspaceRepo } from "./manifest.js";

/** The workspace marker — lets `aih doctor` recognize a multi-repo workspace root. */
export function workspaceMarker(repos: string[], dir: string, git = false): unknown {
  return {
    workspaceType: "multi-repo",
    graphScope: "combined-child-repos",
    contextDir: dir,
    repos,
    ...(git ? { git: true } : {}),
    generatedBy: "aih workspace",
  };
}

/** A VS Code multi-root `.code-workspace` opening every child repo in one window. */
export function codeWorkspace(repos: string[]): unknown {
  return {
    folders: repos.map((path) => ({ path })),
    settings: {},
  };
}

/**
 * Workspace-level MCP servers: a combined code-review graph rooted at the parent
 * plus a filesystem MCP scoped to every child repo path. The graph answers
 * "what is the blast radius across UI/backend/infra/docs?", while each child
 * repo still owns its own canon and local command flow.
 * Merged into any existing `.mcp.json`. The package is version-pinnable via
 * `AIH_MCP_FS_VERSION` (supply-chain control) — unset runs latest at MCP launch.
 */
export function spanningMcp(repos: string[], version?: string): unknown {
  const pkg =
    version && version.length > 0
      ? `@modelcontextprotocol/server-filesystem@${version}`
      : "@modelcontextprotocol/server-filesystem";
  return {
    mcpServers: {
      // Pinned uvx form, identical to the per-repo server in src/mcp/servers.ts —
      // ephemeral env (works from the workspace root), reproducible, bump in lockstep.
      "code-review-graph": {
        command: "uvx",
        args: ["code-review-graph@2.3.6", "serve"],
      },
      filesystem: {
        command: "npx",
        args: ["-y", pkg, ...repos],
      },
    },
  };
}

function repoDisplayPath(path: string): string {
  return path === "." ? "./" : `${path}/`;
}

function childRouterPath(repo: WorkspaceRepo): string {
  return `${repo.path}/${repo.router}`;
}

/** Future-facing parent router for federated workspaces. */
export function workspaceRouterDoc(repos: readonly WorkspaceRepo[]): string {
  const rows =
    repos.length > 0
      ? repos.map(
          (repo) =>
            `| ${repo.id} | ${repoDisplayPath(repo.path)} | ${repo.kind ?? ""} | ${childRouterPath(repo)} |`,
        )
      : ["| _none_ | _none_ |  | _run `aih workspace --repos ... --apply`_ |"];
  return lines(
    "# Workspace Router",
    "",
    "This is a federated workspace, not a monorepo.",
    "",
    "## Repos",
    "",
    "| Repo | Path | Role | Router |",
    "|---|---|---|---|",
    rows,
    "",
    "## Rule",
    "",
    "Before editing a child repo, read that child repo's router first.",
  );
}

/** Parent-owned contract index generated from `.aih-workspace.json` edges. */
export function workspaceContractsDoc(edges: readonly WorkspaceEdge[]): string {
  const rows =
    edges.length > 0
      ? edges.map(
          (edge) =>
            `| ${edge.id} | ${edge.from} | ${edge.to} | ${edge.kind} | ${edge.contractPath ?? ""} | ${edge.consumerPath ?? ""} |`,
        )
      : [
          "| _none declared_ |  |  |  |  |  |",
          "",
          "Declare cross-repo dependencies in `.aih-workspace.json` under `edges[]`.",
        ];
  return lines(
    "# Workspace Contracts",
    "",
    "These are explicit cross-repo dependencies for the parent coordination plane.",
    "No child files are modified by this workspace contract document.",
    "",
    "| Contract | From | To | Kind | Contract file | Consumer path |",
    "|---|---|---|---|---|---|",
    rows,
  );
}

/**
 * The cross-repo architecture map — the heart of the workspace. Seeded with the
 * detected repo names, then OWNED by the user (write-once: aih never overwrites
 * it). This is what gives an agent editing the UI a view into the backend.
 */
export function crossRepoArchitectureDoc(name: string, repos: string[], dir: string): string {
  const repoSections = repos.flatMap((repo) => [
    `### ${repo}`,
    "",
    "- **Owns:** _what this repo is responsible for._",
    `- **Canon:** \`${repo}/${dir}/RULE_ROUTER.md\``,
    "- **Entry points:** _main handlers / routes / packages._",
    "",
  ]);
  const cols = repos.length > 0 ? repos : ["repo-a", "repo-b"];
  const header = `| Feature | ${cols.join(" | ")} | Contract (API / event / schema) |`;
  const divider = `| --- | ${cols.map(() => "---").join(" | ")} | --- |`;
  const example = `| _Login_ | ${cols.map(() => "_…_").join(" | ")} | _\`LoginRequest\`/\`LoginResponse\`_ |`;
  return lines(
    "# Cross-repo architecture",
    "",
    `> Workspace canon for \`${name}\`. **WRITE-ONCE** — aih seeded this with your repo`,
    "> list; you own it from here. Re-running `aih workspace` will NOT overwrite it.",
    "",
    "## System overview",
    "",
    `_How ${repos.length > 0 ? repos.join(" + ") : "the repos"} fit together: request flow, data`,
    "flow, auth, async/events. Sketch the high-level shape in 3–5 sentences or a diagram._",
    "",
    "## Repositories",
    "",
    repoSections,
    "## Cross-repo feature map",
    "",
    "One row per feature that spans repos — the contract is the source of truth.",
    "",
    header,
    divider,
    example,
    "",
    "## Blast-radius protocol",
    "",
    "When an agent is asked to change a product behavior:",
    "",
    "1. Start at this workspace map and identify every repo touched by the feature.",
    "2. Use the workspace graph/filesystem MCP to inspect cross-repo call sites, imports,",
    "   API contracts, infra bindings, runbooks, and docs before editing.",
    "3. Before writing code in any repo, read that repo's own canon and validation flow.",
    "4. Make source changes inside child repos, not in the parent workspace root.",
    "5. Run each affected repo's local validation, then update this feature map when a",
    "   cross-repo contract changes.",
    "",
    "## Change patterns",
    "",
    "- **Add a cross-repo feature:** define/version the contract first, implement the",
    "  backend, then the UI; add or refresh the feature-map row.",
    "- **Debug a data flow:** trace UI action → contract → backend handler → datastore;",
    "  check each repo's canon for its own conventions.",
    "- **Change a contract:** it is a breaking change across repos — update both sides",
    "  in lockstep and bump the contract version.",
  );
}

/** Per-repo discipline routing — read a repo's own canon before editing it. */
export function repoDisciplineDoc(repos: string[], dir: string): string {
  const bullets =
    repos.length > 0
      ? repos.map(
          (repo) =>
            `- **${repo}** → read \`${repo}/${dir}/RULE_ROUTER.md\` (+ \`${repo}/${dir}/conventions.md\`) before writing code in \`${repo}/\`.`,
        )
      : ["- _Add repos to the workspace, then re-run `aih workspace`._"];
  return lines(
    "# Repo discipline (workspace)",
    "",
    "This parent folder is the coordination plane, not a source repo. Use it to reason",
    "about blast radius across UI/backend/infra/docs, then do implementation work inside",
    "the affected child repos. Conventions differ per repo — before editing a repo, load",
    "THAT repo's canon first.",
    "",
    bullets,
    "",
    `For any change that crosses repos, consult \`${dir}/cross-repo-architecture.md\` for`,
    "the contract, inspect the combined workspace graph, update every affected repo in",
    "lockstep, and keep the feature map current. Never assume one repo's conventions",
    "apply to another.",
  );
}

/** A thin workspace bootloader (CLAUDE.md / AGENTS.md at the parent) → the canon. */
export function workspaceBootloader(
  tool: string,
  name: string,
  repos: string[],
  dir: string,
): string {
  return lines(
    `# ${name} — workspace (${tool})`,
    "",
    "This is a multi-repo workspace, not a single repo. Start here:",
    "",
    `- \`${dir}/workspace-router.md\` — top-level routing table into each child repo's canon.`,
    `- \`${dir}/cross-repo-architecture.md\` — how the repos fit together + the cross-repo feature map.`,
    `- \`${dir}/workspace-contracts.md\` — declared cross-repo contract edges.`,
    `- \`${dir}/repo-discipline.md\` — read a repo's own canon before editing it.`,
    "- Workspace MCP graph/filesystem — use for blast-radius discovery across all child repos.",
    "",
    `Repos: ${repos.length > 0 ? repos.join(", ") : "(none detected yet)"}. Each has its own canon`,
    `under \`<repo>/${dir}/\` (run \`aih init\` in each). Edit workspace guidance in \`${dir}/\`, not here.`,
  );
}

/** The "what to do next" doc — parent-only scaffold, so init runs per child. */
export function nextStepsDoc(name: string, repos: string[], dir: string, git = false): string {
  const initCmds =
    repos.length > 0
      ? repos.map((r) => `  aih init ./${r} --apply`)
      : ["  # (no child repos detected — clone repos under this folder, then re-run)"];
  const gitNotes = git
    ? [
        "- Remote setup is user/team-owned: `aih workspace --git` creates only the local bridge repo; add an origin later if and where you choose.",
      ]
    : [];
  return lines(
    `Workspace scaffolded for \`${name}\` (parent-only). Detected repos: ${repos.length > 0 ? repos.join(", ") : "none"}.`,
    "",
    "Lay down each repo's canon (run from the workspace root):",
    "",
    initCmds,
    "",
    `- Fill in \`${dir}/cross-repo-architecture.md\` — it is write-once; aih won't overwrite it.`,
    `- Open \`${name}.code-workspace\` in VS Code (all repos in one window).`,
    "- Use the parent `.mcp.json` graph/filesystem servers for cross-repo blast-radius analysis.",
    ...gitNotes,
    "- Validate: `aih doctor` at the workspace root checks each child is scaffolded.",
  );
}
