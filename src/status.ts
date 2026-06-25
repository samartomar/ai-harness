import { existsSync } from "node:fs";
import { join } from "node:path";
import { type CommandSpec, plan, probe } from "./internals/plan.js";
import type { Check } from "./internals/verify.js";

const ARTIFACTS: Array<[name: string, rel: string]> = [
  ["context-dir", ""], // resolved against ctx.contextDir below
  ["CLAUDE.md", "CLAUDE.md"],
  ["AGENTS.md", "AGENTS.md"],
  ["cursor-rules", ".cursor/rules"],
  ["mcp", ".mcp.json"],
  ["gitleaks", ".gitleaks.toml"],
  ["pre-commit", ".pre-commit-config.yaml"],
  ["claude-settings", ".claude/settings.json"],
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
    // .pre-commit-config.yaml is inert until `pre-commit install` writes the git
    // hook — so a present config with no hook is "generated, not enforced".
    const hookInstalled = existsSync(join(root, ".git", "hooks", "pre-commit"));
    return hookInstalled
      ? `${relative} (git hook installed — active)`
      : `${relative} present, but the git hook is NOT installed — run \`pre-commit install\` to enforce it`;
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
