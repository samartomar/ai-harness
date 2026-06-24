import { pendingPlan } from "../commands/stub.js";
import type { CommandSpec } from "../internals/plan.js";

export const command: CommandSpec = {
  name: "guardrails",
  summary: "Generate gitleaks + pre-commit guardrails and a CI license-compliance gate",
  options: [],
  plan: pendingPlan(
    "guardrails",
    "Write .gitleaks.toml (default rules + enterprise regex), .pre-commit-config.yaml, a golden-path taxonomy doc and a CI SCA workflow that blocks AGPL/strong-copyleft licenses.",
  ),
};
