import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Cli } from "@aihq/core/framework-host";
import { UPSTREAM } from "./identity.js";

const INSTALL_TARGETS = new Set([
  "claude",
  "codex",
  "cursor",
  "gemini",
  "opencode",
  "zed",
  "antigravity",
  "kimi",
]);
const HOME_TARGETS = new Set(["claude", "codex", "opencode"]);
/**
 * CLIs the harness can target that ECC's own installer has no adapter for
 * (E: scripts/lib/install-targets/registry.js, install-manifests.js).
 */
const NO_INSTALLER_TARGETS = new Set(["copilot", "windsurf"]);
/**
 * ECC's Cursor target materializes `.cursor/hooks` and `.cursor/hooks.json` from
 * `platform-configs` even under `--profile minimal`
 * (E: manifests/install-profiles.json, install-modules.json,
 * scripts/lib/install-targets/cursor-project.js), and ECC refuses to apply a
 * plan that materializes hooks without an explicit decision
 * (E: scripts/lib/install/hook-consent.js:46-66,177-190). The guidance
 * therefore prints a decision rather than an ambiguous command.
 */
const HOOK_DECISION_TARGETS = new Set(["cursor"]);

export function eccGuidance(targets: readonly Cli[], platform: string): string {
  const selected = [...new Set(targets)].filter(
    (target) => INSTALL_TARGETS.has(target) || NO_INSTALLER_TARGETS.has(target),
  );
  const noInstaller = selected.filter((target) => NO_INSTALLER_TARGETS.has(target));
  const installable = selected.filter((target) => INSTALL_TARGETS.has(target));
  const installer = platform === "win32" ? "./install.ps1" : "./install.sh";
  const homeTargets = installable.filter((target) => HOME_TARGETS.has(target));
  const projectTargets = installable.filter((target) => !HOME_TARGETS.has(target));
  const projectInstaller =
    platform === "win32" ? "pwsh /path/to/ECC/install.ps1" : "bash /path/to/ECC/install.sh";
  const installCommand = (target: string): string =>
    `${projectInstaller} --profile minimal --target ${target}${
      HOOK_DECISION_TARGETS.has(target) ? " --no-hooks" : ""
    }`;
  const lines = [
    `ECC ${UPSTREAM.repository}@${UPSTREAM.commit} — developer-managed installation`,
    "Clone the reviewed source, then run these commands from the ECC checkout:",
    "git clone https://github.com/affaan-m/ECC.git",
    `git -C ECC checkout ${UPSTREAM.commit}`,
    "cd ECC",
    ...noInstaller.map(
      (target) =>
        `ECC has no installer for ${target}: ECC's install-target registry has no ${target} adapter, so nothing here installs it.`,
    ),
    ...(homeTargets.includes("opencode")
      ? [
          "OpenCode installs the compiled plugin payload under .opencode/dist; build it once here before installing:",
          "npm install",
          "npm run build:opencode",
        ]
      : []),
    `Home-scoped targets: ${homeTargets.join(", ") || "none"} (install into the current user's home).`,
    ...homeTargets.map((target) => `${installer} --profile minimal --target ${target}`),
    `Project-scoped targets: ${projectTargets.join(", ") || "none"} (install into the current project).`,
    ...(projectTargets.length === 0
      ? []
      : [
          "Enter the project receiving ECC before running a project-scoped target:",
          "cd /path/to/project",
          ...projectTargets.map(installCommand),
        ]),
    ...(projectTargets.some((target) => HOOK_DECISION_TARGETS.has(target))
      ? [
          "Cursor installs ECC's Cursor hooks; the command above passes --no-hooks, and --enable-hooks turns ECC's hooks on.",
        ]
      : []),
    "On Windows use ./install.ps1; on Unix use ./install.sh.",
    "Kiro: bash /path/to/ECC/.kiro/install.sh /path/to/project (standalone script; requires bash (on Windows use Git Bash or WSL); ECC's Kiro script has no uninstall).",
    ...(homeTargets.length === 0
      ? []
      : [
          "From the ECC checkout, preview home-scoped removals:",
          ...homeTargets.flatMap((target) => [
            `node scripts/uninstall.js --target ${target} --dry-run`,
            `node scripts/uninstall.js --target ${target}`,
          ]),
        ]),
    ...(projectTargets.length === 0
      ? []
      : [
          "From the project receiving ECC, preview project-scoped removals:",
          "cd /path/to/project",
          ...projectTargets.flatMap((target) => [
            `node /path/to/ECC/scripts/uninstall.js --target ${target} --dry-run`,
            `node /path/to/ECC/scripts/uninstall.js --target ${target}`,
          ]),
        ]),
    "Claude and Codex marketplace routes are mutable external routes; they do not prove the reviewed pin:",
    "/plugin marketplace add https://github.com/affaan-m/ECC",
    "/plugin install ecc@ecc",
    "MCP: no exact reviewed command is evidenced here; configure an MCP only from reviewed client instructions.",
  ];
  return lines.join("\n");
}

function present(path: string): string {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() ? "present" : "not a regular file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    return "unknown (could not inspect)";
  }
}

/** Presence-only inventory of ECC's own installer state files. */
export function eccStatus(root: string, home: string): string {
  if (!isAbsolute(root) || !isAbsolute(home)) throw new Error("ECC status roots must be absolute");
  const project = [
    ".cursor/ecc-install-state.json",
    ".agents/ecc-install-state.json",
    ".gemini/ecc-install-state.json",
    ".zed/ecc-install-state.json",
    ".kimi-code/ecc-install-state.json",
  ];
  const user = [
    ".claude/ecc/install-state.json",
    ".codex/ecc-install-state.json",
    ".config/opencode/ecc-install-state.json",
    ".opencode/ecc-install-state.json",
  ];
  return [
    "ECC installed state (file presence only):",
    ...project.map((path) => `project ${path}: ${present(join(root, path))}`),
    ...user.map((path) => `home ${path}: ${present(join(home, path))}`),
    "Not inspected: file contents, unlisted roots, marketplace payloads, active processes, credentials, MCP values, or server reachability.",
  ].join("\n");
}
