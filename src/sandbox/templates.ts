import type { RepoStack } from "../profile/scan.js";

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
  /** Detected repo stack — drives which toolchain features get installed. */
  stack: RepoStack;
}

function isNodeStack(stack: RepoStack): boolean {
  return stack.languages.some((l) => l.endsWith("/Node.js"));
}

/** A `postCreateCommand` that actually installs the detected stack's deps + tools. */
function postCreate(stack: RepoStack): string {
  const steps: string[] = [];
  if (isNodeStack(stack)) {
    const pm = stack.packageManager ?? "npm";
    steps.push(pm === "npm" ? "npm install" : `${pm} install`);
    if (stack.frameworks.includes("Serverless Framework")) steps.push("npx serverless --version");
  }
  if (stack.languages.includes("Python")) {
    steps.push("python -m pip install -r requirements.txt || pip install -e .");
  }
  if (steps.length === 0) steps.push("git --version");
  return steps.join(" && ");
}

/**
 * A sandbox-oriented devcontainer tailored to the DETECTED stack: a pinned Ubuntu
 * base plus the features the repo actually needs (Node when it's a Node project,
 * AWS CLI when it targets AWS, Python when it's Python), and a `postCreateCommand`
 * that installs dependencies (`npm install`, etc.) — not a no-op version check.
 * The container is the blast radius; edits project back over the bind-mounted
 * workspace.
 */
export function devcontainerConfig(opts: DevcontainerOptions): Record<string, unknown> {
  const { contextDir, stack } = opts;
  const features: Record<string, unknown> = {
    "ghcr.io/devcontainers/features/common-utils:2": {
      installZsh: true,
      username: "vscode",
      upgradePackages: true,
    },
    "ghcr.io/devcontainers/features/github-cli:1": {},
  };
  if (isNodeStack(stack)) features["ghcr.io/devcontainers/features/node:1"] = { version: "lts" };
  if (stack.languages.includes("Python")) {
    features["ghcr.io/devcontainers/features/python:1"] = { version: "3.12" };
  }
  if (stack.cloud.includes("AWS")) features["ghcr.io/devcontainers/features/aws-cli:1"] = {};

  return {
    name: "aih-sandbox",
    image: DEVCONTAINER_IMAGE,
    features,
    remoteUser: "vscode",
    postCreateCommand: postCreate(stack),
    customizations: {
      vscode: {
        extensions: ["dbaeumer.vscode-eslint", "esbenp.prettier-vscode"],
        settings: {
          "editor.formatOnSave": true,
          "files.eol": "\n",
          "files.exclude": {
            [`${contextDir}/**`]: false,
          },
        },
      },
    },
  };
}

/**
 * The Claude-managed sandbox policy: fail closed, refuse unsandboxed commands,
 * and constrain egress to the registries the toolchain needs — plus the detected
 * cloud's API domain (e.g. `*.amazonaws.com`) so legitimate SDK calls aren't
 * blocked. Deep-merged onto any pre-existing `.claude/managed-settings.json`.
 */
export function managedSandboxSettings(stack?: RepoStack): Record<string, unknown> {
  const allowedDomains: string[] = [...SANDBOX_ALLOWED_DOMAINS];
  if (stack?.cloud.includes("AWS")) allowedDomains.push("*.amazonaws.com");
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      allowedDomains,
    },
  };
}
