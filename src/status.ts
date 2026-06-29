import { existsSync } from "node:fs";
import { join } from "node:path";
import { GITHOOKS_PATH_COMMAND, preCommitHookActive } from "./internals/git-hooks.js";
import { type CommandSpec, plan, probe } from "./internals/plan.js";
import type { Check } from "./internals/verify.js";

/**
 * Repo-GLOBAL harness artifacts — ones not specific to any single AI CLI. Per-CLI
 * facts (each tool's bootloader, its MCP config, Claude's `settings.json`) live in
 * the per-CLI wiring matrix (`aih report` → "AI CLI wiring"), which scores them on
 * each tool's own terms. Keeping them here too would double-represent the same fact
 * under the old Claude-shaped global check — so `status`/`configPanel` stay global
 * and the matrix owns per-tool truth.
 */
const ARTIFACTS: Array<[name: string, rel: string]> = [
  ["context-dir", ""], // resolved against ctx.contextDir below
  ["gitleaks", ".gitleaks.toml"],
  ["pre-commit", ".pre-commit-config.yaml"],
  ["devcontainer", ".devcontainer/devcontainer.json"],
];

export interface ArtifactPresence {
  name: string;
  /** Repo-relative path checked (the context-dir name for the "context-dir" entry). */
  relative: string;
  present: boolean;
}

/**
 * The harness-managed artifacts and whether each is present under `root`. Defined
 * once and shared: `aih status` renders it as probes, `aih report` as a
 * configuration panel — so the inventory never drifts between the two.
 */
export function inventory(root: string, contextDir: string): ArtifactPresence[] {
  return ARTIFACTS.map(([name, rel]) => {
    const relative = name === "context-dir" ? contextDir : rel;
    return { name, relative, present: existsSync(join(root, relative)) };
  });
}

/**
 * For artifacts where "file present" ≠ "control active", enrich the detail so
 * `status` distinguishes a generated template from an actually-wired control (the
 * advisory-vs-enforced signal — review failure-point #1). It never changes the
 * verdict — `status` stays exit-0 — it only annotates the detail string. The
 * deeper fail-closed `required` model is tracked separately (verify-layer work).
 */
function enforcementDetail(name: string, root: string, relative: string): string {
  if (name === "pre-commit") {
    // .pre-commit-config.yaml is inert until git runs a pre-commit hook. aih's
    // normal path is clone-local `.githooks/` via core.hooksPath; teams may also
    // have a default `.git/hooks/pre-commit`.
    return preCommitHookActive(root)
      ? `${relative} (git hook installed — active)`
      : `${relative} present, but no active git pre-commit hook was found — run \`${GITHOOKS_PATH_COMMAND}\` after scaffold`;
  }
  return relative;
}

/**
 * Read-only inventory of what the harness has configured for the target. Every
 * check is pass/skip (never fail), so `status` always exits 0.
 */
export const command: CommandSpec = {
  name: "status",
  summary: "Show what the harness has configured for this repo/workstation (read-only)",
  readOnly: true,
  options: [],
  plan: (ctx) =>
    plan(
      "status",
      ...inventory(ctx.root, ctx.contextDir).map((a) =>
        probe(
          `presence: ${a.name}`,
          (): Check =>
            a.present
              ? {
                  name: a.name,
                  verdict: "pass",
                  detail: enforcementDetail(a.name, ctx.root, a.relative),
                }
              : { name: a.name, verdict: "skip", detail: `${a.relative} not present` },
        ),
      ),
    ),
};
