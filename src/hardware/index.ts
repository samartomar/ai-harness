import { pendingPlan } from "../commands/stub.js";
import type { CommandSpec } from "../internals/plan.js";

export const command: CommandSpec = {
  name: "hardware",
  summary: "Profile CPU/RAM/GPU and emit tuned local-inference settings (Ollama/llama.cpp)",
  options: [
    {
      flags: "--model-size-gb <n>",
      description: "model weight size in GB used for parallel-request sizing",
      default: "5",
    },
    {
      flags: "--engine <engine>",
      description: "target inference engine: ollama|llamacpp",
      default: "ollama",
    },
  ],
  plan: pendingPlan(
    "hardware",
    "Profile the workstation, compute memory/thread/parallel-request limits and a quantization recommendation, then emit the inference engine env block.",
  ),
};
