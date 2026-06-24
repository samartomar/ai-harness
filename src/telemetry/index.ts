import { pendingPlan } from "../commands/stub.js";
import type { CommandSpec } from "../internals/plan.js";

export const command: CommandSpec = {
  name: "telemetry",
  summary: "Inject OpenTelemetry env, a Bindplane collector config and an analytics fetcher",
  options: [
    {
      flags: "--endpoint <url>",
      description: "OTLP exporter endpoint",
      default: "http://127.0.0.1:4317",
    },
  ],
  plan: pendingPlan(
    "telemetry",
    "Inject OTEL_* env into the shell profile, emit a Bindplane collector.yaml and a Claude Code Analytics fetcher script + cron line; never calls the API or installs cron.",
  ),
};
