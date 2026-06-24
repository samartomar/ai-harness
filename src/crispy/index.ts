import { pendingPlan } from "../commands/stub.js";
import type { CommandSpec } from "../internals/plan.js";

export const command: CommandSpec = {
  name: "crispy",
  summary: "Run the CRISPY context-engineering stage machine (deterministic fs transactions)",
  options: [
    {
      flags: "--stage <stage>",
      description: "context|research|iterate|structure|plan|synthesize|implement",
    },
    { flags: "--init", description: "initialize the CRISPY workspace under the context dir" },
  ],
  plan: pendingPlan(
    "crispy",
    "Advance the CRISPY stage machine via filesystem transactions under the context dir, enforcing <40 instructions/stage and stage-gate ordering; emits Superpowers/ECC install commands as docs.",
  ),
};
