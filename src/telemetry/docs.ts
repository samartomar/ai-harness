import { lines } from "../internals/render.js";
import { ANALYTICS_ENDPOINT, EVENT_TYPES, SKILLS_ENDPOINT } from "./templates.js";

/**
 * Operator guidance for the telemetry capability. Everything here is a `doc`
 * action: the cron schedule, the analytics endpoint, the telemetry event
 * types, and backend wiring (Bindplane / Langfuse / Elasticsearch). None of it
 * is executed — the harness never schedules cron or contacts a remote backend.
 */
export function telemetryDoc(collectorPath: string, fetcherPath: string): string {
  const fetcher = fetcherPath.replace(/\\/g, "/");
  const collector = collectorPath.replace(/\\/g, "/");
  return lines(
    "Telemetry & analytics — operator setup (run these yourself; aih never does):",
    "",
    "1. Run the OpenTelemetry / Bindplane collector with the generated config:",
    `     otelcol --config ${collector}`,
    "   (or load it into Bindplane OP as a configuration and roll out to this agent).",
    "   The collector redacts secrets/PII locally, then forwards to your backend via",
    "   exporters.otlphttp — repoint that endpoint at your real destination.",
    "   Privacy default: full prompt + tool-detail logging is OFF (raw prompts/tool I/O",
    "   carry source, customer data, and secrets the regex redaction can't fully scrub).",
    "   Opt in with `aih telemetry --log-prompts --log-tool-details --apply`.",
    "",
    "2. Schedule the Analytics fetcher with cron (daily at 06:00). Add via `crontab -e`:",
    `     0 6 * * * ANTHROPIC_ADMIN_KEY=$ANTHROPIC_ADMIN_KEY node ${fetcher} --run >> ~/claude-usage.log 2>&1`,
    "   The fetcher queries TWO Claude Code Analytics Admin API endpoints:",
    `     usage:  ${ANALYTICS_ENDPOINT}`,
    `     skills: ${SKILLS_ENDPOINT}`,
    "   and emits { usage_report, skills } — feed that file to `aih report --org <file>`",
    "   for the org digest. It needs an Admin API key (ANTHROPIC_ADMIN_KEY); without",
    "   --run it only prints the curl equivalents so you can audit each request first.",
    "",
    "3. First-class telemetry event types to dashboard / alert on:",
    ...EVENT_TYPES.map((e) => `     - ${e}`),
    "",
    "4. Backend wiring (choose one; configure off-host — these are cloud steps, doc only):",
    "   • Bindplane OP: import collector.yaml as a configuration, attach a destination",
    "     (Google Cloud, Honeycomb, Datadog, …), and roll the config out to this agent.",
    "   • Langfuse: deploy/self-host Langfuse, create a project, and point",
    "     exporters.otlphttp.endpoint at <langfuse-host>/api/public/otel (set the",
    "     Authorization header to your Langfuse basic-auth token via TELEMETRY_BACKEND_TOKEN).",
    "   • Elasticsearch: run the Elastic APM/OTLP endpoint (or the Elastic Distro of the",
    "     OTel Collector) and forward there; build Kibana dashboards over the event types above.",
  );
}
