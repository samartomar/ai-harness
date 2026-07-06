import type { Runner, RunResult } from "../internals/proc.js";
import type { Check } from "../internals/verify.js";
import type { Platform } from "../platform/base.js";
import { MCP_CONFIG_FILES } from "../secrets/scan.js";
import { execArgv } from "../tools/install.js";
import { dockerBindMountArg } from "./docker.js";
import { scrubFetchEnv } from "./fetch.js";
import {
  resolveVerifiedSkillspectorImage,
  SKILLSPECTOR_IMAGE,
  skillspectorDockerVersionArgv,
  skillspectorImageInspectArgv,
} from "./images.js";

export interface SandboxSmokeShape {
  skillDirs: readonly string[];
  installScripts: boolean;
  installScriptFiles?: readonly string[];
  mcpConfig: boolean;
  mcpConfigFiles?: readonly string[];
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
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const output =
    stdout.length > 0 && stderr.length > 0
      ? `stderr: ${stderr}\nstdout: ${stdout}`
      : stderr || stdout;
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

function scanPath(rel: string): string {
  return `/scan/${rel.replace(/\\/g, "/")}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sandboxSmokeScript(shape: SandboxSmokeShape): string {
  const commands = ["set -eu", "test -r /scan"];
  if (shape.packageManifests.length > 0) {
    commands.push(readableAny(shape.packageManifests.map(scanPath)));
  }
  if (shape.mcpConfig) {
    const mcpConfigFiles = shape.mcpConfigFiles ?? INCOMING_MCP_SMOKE_FILES;
    commands.push(readableAny(mcpConfigFiles.map(scanPath)));
  }
  if (shape.installScripts) {
    const installEvidenceFiles = uniqueStrings(shape.installScriptFiles ?? []);
    if (installEvidenceFiles.length > 0) {
      commands.push(readableAny(installEvidenceFiles.map(scanPath)));
    } else {
      commands.push(
        [
          "install_hit=0",
          "test -f /scan/package.json && install_hit=1",
          "for file in /scan/install /scan/setup /scan/scripts/install /scan/scripts/setup /scan/install.* /scan/setup.* /scan/scripts/install.* /scan/scripts/setup.* /scan/*.sh /scan/*.ps1 /scan/scripts/*.sh /scan/scripts/*.ps1; do",
          '  test -f "$file" && install_hit=1',
          "done",
          'test "$install_hit" -eq 1',
        ].join("\n"),
      );
    }
  }
  commands.push(`printf ${shellQuote(`${SANDBOX_SMOKE_MARKER}\n`)}`);
  return commands.join("\n");
}

function unavailableCheck(reason: string): Check {
  return {
    name: SANDBOX_SMOKE_NAME,
    verdict: "fail",
    code: "trust.sandbox-smoke-unavailable",
    detail: `sandbox smoke test unavailable (trust.sandbox-smoke-unavailable): ${reason}`,
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
  return skillspectorDockerVersionArgv(platform);
}

export function sandboxSmokeImageInspectArgv(platform: Platform): string[] {
  return skillspectorImageInspectArgv(platform);
}

export function sandboxSmokeDockerRunArgv(
  platform: Platform,
  tree: string,
  shape: SandboxSmokeShape,
  image: string = SKILLSPECTOR_IMAGE,
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
    dockerBindMountArg(tree, "/scan"),
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    sandboxSmokeScript(shape),
  ]);
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

  const availability = await resolveVerifiedSkillspectorImage(
    options.run,
    options.platform,
    options.env,
    10_000,
  );
  if ("reason" in availability) return unavailableCheck(availability.reason);

  let smokeArgv: string[];
  try {
    smokeArgv = sandboxSmokeDockerRunArgv(options.platform, root, shape, availability.image);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return unavailableCheck(reason);
  }
  const smoke = await options.run(smokeArgv, {
    env: scrubFetchEnv(options.env),
    timeoutMs: SANDBOX_SMOKE_TIMEOUT_MS,
  });
  const reasonText = reasons.join("; ");
  if (!smoke.spawnError && smoke.code === 0 && smoke.stdout.includes(SANDBOX_SMOKE_MARKER)) {
    const output = runSummary(smoke);
    return {
      name: SANDBOX_SMOKE_NAME,
      verdict: "pass",
      detail: `Docker read-only/no-network sandbox smoke completed for ${reasonText}; marker: ${SANDBOX_SMOKE_MARKER}; evidence: ${output}`,
    };
  }
  return {
    name: SANDBOX_SMOKE_NAME,
    verdict: "fail",
    code: "trust.sandbox-smoke-failed",
    detail: `sandbox smoke test failed for ${reasonText}: ${runSummary(smoke)}`,
  };
}
