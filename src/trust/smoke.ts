import type { Runner, RunResult } from "../internals/proc.js";
import type { Check } from "../internals/verify.js";
import type { Platform } from "../platform/base.js";
import { MCP_CONFIG_FILES } from "../secrets/scan.js";
import { execArgv } from "../tools/install.js";
import { scrubFetchEnv } from "./fetch.js";
import { SKILLSPECTOR_IMAGE, SKILLSPECTOR_SOURCE_REVISION } from "./images.js";

export interface SandboxSmokeShape {
  skillDirs: readonly string[];
  installScripts: boolean;
  mcpConfig: boolean;
  packageManifests: readonly string[];
}

export interface SandboxSmokeOptions {
  env?: NodeJS.ProcessEnv;
  platform?: Platform;
  run?: Runner;
}

const SANDBOX_SMOKE_NAME = "skill sandbox smoke test";
const SANDBOX_SMOKE_MARKER = "aih sandbox smoke ok";
const SANDBOX_SMOKE_TIMEOUT_MS = 60_000;
const INCOMING_MCP_SMOKE_FILES = [...MCP_CONFIG_FILES, "mcp.json"];
const REVISION_LABELS = [
  "org.opencontainers.image.revision",
  "org.label-schema.vcs-ref",
  "aih.skillspector.revision",
];

function smokeReasons(shape: SandboxSmokeShape): string[] {
  if (shape.skillDirs.length === 0) return [];
  const reasons: string[] = [];
  if (shape.installScripts) reasons.push("install scripts");
  if (shape.mcpConfig) reasons.push("incoming MCP config");
  if (shape.packageManifests.length > 0) {
    reasons.push(`package manifest(s): ${shape.packageManifests.join(", ")}`);
  }
  return reasons;
}

function runSummary(result: RunResult): string {
  const output = (result.stderr || result.stdout).trim();
  if (output.length > 0) return output.slice(0, 400);
  if (result.code === null) return "process ended without an exit code";
  return `exit ${result.code}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function readableAny(paths: readonly string[]): string {
  return `( ${paths.map((path) => `test -r ${shellQuote(path)}`).join(" || ")} )`;
}

function sandboxSmokeScript(shape: SandboxSmokeShape): string {
  const commands = ["set -eu", "test -r /scan"];
  if (shape.packageManifests.length > 0) {
    commands.push(readableAny(shape.packageManifests.map((name) => `/scan/${name}`)));
  }
  if (shape.mcpConfig) {
    commands.push(readableAny(INCOMING_MCP_SMOKE_FILES.map((name) => `/scan/${name}`)));
  }
  if (shape.installScripts) {
    commands.push(
      [
        "install_hit=0",
        "test -f /scan/package.json && install_hit=1",
        "for file in /scan/install.* /scan/scripts/install.* /scan/*.sh /scan/*.ps1 /scan/scripts/*.sh /scan/scripts/*.ps1; do",
        '  test -f "$file" && install_hit=1',
        "done",
        'test "$install_hit" -eq 1',
      ].join("\n"),
    );
  }
  commands.push(`printf ${shellQuote(`${SANDBOX_SMOKE_MARKER}\n`)}`);
  return commands.join("\n");
}

function unavailableCheck(reason: string): Check {
  return {
    name: SANDBOX_SMOKE_NAME,
    verdict: "skip",
    code: "trust.sandbox-smoke-unavailable",
    detail: `sandbox smoke test skipped: ${reason}`,
  };
}

function notApplicableCheck(shape: SandboxSmokeShape): Check {
  const reason =
    shape.skillDirs.length === 0
      ? "no skill directories were found"
      : "skill shape has no install scripts, package manifests, or incoming MCP config";
  return {
    name: SANDBOX_SMOKE_NAME,
    verdict: "skip",
    detail: `sandbox smoke test not applicable: ${reason}`,
  };
}

export function sandboxSmokeDockerVersionArgv(platform: Platform): string[] {
  return execArgv(platform, ["docker", "--version"]);
}

export function sandboxSmokeImageInspectArgv(platform: Platform): string[] {
  return execArgv(platform, [
    "docker",
    "image",
    "inspect",
    SKILLSPECTOR_IMAGE,
    "--format",
    "{{json .Config.Labels}}",
  ]);
}

export function sandboxSmokeDockerRunArgv(
  platform: Platform,
  tree: string,
  shape: SandboxSmokeShape,
): string[] {
  return execArgv(platform, [
    "docker",
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    "--mount",
    `type=bind,source=${tree},target=/scan,readonly`,
    "--entrypoint",
    "/bin/sh",
    SKILLSPECTOR_IMAGE,
    "-c",
    sandboxSmokeScript(shape),
  ]);
}

function parseImageLabels(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(stdout.trim());
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function verifiedImageRevision(stdout: string): boolean {
  const labels = parseImageLabels(stdout);
  if (labels === undefined) return false;
  return REVISION_LABELS.some((label) => labels[label] === SKILLSPECTOR_SOURCE_REVISION);
}

async function sandboxUnavailable(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const childEnv = scrubFetchEnv(env);
  const docker = await run(sandboxSmokeDockerVersionArgv(platform), {
    env: childEnv,
    timeoutMs: 10_000,
  });
  if (docker.spawnError || docker.code === 127)
    return `Docker is unavailable (${runSummary(docker)})`;
  if (docker.code !== 0) return `docker --version failed (${runSummary(docker)})`;

  const image = await run(sandboxSmokeImageInspectArgv(platform), {
    env: childEnv,
    timeoutMs: 10_000,
  });
  if (image.spawnError || image.code === 127) {
    return `sandbox image ${SKILLSPECTOR_IMAGE} is unavailable (${runSummary(image)})`;
  }
  if (image.code !== 0 || image.stdout.trim().length === 0) {
    return `sandbox image ${SKILLSPECTOR_IMAGE} could not be inspected (${runSummary(image)})`;
  }
  if (!verifiedImageRevision(image.stdout)) {
    return `sandbox image ${SKILLSPECTOR_IMAGE} could not verify expected source revision ${SKILLSPECTOR_SOURCE_REVISION}`;
  }
  return undefined;
}

export async function sandboxSmokeCheck(
  root: string,
  shape: SandboxSmokeShape,
  options: SandboxSmokeOptions,
): Promise<Check> {
  const reasons = smokeReasons(shape);
  if (reasons.length === 0) return notApplicableCheck(shape);
  if (options.run === undefined || options.platform === undefined || options.env === undefined) {
    return unavailableCheck("detector runtime is missing (run/platform/env)");
  }

  const unavailable = await sandboxUnavailable(options.run, options.platform, options.env);
  if (unavailable !== undefined) return unavailableCheck(unavailable);

  const smoke = await options.run(sandboxSmokeDockerRunArgv(options.platform, root, shape), {
    env: scrubFetchEnv(options.env),
    timeoutMs: SANDBOX_SMOKE_TIMEOUT_MS,
  });
  const reasonText = reasons.join("; ");
  if (!smoke.spawnError && smoke.code === 0 && smoke.stdout.includes(SANDBOX_SMOKE_MARKER)) {
    const output = runSummary(smoke);
    return {
      name: SANDBOX_SMOKE_NAME,
      verdict: "pass",
      detail: `Docker read-only/no-network sandbox smoke completed for ${reasonText}; evidence: ${output}`,
    };
  }
  return {
    name: SANDBOX_SMOKE_NAME,
    verdict: "fail",
    code: "trust.sandbox-smoke-failed",
    detail: `sandbox smoke test failed for ${reasonText}: ${runSummary(smoke)}`,
  };
}
