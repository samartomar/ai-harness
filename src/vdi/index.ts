import { pendingPlan } from "../commands/stub.js";
import type { CommandSpec } from "../internals/plan.js";

export const command: CommandSpec = {
  name: "vdi",
  summary: "Detect VDI environments and redirect caches/SQLite to local scratch",
  options: [{ flags: "--scratch <dir>", description: "override the local scratch root" }],
  plan: pendingPlan(
    "vdi",
    "Detect VDI markers and, when present, redirect OLLAMA_MODELS / cache dirs / code-review-graph DB to non-synced local scratch (junction on Windows).",
  ),
};
