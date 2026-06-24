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
      ...ARTIFACTS.map(([name, rel]) =>
        probe(`presence: ${name}`, (): Check => {
          const relative = name === "context-dir" ? ctx.contextDir : rel;
          const abs = join(ctx.root, relative);
          return existsSync(abs)
            ? { name, verdict: "pass", detail: relative }
            : { name, verdict: "skip", detail: `${relative} not present` };
        }),
      ),
    ),
};
