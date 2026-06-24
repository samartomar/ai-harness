import { pendingPlan } from "../commands/stub.js";
import type { CommandSpec } from "../internals/plan.js";

export const command: CommandSpec = {
  name: "scaffold",
  summary: "Scaffold the canonical context dir, INDEX/SKILL docs and thin IDE adapters",
  options: [],
  plan: pendingPlan(
    "scaffold",
    "Create the canonical context directory (default .ai-context) with an INDEX and SKILL skeleton, plus thin (<30 line) CLAUDE.md / AGENTS.md / .cursor rules / .windsurfrules adapters that route to it.",
  ),
};
