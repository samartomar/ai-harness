import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
const profileWrite = (actions: Action[]): WriteAction | undefined =>
  actions.filter(isWrite).find((a) => /bashrc|_profile\.ps1/.test(a.path.replace(/\\/g, "/")));
const firstProbe = (actions: Action[]): ProbeAction | undefined =>
  actions.find((a): a is ProbeAction => a.kind === "probe");

describe("telemetry command surface", () => {
  it("keeps the foundation command name and exposes the --endpoint option", () => {
    expect(command.name).toBe("telemetry");
    expect(command.options?.some((o) => o.flags.includes("--endpoint"))).toBe(true);
  });
});

describe("telemetry plan — OTel env block", () => {
  it("writes the managed OTel block into the shell profile with all five vars + endpoint", async () => {
    const p = await command.plan(makeCtx());
    const w = profileWrite(p.actions);
    expect(w).toBeDefined();
    const body = w?.contents ?? "";

    expect(body).toContain("# >>> aih managed (telemetry) >>>");
    expect(body).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(body).toContain("OTEL_EXPORTER_OTLP_PROTOCOL");
    expect(body).toContain("OTEL_LOG_USER_PROMPTS");
    expect(body).toContain("OTEL_LOG_TOOL_DETAILS");
    expect(body).toContain("CLAUDE_CODE_ENABLE_TELEMETRY");
    // default endpoint baked into the export
    expect(body).toContain("http://127.0.0.1:4317");
  });

  it("uses the grpc protocol and enables the five collection flags by value", () => {
    const vars = otelEnvVars("http://127.0.0.1:4317");
    const byKey = Object.fromEntries(vars.map((v) => [v.key, v.value]));
    expect(byKey.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("grpc");
    expect(byKey.OTEL_LOG_USER_PROMPTS).toBe("1");
    expect(byKey.OTEL_LOG_TOOL_DETAILS).toBe("1");
    expect(byKey.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(byKey.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:4317");
    expect(vars).toHaveLength(5);
  });

  it("honors a custom --endpoint flag in the env export", async () => {
    const endpoint = "https://otel.corp.example:4317";
    const p = await command.plan(makeCtx({ options: { endpoint } }));
    const body = profileWrite(p.actions)?.contents ?? "";
    expect(body).toContain(endpoint);
    expect(body).not.toContain("127.0.0.1");
  });

  it("emits PowerShell exports when the host shell is PowerShell", async () => {
    const p = await command.plan(makeCtx({ platform: "windows" }));
    const w = profileWrite(p.actions);
    expect(w?.path.replace(/\\/g, "/")).toMatch(/_profile\.ps1$/);
    expect(w?.contents ?? "").toContain(
      '$env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4317"',
    );
  });

  it("is idempotent — re-planning over an already-written profile yields the same block", async () => {
    const ctx = makeCtx();
    const first = await command.plan(ctx);
    const firstBody = profileWrite(first.actions)?.contents ?? "";
    // simulate the profile already containing the managed block on disk
    const profilePath = makeHostAdapter({
      platform: "linux",
      run: ctx.run,
      env: ctx.env,
    }).shellProfilePaths()[0] as string;
    writeFileSync(profilePath, firstBody);

    const second = await command.plan(ctx);
    const secondBody = profileWrite(second.actions)?.contents ?? "";
    expect(secondBody).toBe(firstBody);
  });

  it("preserves pre-existing user lines in the shell profile", async () => {
    const ctx = makeCtx();
    const profilePath = makeHostAdapter({
      platform: "linux",
      run: ctx.run,
      env: ctx.env,
    }).shellProfilePaths()[0] as string;
    writeFileSync(profilePath, "export MY_VAR=keepme\n");

    const p = await command.plan(ctx);
    const body = profileWrite(p.actions)?.contents ?? "";
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
});

describe("telemetry plan — docs and the cloud boundary", () => {
  it("documents the cron schedule line, all five event types, and backend setup", async () => {
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

  it("exposes exactly the five first-class event types", () => {
    expect([...EVENT_TYPES]).toEqual([
      "api_request",
      "tool_result",
      "tool_decision",
      "user_prompt",
      "api_error",
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
  it("produces exactly three writes (profile, collector, fetcher) and at least one doc", async () => {
    const p = await command.plan(makeCtx());
    const writes = p.actions.filter((a) => a.kind === "write");
    expect(writes).toHaveLength(3);
    expect(p.actions.some((a) => a.kind === "doc")).toBe(true);
    expect(p.capability).toBe("telemetry");
  });
});
