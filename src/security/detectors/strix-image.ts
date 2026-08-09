import type { Runner } from "../../internals/proc.js";
import { scrubDockerClientEnv } from "../../trust/fetch.js";
import { STRIX_RELEASE_VERSION } from "./strix.js";
import type { StrixSandboxPlatform } from "./types.js";

export const STRIX_SANDBOX_IMAGE_REPOSITORY = "ghcr.io/usestrix/strix-sandbox";
export const STRIX_SANDBOX_IMAGE_VERSION = "1.3.0";
export const STRIX_SANDBOX_IMAGE_TAG = `${STRIX_SANDBOX_IMAGE_REPOSITORY}:${STRIX_SANDBOX_IMAGE_VERSION}`;
export const STRIX_SANDBOX_IMAGE_INDEX_DIGEST =
  "sha256:f6906c3114e504fd1a218fcf028d7a0e46851118403a438b63956de6ea7c4331";
export const STRIX_SANDBOX_IMAGE_MANIFEST_DIGESTS = Object.freeze({
  "linux/amd64": "sha256:e5e5d9927f15ca95ad49804ef7d22439771cd27378f400da6edd47556799baff",
  "linux/arm64": "sha256:38f9eea087079763312877eaf59047c3bd61ece67ab3479c1da63dc48fe50587",
} as const);

export type StrixPreflightUnavailableReason =
  | "unsupported-platform"
  | "strix-unavailable"
  | "strix-version-mismatch"
  | "sandbox-image-unavailable"
  | "sandbox-image-identity-mismatch";

export type StrixPreflightResult =
  | {
      state: "ready";
      cliVersion: typeof STRIX_RELEASE_VERSION;
      image: {
        indexDigest: typeof STRIX_SANDBOX_IMAGE_INDEX_DIGEST;
        manifestDigest: string;
        platform: StrixSandboxPlatform;
        reference: string;
      };
    }
  | { state: "unavailable"; reason: StrixPreflightUnavailableReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactStrixVersion(stdout: string): boolean {
  return /^strix 1\.5\.2\r?\n?$/.test(stdout);
}

function verifiedImage(
  stdout: string,
  platform: StrixSandboxPlatform,
): StrixPreflightResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.Descriptor)) return undefined;
  const expectedArchitecture = platform === "linux/amd64" ? "amd64" : "arm64";
  const expectedManifest = STRIX_SANDBOX_IMAGE_MANIFEST_DIGESTS[platform];
  const expectedIndexReference = `${STRIX_SANDBOX_IMAGE_REPOSITORY}@${STRIX_SANDBOX_IMAGE_INDEX_DIGEST}`;
  if (
    parsed.Os !== "linux" ||
    parsed.Architecture !== expectedArchitecture ||
    parsed.Descriptor.digest !== expectedManifest ||
    !Array.isArray(parsed.RepoDigests) ||
    !parsed.RepoDigests.some((value) => value === expectedIndexReference)
  ) {
    return undefined;
  }
  return {
    state: "ready",
    cliVersion: STRIX_RELEASE_VERSION,
    image: {
      indexDigest: STRIX_SANDBOX_IMAGE_INDEX_DIGEST,
      manifestDigest: expectedManifest,
      platform,
      reference: `${STRIX_SANDBOX_IMAGE_REPOSITORY}@${expectedManifest}`,
    },
  };
}

export function strixVersionArgv(): string[] {
  return ["strix", "--version"];
}

export function strixImageInspectArgv(): string[] {
  return ["docker", "image", "inspect", STRIX_SANDBOX_IMAGE_TAG, "--format", "{{json .}}"];
}

export async function preflightStrix(
  run: Runner,
  platform: StrixSandboxPlatform,
  env: NodeJS.ProcessEnv,
  timeoutMs = 5_000,
): Promise<StrixPreflightResult> {
  if (platform !== "linux/amd64" && platform !== "linux/arm64") {
    return { state: "unavailable", reason: "unsupported-platform" };
  }
  const childEnv = { ...scrubDockerClientEnv(env), STRIX_TELEMETRY: "0" };
  const version = await run(strixVersionArgv(), {
    env: childEnv,
    timeoutMs,
    maxBufferBytes: 4_096,
  });
  if (version.spawnError || version.code === 127) {
    return { state: "unavailable", reason: "strix-unavailable" };
  }
  if (
    version.code !== 0 ||
    version.truncated ||
    version.stderr.length !== 0 ||
    !exactStrixVersion(version.stdout)
  ) {
    return { state: "unavailable", reason: "strix-version-mismatch" };
  }

  const inspect = await run(strixImageInspectArgv(), {
    env: childEnv,
    timeoutMs,
    maxBufferBytes: 64 * 1024,
  });
  if (
    inspect.spawnError ||
    inspect.code === 127 ||
    inspect.code !== 0 ||
    inspect.truncated ||
    inspect.stdout.length === 0
  ) {
    return { state: "unavailable", reason: "sandbox-image-unavailable" };
  }
  return (
    verifiedImage(inspect.stdout, platform) ?? {
      state: "unavailable",
      reason: "sandbox-image-identity-mismatch",
    }
  );
}
