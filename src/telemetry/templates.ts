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
 * The Claude Code Skill Usage Analytics Admin API endpoint (Enterprise plan).
 * Ranks which skills the org leans on most — the leads' #1 metric — which is why
 * the fetcher now queries it alongside {@link ANALYTICS_ENDPOINT}. Same contract:
 * operator-run, never called at generation time.
 */
export const SKILLS_ENDPOINT = "https://api.anthropic.com/v1/organizations/analytics/skills";

/**
 * Claude Code's telemetry event types — the OTel log-record names the collector
 * and any downstream backend key off of, stored as bare suffixes (the wire name
 * is `claude_code.<type>`). Mirrors the Events section of
 * code.claude.com/docs/en/monitoring-usage in published order, so the generated
 * operator doc stays byte-stable. `skill_activated` is the per-skill usage
 * signal the org analytics work keys on.
 */
export const EVENT_TYPES = [
  "user_prompt",
  "tool_result",
  "api_request",
  "api_error",
  "api_refusal",
  "api_request_body",
  "api_response_body",
  "tool_decision",
  "permission_mode_changed",
  "auth",
  "mcp_server_connection",
  "internal_error",
  "plugin_installed",
  "plugin_loaded",
  "skill_activated",
  "at_mention",
  "api_retries_exhausted",
  "hook_registered",
  "hook_execution_start",
  "hook_execution_complete",
  "hook_plugin_metrics",
  "compaction",
  "feedback_survey",
] as const;

/**
 * Opt-in switches for the two privacy-sensitive telemetry streams. Both default
 * to OFF: raw prompt bodies and tool inputs/outputs routinely carry source code,
 * customer data, ticket details, and secrets, so the harness must not export them
 * unless an operator explicitly asks. The collector's redaction is regex-based and
 * cannot reliably scrub free-form PII, so default-off is the only safe posture.
 */
export interface OtelLoggingOptions {
  /** Export full user-prompt bodies (`OTEL_LOG_USER_PROMPTS`). */
  logPrompts?: boolean;
  /** Export full tool inputs/outputs (`OTEL_LOG_TOOL_DETAILS`). */
  logToolDetails?: boolean;
}

export function normalizeOtelEndpoint(
  endpoint: string,
  fallback = "http://127.0.0.1:4317",
): string {
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" || url.protocol === "https:" ? endpoint : fallback;
  } catch {
    return fallback;
  }
}

/**
 * OpenTelemetry environment for Claude Code, exported into the shell profile.
 * Faithful to the blueprint: gRPC OTLP transport to `endpoint`, the metrics and
 * logs exporters both pinned to `otlp` (Claude Code exports nothing without them
 * — both default to off), and the master telemetry switch on. Prompt- and
 * tool-detail logging are **off by default** (privacy-first); they flip on only
 * when `logging.logPrompts` / `logging.logToolDetails` are set — see
 * {@link OtelLoggingOptions}. Order is deterministic so the managed block is
 * byte-stable across runs.
 */
export function otelEnvVars(endpoint: string, logging: OtelLoggingOptions = {}): EnvVar[] {
  return [
    { key: "OTEL_EXPORTER_OTLP_ENDPOINT", value: endpoint },
    { key: "OTEL_EXPORTER_OTLP_PROTOCOL", value: "grpc" },
    { key: "OTEL_METRICS_EXPORTER", value: "otlp" },
    { key: "OTEL_LOGS_EXPORTER", value: "otlp" },
    { key: "OTEL_LOG_USER_PROMPTS", value: logging.logPrompts ? "1" : "0" },
    { key: "OTEL_LOG_TOOL_DETAILS", value: logging.logToolDetails ? "1" : "0" },
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
    const url = new URL(normalizeOtelEndpoint(endpoint));
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
    // Metrics go through the SAME scrub processors as traces/logs: metric attributes
    // can carry model names, repo/user identifiers, endpoints, and custom dimensions.
    "      processors: [attributes/scrub-secrets, redaction, batch]",
    "      exporters: [otlphttp]",
    "    logs:",
    "      receivers: [otlp]",
    "      processors: [attributes/scrub-secrets, redaction, batch]",
    "      exporters: [otlphttp]",
  );
}

/**
 * A standalone Node ESM script that *would* query the Claude Code Analytics
 * Admin API. It reads `ANTHROPIC_ADMIN_KEY` from the environment and by default
 * only PRINTS the equivalent `curl` commands — it does not call the API. A live
 * fetch happens only when the operator passes `--run`, so generating this file
 * never touches the network. On `--run` it queries BOTH the usage report and the
 * skill-usage endpoint and emits `{ usage_report, skills }` — the exact shape
 * `aih report --org <file>` reads.
 */
export function fetchAnalyticsScript(): string {
  return lines(
    "#!/usr/bin/env node",
    "// aih-managed: Claude Code Analytics (Admin API) fetcher.",
    "// Generated by `aih telemetry`. This script is a TOOL YOU RUN — it does not run",
    "// at generation time. It prints the curl equivalents to STDERR (auditable), and",
    "// only on --run does it fetch and emit { usage_report, skills } as JSON on STDOUT",
    "// — the shape `aih report --org` reads. So `... --run > org.json` stays valid JSON.",
    "",
    `const USAGE_ENDPOINT = ${JSON.stringify(ANALYTICS_ENDPOINT)};`,
    `const SKILLS_ENDPOINT = ${JSON.stringify(SKILLS_ENDPOINT)};`,
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
    "const usageUrl = `${USAGE_ENDPOINT}?${params.toString()}`;",
    "const skillsUrl = `${SKILLS_ENDPOINT}?${params.toString()}`;",
    "",
    "if (!adminKey) {",
    '  console.error("ANTHROPIC_ADMIN_KEY is not set — export an Admin API key first.");',
    '  console.error("  export ANTHROPIC_ADMIN_KEY=<your-admin-key>");',
    "  process.exit(1);",
    "}",
    "",
    "// The curl equivalents — printed to STDERR so each request stays auditable while",
    "// STDOUT carries only JSON on --run (so `... --run > org.json` is valid JSON).",
    "function curlFor(url) {",
    "  return [",
    '    "curl -sS",',
    '    `  -H "Authorization: Bearer $ANTHROPIC_ADMIN_KEY"`,',
    '    `  -H "anthropic-version: 2023-06-01"`,',
    "    `  ${JSON.stringify(url)}`,",
    '  ].join(" \\\\\\n");',
    "}",
    "console.error(curlFor(usageUrl));",
    "console.error(curlFor(skillsUrl));",
    "",
    'if (!process.argv.includes("--run")) {',
    '  console.error("\\n(dry run — re-run with --run to actually query the Analytics API)");',
    "  process.exit(0);",
    "}",
    "",
    "async function get(url) {",
    "  const res = await fetch(url, {",
    "    headers: {",
    "      Authorization: `Bearer ${adminKey}`,",
    '      "anthropic-version": "2023-06-01",',
    "    },",
    "  });",
    "  if (!res.ok) {",
    "    console.error(`Analytics API error: ${res.status} ${res.statusText} for ${url}`);",
    "    process.exit(1);",
    "  }",
    "  return res.json();",
    "}",
    "",
    "// Combined shape consumed by `aih report --org <file>`.",
    "const [usage_report, skills] = await Promise.all([get(usageUrl), get(skillsUrl)]);",
    "console.log(JSON.stringify({ usage_report, skills }, null, 2));",
  );
}
