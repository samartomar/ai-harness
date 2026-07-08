import { join } from "node:path";
import {
  type CommandSpec,
  doc,
  type PlanContext,
  plan,
  probe,
  writeText,
} from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { telemetryDoc } from "./docs.js";
import { buildProfileWrite } from "./env.js";
import { collectorYaml, fetchAnalyticsScript, normalizeOtelEndpoint } from "./templates.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:4317";

/**
 * `aih telemetry` — local-only observability wiring for Claude Code.
 *
 * Injects the OpenTelemetry env (gRPC OTLP → `--endpoint`) into the shell
 * profile, emits a redacting Bindplane/OTel collector config and an Analytics
 * Admin API fetcher script, and documents the cron schedule, event types, and
 * backend setup. Nothing here calls a remote system: every cloud/scheduling
 * step is a `doc`, the fetcher only runs when the operator invokes it, and the
 * single probe is a read-only collector-presence check.
 */
function telemetryPlan(ctx: PlanContext) {
  const endpoint = normalizeOtelEndpoint(
    String(ctx.options.endpoint ?? DEFAULT_ENDPOINT),
    DEFAULT_ENDPOINT,
  );
  // Prompt + tool-detail logging are off unless explicitly opted into — these
  // streams carry source, customer data, and secrets the collector can't fully
  // scrub. See OtelLoggingOptions.
  const logging = {
    logPrompts: ctx.options.logPrompts === true,
    logToolDetails: ctx.options.logToolDetails === true,
  };

  const collectorPath = join(ctx.contextDir, "telemetry", "collector.yaml");
  const fetcherPath = join(ctx.contextDir, "telemetry", "fetch-analytics.mjs");

  const profileWrite = buildProfileWrite(ctx, endpoint, logging);
  const collectorWrite = writeText(
    collectorPath,
    collectorYaml(endpoint),
    "Redacting OpenTelemetry/Bindplane collector config (otlp in, scrubbed otlphttp out)",
  );
  const fetcherWrite = writeText(
    fetcherPath,
    fetchAnalyticsScript(),
    "Claude Code Analytics Admin API fetcher (prints curl; only queries on --run)",
    { mode: 0o755 },
  );

  return plan(
    "telemetry",
    profileWrite,
    collectorWrite,
    fetcherWrite,
    doc(
      "Telemetry setup: cron schedule, event types, and Bindplane/Langfuse/Elasticsearch backends",
      telemetryDoc(collectorPath, fetcherPath),
    ),
    probe("OpenTelemetry collector present (otelcol)", async (c): Promise<Check> => {
      const res = await c.run(["otelcol", "--version"]);
      if (res.spawnError) {
        return {
          name: "otel-collector",
          verdict: "skip",
          detail: "otelcol not found on PATH — install it to run the collector",
        };
      }
      return {
        name: "otel-collector",
        verdict: res.code === 0 ? "pass" : "fail",
        detail: res.code === 0 ? res.stdout.trim() || "otelcol available" : `exit ${res.code}`,
      };
    }),
  );
}

export const command: CommandSpec = {
  name: "telemetry",
  summary: "Inject OpenTelemetry env, a Bindplane collector config and an analytics fetcher",
  options: [
    {
      flags: "--endpoint <url>",
      description: "OTLP exporter endpoint",
      default: DEFAULT_ENDPOINT,
    },
    {
      flags: "--log-prompts",
      description:
        "Opt in to exporting full user-prompt bodies (privacy-sensitive; off by default)",
    },
    {
      flags: "--log-tool-details",
      description:
        "Opt in to exporting full tool inputs/outputs (privacy-sensitive; off by default)",
    },
  ],
  plan: telemetryPlan,
};
