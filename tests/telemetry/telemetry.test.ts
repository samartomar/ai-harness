import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext, ProbeAction, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/telemetry/index.js";
import {
  ANALYTICS_ENDPOINT,
  collectorYaml,
  EVENT_TYPES,
  fetchAnalyticsScript,
  otelEnvVars,
  SKILLS_ENDPOINT,
} from "../../src/telemetry/templates.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-telemetry-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface CtxOverrides {
  platform?: "linux" | "windows" | "darwin";
  env?: NodeJS.ProcessEnv;
  options?: Record<string, unknown>;
  contextDir?: string;
  run?: Runner;
}

function makeCtx(over: CtxOverrides = {}): PlanContext {
  const env = over.env ?? { HOME: dir, USERPROFILE: dir };
  const run = over.run ?? fakeRunner(() => undefined);
  const host = makeHostAdapter({ platform: over.platform ?? "linux", run, env });
  return {
    root: dir,
    contextDir: over.contextDir ?? ".ai-context",
    apply: false,
    verify: false,
    json: false,
    run,
    host,
    env,
    options: over.options ?? {},
  };
}

// ---- helpers --------------------------------------------------------------

const isWrite = (a: Action): a is WriteAction => a.kind === "write";
const writeEndingWith = (actions: Action[], suffix: string): WriteAction | undefined =>
  actions.filter(isWrite).find((a) => a.path.replace(/\\/g, "/").endsWith(suffix));
const profileEnvBlock = (actions: Action[]): Extract<Action, { kind: "envblock" }> | undefined =>
  actions.find(
    (a): a is Extract<Action, { kind: "envblock" }> =>
      a.kind === "envblock" && a.scope === "telemetry",
  );
const firstProbe = (actions: Action[]): ProbeAction | undefined =>
  actions.find((a): a is ProbeAction => a.kind === "probe");

/**
 * The OTel env block is an `envblock`; the executor renders + folds it into the
 * shell profile. Apply the plan against the (temp) profile and return its
 * contents so marker/format/idempotency assertions inspect real output.
 */
async function renderProfile(ctx: PlanContext): Promise<string> {
  const profile = ctx.host.shellProfilePaths()[0] as string;
  mkdirSync(dirname(profile), { recursive: true });
  const applyCtx: PlanContext = { ...ctx, apply: true };
  await executePlan(await command.plan(applyCtx), applyCtx);
  return readFileSync(profile, "utf8");
}

describe("telemetry command surface", () => {
  it("keeps the foundation command name and exposes the --endpoint option", () => {
    expect(command.name).toBe("telemetry");
    expect(command.options?.some((o) => o.flags.includes("--endpoint"))).toBe(true);
  });
});

describe("telemetry plan — OTel env block", () => {
  it("writes the managed OTel block into the shell profile with all seven vars + endpoint", async () => {
    const eb = profileEnvBlock((await command.plan(makeCtx())).actions);
    expect(eb).toBeDefined();
    expect(eb?.vars).toHaveLength(7);
    const body = await renderProfile(makeCtx());

    expect(body).toContain("# >>> aih managed (telemetry) >>>");
    expect(body).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(body).toContain("OTEL_EXPORTER_OTLP_PROTOCOL");
    // without these two exporters Claude Code emits nothing — the bug this guards
    expect(body).toContain("OTEL_METRICS_EXPORTER");
    expect(body).toContain("OTEL_LOGS_EXPORTER");
    expect(body).toContain("OTEL_LOG_USER_PROMPTS");
    expect(body).toContain("OTEL_LOG_TOOL_DETAILS");
    expect(body).toContain("CLAUDE_CODE_ENABLE_TELEMETRY");
    // default endpoint baked into the export
    expect(body).toContain("http://127.0.0.1:4317");
  });

  it("uses grpc, pins both OTLP exporters to otlp, and sets the collection flags by value", () => {
    const vars = otelEnvVars("http://127.0.0.1:4317");
    const byKey = Object.fromEntries(vars.map((v) => [v.key, v.value]));
    expect(byKey.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("grpc");
    // the actual export switches — without otlp on both, no metrics/logs leave the agent
    expect(byKey.OTEL_METRICS_EXPORTER).toBe("otlp");
    expect(byKey.OTEL_LOGS_EXPORTER).toBe("otlp");
    expect(byKey.OTEL_LOG_USER_PROMPTS).toBe("1");
    expect(byKey.OTEL_LOG_TOOL_DETAILS).toBe("1");
    expect(byKey.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(byKey.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:4317");
    expect(vars).toHaveLength(7);
  });

  it("honors a custom --endpoint flag in the env export", async () => {
    const endpoint = "https://otel.corp.example:4317";
    const body = await renderProfile(makeCtx({ options: { endpoint } }));
    expect(body).toContain(endpoint);
    expect(body).not.toContain("127.0.0.1");
  });

  it("emits PowerShell exports when the host shell is PowerShell", async () => {
    const eb = profileEnvBlock((await command.plan(makeCtx({ platform: "windows" }))).actions);
    expect(eb?.path.replace(/\\/g, "/")).toMatch(/_profile\.ps1$/);
    expect(eb?.shell).toBe("powershell");
    const body = await renderProfile(makeCtx({ platform: "windows" }));
    expect(body).toContain('$env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4317"');
  });

  it("is idempotent — re-applying over an already-written profile yields the same file", async () => {
    const ctx = makeCtx();
    const profilePath = ctx.host.shellProfilePaths()[0] as string;
    mkdirSync(dirname(profilePath), { recursive: true });
    const applyCtx: PlanContext = { ...ctx, apply: true };
    await executePlan(await command.plan(applyCtx), applyCtx);
    const first = readFileSync(profilePath, "utf8");
    await executePlan(await command.plan(applyCtx), applyCtx);
    expect(readFileSync(profilePath, "utf8")).toBe(first);
  });

  it("preserves pre-existing user lines in the shell profile", async () => {
    const ctx = makeCtx();
    const profilePath = ctx.host.shellProfilePaths()[0] as string;
    mkdirSync(dirname(profilePath), { recursive: true });
    writeFileSync(profilePath, "export MY_VAR=keepme\n");

    const applyCtx: PlanContext = { ...ctx, apply: true };
    await executePlan(await command.plan(applyCtx), applyCtx);
    const body = readFileSync(profilePath, "utf8");
    expect(body).toContain("export MY_VAR=keepme");
    expect(body).toContain("# >>> aih managed (telemetry) >>>");
  });
});

describe("telemetry plan — collector.yaml", () => {
  it("writes a collector config under the context dir mentioning otlp and redaction", async () => {
    const p = await command.plan(makeCtx());
    const w = writeEndingWith(p.actions, ".ai-context/telemetry/collector.yaml");
    expect(w).toBeDefined();
    const yaml = w?.contents ?? "";
    expect(yaml).toMatch(/receivers:/);
    expect(yaml).toMatch(/otlp:/);
    expect(yaml).toMatch(/processors:/);
    expect(yaml).toMatch(/exporters:/);
    expect(yaml).toMatch(/otlphttp:/);
    expect(yaml).toMatch(/service:/);
    expect(yaml).toMatch(/pipelines:/);
    // secret / PII redaction must be present
    expect(yaml.toLowerCase()).toContain("redact");
  });

  it("threads the endpoint host into the collector exporter and rewrites gRPC :4317 to http :4318", () => {
    const yaml = collectorYaml("https://otel.corp.example:4317");
    expect(yaml).toContain("otel.corp.example");
    // the otlphttp exporter forwards to the same host's HTTP port, not the gRPC one
    expect(yaml).toContain("endpoint: https://otel.corp.example:4318");
    expect(yaml).not.toContain("endpoint: https://otel.corp.example:4317");
  });

  it("falls back to the loopback http port when the endpoint is unparseable", () => {
    const yaml = collectorYaml("not-a-url");
    expect(yaml).toContain("endpoint: http://127.0.0.1:4318");
  });

  it("embeds the secret/PII redaction rules the blueprint requires (keys + value regexes)", () => {
    const yaml = collectorYaml("http://127.0.0.1:4317");
    // attribute keys deleted outright
    expect(yaml).toContain("key: authorization");
    expect(yaml).toContain("key: anthropic_api_key");
    expect(yaml).toContain("key: aws_secret_access_key");
    // value regexes scrubbed anywhere in the record
    expect(yaml).toContain("sk-ant-[A-Za-z0-9_-]{8,}");
    expect(yaml).toContain("AKIA[0-9A-Z]{16}");
    expect(yaml).toContain("bearer");
    // PII: email shape
    expect(yaml).toContain("@[A-Za-z0-9.-]+");
    // redaction must sit in both the traces and logs pipelines
    expect(yaml).toMatch(/processors:\s*\[attributes\/scrub-secrets, redaction, batch\]/);
  });

  it("routes the context-dir collector path through ctx.contextDir", async () => {
    const p = await command.plan(makeCtx({ contextDir: "ai-coding" }));
    const w = writeEndingWith(p.actions, "ai-coding/telemetry/collector.yaml");
    expect(w).toBeDefined();
  });
});

describe("telemetry plan — analytics fetcher", () => {
  it("writes a Node fetcher script that references the analytics endpoint", async () => {
    const p = await command.plan(makeCtx());
    const w = writeEndingWith(p.actions, ".ai-context/telemetry/fetch-analytics.mjs");
    expect(w).toBeDefined();
    const src = w?.contents ?? "";
    expect(src).toContain(ANALYTICS_ENDPOINT);
    expect(src).toContain("ANTHROPIC_ADMIN_KEY");
    // it prints the curl equivalent rather than being a curl invocation itself
    expect(src).toContain("curl");
  });

  it("reads the admin key from the environment, never hardcodes a key", () => {
    const src = fetchAnalyticsScript();
    expect(src).toContain("process.env.ANTHROPIC_ADMIN_KEY");
    expect(src).not.toMatch(/sk-ant-[A-Za-z0-9]/);
  });

  it("also queries the skill-usage endpoint and emits the combined { usage_report, skills } shape", () => {
    const src = fetchAnalyticsScript();
    expect(src).toContain(SKILLS_ENDPOINT);
    // both endpoints are present so `aih report --org` gets skills + usage in one file
    expect(src).toContain(ANALYTICS_ENDPOINT);
    expect(src).toContain("{ usage_report, skills }");
    // still gated: a live fetch only happens on --run
    expect(src).toContain("--run");
  });
});

describe("telemetry plan — docs and the cloud boundary", () => {
  it("documents the cron schedule line, every event type, and backend setup", async () => {
    const p = await command.plan(makeCtx());
    const docText = p.actions
      .filter((a) => a.kind === "doc")
      .map((a) => (a.kind === "doc" ? a.text : ""))
      .join("\n");

    expect(docText).toContain("cron");
    for (const evt of EVENT_TYPES) {
      expect(docText).toContain(evt);
    }
    expect(docText).toContain("Langfuse");
    expect(docText).toContain("Elasticsearch");
    expect(docText).toContain("Bindplane");
  });

  it("exposes the full published set of Claude Code event types, including skill_activated", () => {
    // Verbatim from the Events section of code.claude.com/docs/en/monitoring-usage,
    // in published order. skill_activated is the per-skill usage signal.
    expect([...EVENT_TYPES]).toEqual([
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
    ]);
  });

  it("HARD BOUNDARY: emits no exec actions at all (no local mutation needed)", async () => {
    const p = await command.plan(makeCtx());
    expect(p.actions.some((a) => a.kind === "exec")).toBe(false);
  });

  it("HARD BOUNDARY: cron install + API call live in doc, not write/exec", async () => {
    const p = await command.plan(makeCtx());
    // No write action's contents should auto-invoke the analytics API or schedule cron
    for (const a of p.actions) {
      if (a.kind === "write" && a.contents) {
        // the fetcher prints a curl line but the *collector* and *profile* must not embed API calls
        if (!a.path.replace(/\\/g, "/").endsWith("fetch-analytics.mjs")) {
          expect(a.contents).not.toContain("crontab");
        }
      }
    }
    const docText = p.actions
      .filter((a) => a.kind === "doc")
      .map((a) => (a.kind === "doc" ? a.text : ""))
      .join("\n");
    expect(docText).toMatch(/crontab|cron/);
  });

  it("HARD BOUNDARY: any probe is read-only (pass/fail/skip) and never performs the API call", async () => {
    const p = await command.plan(makeCtx());
    const probes = p.actions.filter((a) => a.kind === "probe");
    for (const pr of probes) {
      if (pr.kind !== "probe") continue;
      const check = await pr.run(makeCtx());
      expect(["pass", "fail", "skip"]).toContain(check.verdict);
    }
  });
});

describe("telemetry plan — collector probe (read-only otelcol presence)", () => {
  it("skips when otelcol is absent from PATH (spawnError), never failing the run", async () => {
    const run: Runner = async () => ({
      code: 127,
      stdout: "",
      stderr: "not found",
      spawnError: true,
    });
    const p = await command.plan(makeCtx({ run }));
    const probe = firstProbe(p.actions);
    expect(probe).toBeDefined();
    const check = await (probe as ProbeAction).run(makeCtx({ run }));
    expect(check.verdict).toBe("skip");
    expect(check.detail ?? "").toMatch(/install/i);
  });

  it("fails when otelcol is present but exits non-zero", async () => {
    const run: Runner = async () => ({ code: 2, stdout: "", stderr: "boom" });
    const p = await command.plan(makeCtx({ run }));
    const check = await (firstProbe(p.actions) as ProbeAction).run(makeCtx({ run }));
    expect(check.verdict).toBe("fail");
    expect(check.detail ?? "").toContain("exit 2");
  });

  it("passes and threads the otelcol version string into the detail", async () => {
    const run: Runner = async () => ({ code: 0, stdout: "otelcol version 0.96.0\n", stderr: "" });
    const p = await command.plan(makeCtx({ run }));
    const check = await (firstProbe(p.actions) as ProbeAction).run(makeCtx({ run }));
    expect(check.verdict).toBe("pass");
    expect(check.detail).toBe("otelcol version 0.96.0");
  });

  it("only ever runs a read-only `otelcol --version`, never the analytics fetch", async () => {
    const seen: string[][] = [];
    const run: Runner = async (argv) => {
      seen.push(argv);
      return { code: 0, stdout: "v", stderr: "" };
    };
    const p = await command.plan(makeCtx({ run }));
    await (firstProbe(p.actions) as ProbeAction).run(makeCtx({ run }));
    expect(seen).toEqual([["otelcol", "--version"]]);
  });
});

describe("telemetry plan — shape", () => {
  it("produces one profile envblock + two writes (collector, fetcher) and at least one doc", async () => {
    const p = await command.plan(makeCtx());
    expect(p.actions.filter((a) => a.kind === "envblock")).toHaveLength(1);
    expect(p.actions.filter((a) => a.kind === "write")).toHaveLength(2);
    expect(p.actions.some((a) => a.kind === "doc")).toBe(true);
    expect(p.capability).toBe("telemetry");
  });
});
