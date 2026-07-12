import type { Runner, RunResult } from "../internals/proc.js";
import type { Platform } from "../platform/base.js";
import { execArgv } from "../tools/install.js";
import { scrubDockerClientEnv } from "./fetch.js";

export const SKILLSPECTOR_IMAGE = "skillspector:aih-326a2b489411";
export const SKILLSPECTOR_SOURCE_REVISION = "326a2b489411a20ed742ff13701be39ba00063c8";
export const SKILLSPECTOR_IMAGE_DIGEST =
  "sha256:ee8a107dfd1c258e0afed303016a4220d174ba54bd1510bf73ed91f2825075ec";

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface SkillSpectorImageApproval {
  imageTag: string;
  imageDigest: string;
  sourceRevision: string;
}

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

function approvedSkillspectorImageDigests(
  approvedImages: readonly SkillSpectorImageApproval[] = [],
): Set<string> {
  return new Set([
    SKILLSPECTOR_IMAGE_DIGEST,
    ...approvedImages
      .filter(
        (approval) =>
          approval.imageTag === SKILLSPECTOR_IMAGE &&
          approval.sourceRevision === SKILLSPECTOR_SOURCE_REVISION &&
          IMAGE_DIGEST.test(approval.imageDigest),
      )
      .map((approval) => approval.imageDigest),
  ]);
}

function normalizedDigest(
  value: unknown,
  approvedImages: readonly SkillSpectorImageApproval[] = [],
): string | undefined {
  if (typeof value !== "string") return undefined;
  const allowed = approvedSkillspectorImageDigests(approvedImages);
  if (allowed.has(value)) return value;
  const suffix = value.split("@").at(-1);
  return suffix !== undefined && allowed.has(suffix) ? suffix : undefined;
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

export function verifiedSkillspectorImageReference(
  stdout: string,
  approvedImages: readonly SkillSpectorImageApproval[] = [],
): string | undefined {
  const inspect = parseImageInspect(stdout);
  if (inspect === undefined) return undefined;

  // Prefer `.Id`: on image stores where it is the manifest digest (e.g. the
  // containerd snapshotter, or any local build), this is the same identifier
  // it has always been.
  const idMatch = normalizedDigest(inspect.Id, approvedImages);
  if (idMatch !== undefined) return idMatch;

  // On other stores (e.g. the legacy graphdriver), `.Id` is a config hash, not
  // the manifest digest — a pulled image still carries the manifest digest in
  // `.RepoDigests`. Accept a match there too, but return the full entry
  // (`repo@sha256:...`) rather than the bare digest, so the result stays a
  // runnable, unambiguous content address for `docker run`.
  const repoDigests = inspect.RepoDigests;
  if (!Array.isArray(repoDigests)) return undefined;
  return repoDigests.find(
    (entry): entry is string =>
      typeof entry === "string" && normalizedDigest(entry, approvedImages) !== undefined,
  );
}

export async function resolveVerifiedSkillspectorImage(
  run: Runner,
  platform: Platform,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  approvedImages: readonly SkillSpectorImageApproval[] = [],
): Promise<{ image: string } | { reason: string }> {
  const childEnv = scrubDockerClientEnv(env);
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
  const verifiedImage = verifiedSkillspectorImageReference(image.stdout, approvedImages);
  if (verifiedImage === undefined) {
    const approved = approvedImages.length > 0 ? " or an org-policy approved local digest" : "";
    return {
      reason: `sandbox image ${SKILLSPECTOR_IMAGE} could not verify expected image digest ${SKILLSPECTOR_IMAGE_DIGEST}${approved}`,
    };
  }
  return { image: verifiedImage };
}
