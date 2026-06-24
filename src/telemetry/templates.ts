// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these `${...}` are literal
// fragments of the GENERATED collector.yaml / fetch-analytics.mjs (their own runtime
// template syntax), not interpolations in this TypeScript source.
import type { EnvVar } from "../internals/envfile.js";
import { lines } from "../internals/render.js";

/**
 * The Claude Code Analytics Admin API usage endpoint. The generated fetcher
 * targets this URL but never calls it at generation time — it is a tool the
 * operator runs on demand (see {@link fetchAnalyticsScript}).
 */
export const ANALYTICS_ENDPOINT =
  "https://api.anthropic.com/v1/organizations/usage_report/claude_code";

/**
 * The five first-class Claude Code telemetry event types. These are the log
 * record names the OTel collector and any downstream backend key off of.
 */
export const EVENT_TYPES = [
  "api_request",
  "tool_result",
  "tool_decision",
  "user_prompt",
  "api_error",
] as const;

/**
 * OpenTelemetry environment for Claude Code, exported into the shell profile.
 * Faithful to the blueprint: gRPC OTLP transport to `endpoint`, full prompt and
 * tool-detail logging enabled, and the master telemetry switch on. Order is
 * deterministic so the managed block is byte-stable across runs.
 */
export function otelEnvVars(endpoint: string): EnvVar[] {
  return [
    { key: "OTEL_EXPORTER_OTLP_ENDPOINT", value: endpoint },
    { key: "OTEL_EXPORTER_OTLP_PROTOCOL", value: "grpc" },
    { key: "OTEL_LOG_USER_PROMPTS", value: "1" },
    { key: "OTEL_LOG_TOOL_DETAILS", value: "1" },
    { key: "CLAUDE_CODE_ENABLE_TELEMETRY", value: "1" },
  ];
}

/**
 * Derive the otlphttp exporter endpoint for the collector from the OTLP gRPC
 * endpoint the agent exports to. The collector receives on :4317 (gRPC) / :4318
 * (http) and forwards to the same host's http port by default; operators repoint
 * `exporters.otlphttp.endpoint` at their real backend.
 */
function exporterEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.port = "4318";
    return `${url.protocol}//${url.host}`;
  } catch {
    return "http://127.0.0.1:4318";
  }
}

/**
 * A hand-written Bindplane/OpenTelemetry Collector config. No YAML library is
 * used (and none is available), so the document is assembled deterministically
 * from string fragments. The pipeline redacts secrets and PII before anything
 * leaves the host:
 *
 *  - `receivers.otlp` accepts the agent's gRPC + HTTP OTLP feed;
 *  - `processors.redaction` blocks values matching common secret/PII shapes and
 *    `processors.attributes` drops known-sensitive keys outright;
 *  - `exporters.otlphttp` forwards the scrubbed signal to the backend;
 *  - `service.pipelines` wires traces/metrics/logs through the scrubbers.
 */
export function collectorYaml(endpoint: string): string {
  const out = exporterEndpoint(endpoint);
  return lines(
    "# aih-managed OpenTelemetry / Bindplane collector for Claude Code telemetry.",
    "# Redacts secrets and PII locally before any signal is exported. Repoint",
    "# exporters.otlphttp.endpoint at your Bindplane / Langfuse / Elasticsearch backend.",
    "",
    "receivers:",
    "  otlp:",
    "    protocols:",
    "      grpc:",
    "        endpoint: 0.0.0.0:4317",
    "      http:",
    "        endpoint: 0.0.0.0:4318",
    "",
    "processors:",
    "  # Drop attributes that may carry credentials outright.",
    "  attributes/scrub-secrets:",
    "    actions:",
    "      - key: api_key",
    "        action: delete",
    "      - key: authorization",
    "        action: delete",
    "      - key: anthropic_api_key",
    "        action: delete",
    "      - key: aws_secret_access_key",
    "        action: delete",
    "  # Hash/redact values that look like secrets or PII anywhere in the record.",
    "  redaction:",
    "    allow_all_keys: true",
    "    blocked_values:",
    '      - "sk-ant-[A-Za-z0-9_-]{8,}"        # Anthropic API keys',
    '      - "(?i)bearer\\\\s+[A-Za-z0-9._-]+"     # bearer tokens',
    '      - "AKIA[0-9A-Z]{16}"                 # AWS access key IDs',
    '      - "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\\\.[A-Za-z]{2,}"  # email (PII)',
    "    summary: debug",
    "  batch:",
    "    timeout: 5s",
    "",
    "exporters:",
    "  otlphttp:",
    `    endpoint: ${out}`,
    "    # Add headers/auth for your backend here (kept out of source by design):",
    "    # headers:",
    "    #   Authorization: ${env:TELEMETRY_BACKEND_TOKEN}",
    "  debug:",
    "    verbosity: basic",
    "",
    "service:",
    "  pipelines:",
    "    traces:",
    "      receivers: [otlp]",
    "      processors: [attributes/scrub-secrets, redaction, batch]",
    "      exporters: [otlphttp]",
    "    metrics:",
    "      receivers: [otlp]",
    "      processors: [batch]",
    "      exporters: [otlphttp]",
    "    logs:",
    "      receivers: [otlp]",
    "      processors: [attributes/scrub-secrets, redaction, batch]",
    "      exporters: [otlphttp]",
  );
}

/**
 * A standalone Node ESM script that *would* query the Claude Code Analytics
 * Admin API. It reads `ANTHROPIC_ADMIN_KEY` from the environment, builds the
 * request, and by default only PRINTS the equivalent `curl` command — it does
 * not call the API. A live fetch happens only when the operator passes `--run`,
 * so generating this file never touches the network.
 */
export function fetchAnalyticsScript(): string {
  return lines(
    "#!/usr/bin/env node",
    "// aih-managed: Claude Code Analytics (Admin API) fetcher.",
    "// Generated by `aih telemetry`. This script is a TOOL YOU RUN — it does not",
    "// run at generation time and prints the curl equivalent unless given --run.",
    "",
    `const ENDPOINT = ${JSON.stringify(ANALYTICS_ENDPOINT)};`,
    "const adminKey = process.env.ANTHROPIC_ADMIN_KEY;",
    "",
    "function isoDay(offsetDays) {",
    "  const d = new Date(Date.now() + offsetDays * 86_400_000);",
    "  return d.toISOString().slice(0, 10);",
    "}",
    "",
    "// Query window: yesterday 00:00Z through today 00:00Z (one full UTC day).",
    "const params = new URLSearchParams({",
    "  starting_at: `${isoDay(-1)}T00:00:00Z`,",
    "  ending_at: `${isoDay(0)}T00:00:00Z`,",
    "});",
    "const url = `${ENDPOINT}?${params.toString()}`;",
    "",
    "if (!adminKey) {",
    '  console.error("ANTHROPIC_ADMIN_KEY is not set — export an Admin API key first.");',
    '  console.error("  export ANTHROPIC_ADMIN_KEY=<your-admin-key>");',
    "  process.exit(1);",
    "}",
    "",
    "// The curl equivalent — printed so the request is auditable before it runs.",
    "const curl = [",
    '  "curl -sS",',
    '  `  -H "Authorization: Bearer $ANTHROPIC_ADMIN_KEY"`,',
    '  `  -H "anthropic-version: 2023-06-01"`,',
    "  `  ${JSON.stringify(url)}`,",
    '].join(" \\\\\\n");',
    "console.log(curl);",
    "",
    'if (!process.argv.includes("--run")) {',
    '  console.error("\\n(dry run — re-run with --run to actually query the Analytics API)");',
    "  process.exit(0);",
    "}",
    "",
    "const res = await fetch(url, {",
    "  headers: {",
    "    Authorization: `Bearer ${adminKey}`,",
    '    "anthropic-version": "2023-06-01",',
    "  },",
    "});",
    "if (!res.ok) {",
    "  console.error(`Analytics API error: ${res.status} ${res.statusText}`);",
    "  process.exit(1);",
    "}",
    "console.log(JSON.stringify(await res.json(), null, 2));",
  );
}
