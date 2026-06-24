import { pendingPlan } from "../commands/stub.js";
import type { CommandSpec } from "../internals/plan.js";

export const command: CommandSpec = {
  name: "init",
  summary: "Initialize a target repo: profile, scaffold, guardrails, secrets, mcp, sandbox",
  options: [],
  plan: pendingPlan(
    "init",
    "Initialize a repository by composing profile + scaffold + guardrails + secrets + mcp + sandbox into a single plan against the repo root.",
  ),
};
