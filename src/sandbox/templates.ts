/**
 * Deterministic blueprint values for the `sandbox` capability. Kept in a sibling
 * module so `index.ts` stays thin and the golden values (image, features,
 * allowlist, worktree paths) have a single source of truth that tests assert
 * against. No dates, no random ordering — stable across runs.
 */

/** Base image for the generated devcontainer (Microsoft devcontainers base). */
export const DEVCONTAINER_IMAGE = "mcr.microsoft.com/devcontainers/base:ubuntu";

/** Egress allowlist baked into the managed sandbox settings. */
export const SANDBOX_ALLOWED_DOMAINS = ["github.com", "pypi.org", "registry.npmjs.org"] as const;

/** Where worktree-isolated checkouts live, relative to the repo root. */
export const WORKTREE_DIR = ".claude/worktrees";

/**
 * Human guidance on git-worktree isolation and how container edits reach the
 * host. Emitted as a `doc` action (never executed): the harness does not create
 * worktrees or run containers on your behalf — it tells you the exact commands.
 */
export function worktreeGuidance(): string {
  return [
    "Sandbox isolation — git worktrees + devcontainer",
    "",
    "Run each agent task in its own git worktree so a bad run can never corrupt",
    `your main checkout. Worktrees live under ${WORKTREE_DIR}/<name> and share the`,
    "repo's object store, so branching is cheap and disposable.",
    "",
    "  # carve off an isolated worktree on a fresh branch",
    `  git worktree add ${WORKTREE_DIR}/<name> -b sandbox/<name>`,
    "",
    "  # when finished, remove it and prune the bookkeeping",
    `  git worktree remove ${WORKTREE_DIR}/<name>`,
    "  git worktree prune",
    "",
    "The companion devcontainer (.devcontainer/devcontainer.json) bind-mounts your",
    "workspace into the container, so edits made inside the sandbox project straight",
    "back onto the host filesystem — no copy step, no separate sync. Open the folder",
    'in a container ("Dev Containers: Reopen in Container") or run it headless:',
    "",
    "  devcontainer up --workspace-folder .",
    "  devcontainer exec --workspace-folder . <command>",
    "",
    "Combine the two: open the worktree directory in its devcontainer to get a",
    "throwaway, network-restricted environment whose changes still land on the host",
    "branch you created above. Pass --worktree to scope an agent run to one worktree.",
  ].join("\n");
}

export interface DevcontainerOptions {
  /** Canonical context directory name (surfaced as a VS Code search exclude). */
  contextDir: string;
}

/**
 * A sensible, sandbox-oriented devcontainer: a pinned Ubuntu base, a couple of
 * features (a non-root user via common-utils + the GitHub CLI), a
 * `postCreateCommand` that proves the toolchain, and a VS Code customization
 * block. Faithful to the blueprint's "isolated, reproducible local execution"
 * intent — the container is the blast radius, edits project back to the host
 * over the bind-mounted workspace.
 */
export function devcontainerConfig(opts: DevcontainerOptions): Record<string, unknown> {
  return {
    name: "aih-sandbox",
    image: DEVCONTAINER_IMAGE,
    features: {
      "ghcr.io/devcontainers/features/common-utils:2": {
        installZsh: true,
        username: "vscode",
        upgradePackages: true,
      },
      "ghcr.io/devcontainers/features/github-cli:1": {},
    },
    remoteUser: "vscode",
    postCreateCommand: "node --version && git --version",
    customizations: {
      vscode: {
        extensions: ["dbaeumer.vscode-eslint", "esbenp.prettier-vscode"],
        settings: {
          "editor.formatOnSave": true,
          "files.eol": "\n",
          "files.exclude": {
            [`${opts.contextDir}/**`]: false,
          },
        },
      },
    },
  };
}

/**
 * The Claude-managed sandbox policy: fail closed (no silent fallback to an
 * unsandboxed shell), refuse unsandboxed commands, and constrain egress to the
 * package + source registries the toolchain actually needs. Deep-merged onto any
 * pre-existing `.claude/managed-settings.json` so user keys survive.
 */
export function managedSandboxSettings(): Record<string, unknown> {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      allowedDomains: [...SANDBOX_ALLOWED_DOMAINS],
    },
  };
}
