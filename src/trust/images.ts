import type { Runner, RunResult } from "../internals/proc.js";
import type { Platform } from "../platform/base.js";
import { execArgv } from "../tools/install.js";
import { scrubFetchEnv } from "./fetch.js";

export const SKILLSPECTOR_IMAGE = "skillspector:aih-326a2b489411";
export const SKILLSPECTOR_SOURCE_REVISION = "326a2b489411a20ed742ff13701be39ba00063c8";
export const SKILLSPECTOR_IMAGE_DIGEST =
  "sha256:e82fd471e156ca5f431d5a1be18d37bc6bdf11f23b0f12f99c8899c12283fdfb";

const SKILLSPECTOR_IMAGE_DIGESTS = new Set([SKILLSPECTOR_IMAGE_DIGEST]);

function runSummary(result: RunResult): string {
  const output = (result.stderr || result.stdout).trim();
  if (output.length > 0) return output.slice(0, 400);
  if (result.code === null) return "process ended without an exit code";
  return `exit ${result.code}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseImageInspect(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(stdout.trim());
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizedDigest(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (SKILLSPECTOR_IMAGE_DIGESTS.has(value)) return value;
  const suffix = value.split("@").at(-1);
  return suffix !== undefined && SKILLSPECTOR_IMAGE_DIGESTS.has(suffix) ? suffix : undefined;
}

export function skillspectorDockerVersionArgv(platform: Platform): string[] {
  return execArgv(platform, ["docker", "--version"]);
}

export function skillspectorImageInspectArgv(platform: Platform): string[] {
  return execArgv(platform, [
    "docker",
    "image",
    "inspect",
    SKILLSPECTOR_IMAGE,
    "--format",
    "{{json .}}",
  ]);
}

export function verifiedSkillspectorImageReference(stdout: string): string | undefined {
  const inspect = parseImageInspect(stdout);
  if (inspect === undefined) return undefined;
  return normalizedDigest(inspect.Id);
}

export async function resolveVerifiedSkillspectorImage(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ image: string } | { reason: string }> {
  const childEnv = scrubFetchEnv(env);
  const docker = await run(skillspectorDockerVersionArgv(platform), {
    env: childEnv,
    timeoutMs,
  });
  if (docker.spawnError || docker.code === 127) {
    return { reason: `Docker is unavailable (${runSummary(docker)})` };
  }
  if (docker.code !== 0) return { reason: `docker --version failed (${runSummary(docker)})` };

  const image = await run(skillspectorImageInspectArgv(platform), {
    env: childEnv,
    timeoutMs,
  });
  if (image.spawnError || image.code === 127) {
    return { reason: `sandbox image ${SKILLSPECTOR_IMAGE} is unavailable (${runSummary(image)})` };
  }
  if (image.code !== 0 || image.stdout.trim().length === 0) {
    return {
      reason: `sandbox image ${SKILLSPECTOR_IMAGE} could not be inspected (${runSummary(image)})`,
    };
  }
  const verifiedImage = verifiedSkillspectorImageReference(image.stdout);
  if (verifiedImage === undefined) {
    return {
      reason: `sandbox image ${SKILLSPECTOR_IMAGE} could not verify expected image digest ${SKILLSPECTOR_IMAGE_DIGEST}`,
    };
  }
  return { image: verifiedImage };
}
