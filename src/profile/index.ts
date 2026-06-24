import { pendingPlan } from "../commands/stub.js";
import type { CommandSpec } from "../internals/plan.js";

export const command: CommandSpec = {
  name: "profile",
  summary: "Profile the repository's stack and synthesize CLAUDE.md + cursor rules",
  options: [
    { flags: "--max-depth <n>", description: "max directory recursion depth", default: "8" },
  ],
  plan: pendingPlan(
    "profile",
    "Recursively detect languages, test runners, build/lint commands and deployment targets from signature files, then synthesize tailored CLAUDE.md and .cursor/rules.",
  ),
};
