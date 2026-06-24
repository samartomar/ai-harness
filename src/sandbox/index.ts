import { pendingPlan } from "../commands/stub.js";
import type { CommandSpec } from "../internals/plan.js";

export const command: CommandSpec = {
  name: "sandbox",
  summary: "Generate devcontainer + managed sandbox settings (allowlist, failIfUnavailable)",
  options: [],
  plan: pendingPlan(
    "sandbox",
    "Generate .devcontainer/devcontainer.json and managed-settings.json (sandbox.enabled, failIfUnavailable, allowedDomains) and document worktree isolation; optionally probe docker read-only.",
  ),
};
