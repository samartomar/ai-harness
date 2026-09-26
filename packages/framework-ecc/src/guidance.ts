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
]);
const HOME_TARGETS = new Set(["claude", "codex", "opencode"]);

export function eccGuidance(targets: readonly Cli[], platform: string): string {
  const selected = [...new Set(targets)].filter((target) => INSTALL_TARGETS.has(target));
  const installer = platform === "win32" ? "./install.ps1" : "./install.sh";
  const homeTargets = selected.filter((target) => HOME_TARGETS.has(target));
  const projectTargets = selected.filter((target) => !HOME_TARGETS.has(target));
  const projectInstaller =
    platform === "win32" ? "pwsh /path/to/ECC/install.ps1" : "bash /path/to/ECC/install.sh";
  const lines = [
    `ECC ${UPSTREAM.repository}@${UPSTREAM.commit} — developer-managed installation`,
    "Clone the reviewed source, then run these commands from the ECC checkout:",
    "git clone https://github.com/affaan-m/ECC.git",
    `git -C ECC checkout ${UPSTREAM.commit}`,
    "cd ECC",
    `Home-scoped targets: ${homeTargets.join(", ") || "none"} (install into the current user's home).`,
    ...homeTargets.map((target) => `${installer} --profile minimal --target ${target}`),
    `Project-scoped targets: ${projectTargets.join(", ") || "none"} (install into the current project).`,
    ...(projectTargets.length === 0
      ? []
      : [
          "Enter the project receiving ECC before running a project-scoped target:",
          "cd /path/to/project",
          ...projectTargets.map(
            (target) => `${projectInstaller} --profile minimal --target ${target}`,
          ),
        ]),
    "On Windows use ./install.ps1; on Unix use ./install.sh.",
    "Kiro: bash .kiro/install.sh <project> (standalone script; no managed uninstall).",
    "From the ECC checkout, preview home-scoped removals:",
    ...homeTargets.flatMap((target) => [
      `node scripts/uninstall.js --target ${target} --dry-run`,
      `node scripts/uninstall.js --target ${target}`,
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

/** Presence-only legacy inventory. Never opens a receipt or configuration file. */
export function eccStatus(root: string, home: string): string {
  if (!isAbsolute(root) || !isAbsolute(home)) throw new Error("ECC status roots must be absolute");
  const project = [
    ".cursor/ecc-install-state.json",
    ".agent/ecc-install-state.json",
    ".gemini/ecc-install-state.json",
    ".zed/ecc-install-state.json",
    ".aih/ecc/materialization-v1.json",
    ".aih/ecc-profile/ownership-v1.json",
    ".aih/ecc-profile/native-registration-v1.json",
    ".aih/ecc/codex-role-registration-v1.json",
    ".aih/ecc-mcp-explicit-add-v1.json",
    ".codex/config.toml",
  ];
  const user = [
    ".claude/ecc/install-state.json",
    ".codex/ecc-install-state.json",
    ".config/opencode/ecc-install-state.json",
    ".opencode/ecc-install-state.json",
    ".aih/ecc/registration-ledger.json",
    ".codex/AGENTS.md",
    ".codex/config.toml",
  ];
  return [
    "ECC installed state and earlier aih records (file presence only):",
    ...project.map((path) => `project ${path}: ${present(join(root, path))}`),
    ...user.map((path) => `home ${path}: ${present(join(home, path))}`),
    "Codex footprint: the listed Codex files are candidates; their contents and ownership are not inspected.",
    "Not inspected: file contents, unlisted roots, marketplace payloads, active processes, credentials, MCP values, or server reachability.",
  ].join("\n");
}
