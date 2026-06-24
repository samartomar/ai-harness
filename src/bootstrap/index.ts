import { pendingPlan } from "../commands/stub.js";
import type { CommandSpec } from "../internals/plan.js";

export const command: CommandSpec = {
  name: "bootstrap",
  summary: "Bootstrap the workstation: 4-phase rollout (certs, hardware, vdi, telemetry)",
  options: [{ flags: "--phase <n>", description: "run a single phase (1-4) instead of all" }],
  plan: pendingPlan(
    "bootstrap",
    "Orchestrate the workstation rollout in phases (baseline/security, sandbox+perf, gateway, observability) by composing the per-capability plans into one phased report.",
  ),
};
