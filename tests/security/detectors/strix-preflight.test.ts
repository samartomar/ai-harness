import { describe, expect, it } from "vitest";
import { fakeRunner, type RunOptions } from "../../../src/internals/proc.js";
import {
  STRIX_RELEASE_VERSION,
  STRIX_SOURCE_REPOSITORY,
  STRIX_SOURCE_REVISION,
} from "../../../src/security/detectors/strix.js";
import {
  preflightStrix,
  STRIX_SANDBOX_IMAGE_INDEX_DIGEST,
  STRIX_SANDBOX_IMAGE_MANIFEST_DIGESTS,
  STRIX_SANDBOX_IMAGE_TAG,
} from "../../../src/security/detectors/strix-image.js";

const amd64Inspect = JSON.stringify({
  RepoDigests: [`ghcr.io/usestrix/strix-sandbox@${STRIX_SANDBOX_IMAGE_INDEX_DIGEST}`],
  Descriptor: { digest: STRIX_SANDBOX_IMAGE_MANIFEST_DIGESTS["linux/amd64"] },
  Os: "linux",
  Architecture: "amd64",
});

describe("Strix release and sandbox preflight", () => {
  it("pins the approved source release and multi-platform image identities", () => {
    expect({
      repository: STRIX_SOURCE_REPOSITORY,
      version: STRIX_RELEASE_VERSION,
      revision: STRIX_SOURCE_REVISION,
      tag: STRIX_SANDBOX_IMAGE_TAG,
      index: STRIX_SANDBOX_IMAGE_INDEX_DIGEST,
      manifests: STRIX_SANDBOX_IMAGE_MANIFEST_DIGESTS,
    }).toEqual({
      repository: "usestrix/strix",
      version: "1.5.2",
      revision: "597aae67159636ee794a02a3cc1694138d619c44",
      tag: "ghcr.io/usestrix/strix-sandbox:1.3.0",
      index: "sha256:f6906c3114e504fd1a218fcf028d7a0e46851118403a438b63956de6ea7c4331",
      manifests: {
        "linux/amd64": "sha256:e5e5d9927f15ca95ad49804ef7d22439771cd27378f400da6edd47556799baff",
        "linux/arm64": "sha256:38f9eea087079763312877eaf59047c3bd61ece67ab3479c1da63dc48fe50587",
      },
    });
  });

  it("proves the exact installed CLI, index, runnable manifest, and platform", async () => {
    const calls: Array<{ argv: string[]; options: RunOptions | undefined }> = [];
    const run = fakeRunner((argv, options) => {
      calls.push({ argv, options });
      if (argv[0] === "strix") return { stdout: "strix 1.5.2\n" };
      if (argv[0] === "docker") return { stdout: amd64Inspect };
      throw new Error("unexpected command");
    });

    await expect(
      preflightStrix(run, "linux/amd64", {
        PATH: "/bin",
        HOME: "/operator",
        ANTHROPIC_API_KEY: "must-not-cross-preflight",
      }),
    ).resolves.toEqual({
      state: "ready",
      cliVersion: "1.5.2",
      image: {
        indexDigest: STRIX_SANDBOX_IMAGE_INDEX_DIGEST,
        manifestDigest: STRIX_SANDBOX_IMAGE_MANIFEST_DIGESTS["linux/amd64"],
        platform: "linux/amd64",
        reference: `ghcr.io/usestrix/strix-sandbox@${STRIX_SANDBOX_IMAGE_MANIFEST_DIGESTS["linux/amd64"]}`,
      },
    });

    expect(calls.map((call) => call.argv)).toEqual([
      ["strix", "--version"],
      ["docker", "image", "inspect", STRIX_SANDBOX_IMAGE_TAG, "--format", "{{json .}}"],
    ]);
    expect(calls.every((call) => call.options?.env?.STRIX_TELEMETRY === "0")).toBe(true);
    expect(calls.every((call) => call.options?.env?.ANTHROPIC_API_KEY === undefined)).toBe(true);
  });

  it.each([
    ["wrong CLI version", "strix 1.5.1\n", amd64Inspect, "strix-version-mismatch"],
    [
      "tag-only image",
      "strix 1.5.2\n",
      JSON.stringify({ RepoTags: [STRIX_SANDBOX_IMAGE_TAG], Os: "linux", Architecture: "amd64" }),
      "sandbox-image-identity-mismatch",
    ],
    [
      "index without runnable manifest",
      "strix 1.5.2\n",
      JSON.stringify({
        RepoDigests: [`ghcr.io/usestrix/strix-sandbox@${STRIX_SANDBOX_IMAGE_INDEX_DIGEST}`],
        Os: "linux",
        Architecture: "amd64",
      }),
      "sandbox-image-identity-mismatch",
    ],
    [
      "platform manifest without index",
      "strix 1.5.2\n",
      JSON.stringify({
        Descriptor: { digest: STRIX_SANDBOX_IMAGE_MANIFEST_DIGESTS["linux/amd64"] },
        Os: "linux",
        Architecture: "amd64",
      }),
      "sandbox-image-identity-mismatch",
    ],
    [
      "attestation manifest",
      "strix 1.5.2\n",
      JSON.stringify({
        RepoDigests: [`ghcr.io/usestrix/strix-sandbox@${STRIX_SANDBOX_IMAGE_INDEX_DIGEST}`],
        Descriptor: {
          digest: "sha256:09b7afd84381d233c36fc0098d900a7eedc263a328094a9153bd3cc96c0c3e01",
        },
        Os: "unknown",
        Architecture: "unknown",
      }),
      "sandbox-image-identity-mismatch",
    ],
  ])("fails closed for %s", async (_name, versionStdout, inspectStdout, reason) => {
    const run = fakeRunner((argv) =>
      argv[0] === "strix" ? { stdout: versionStdout } : { stdout: inspectStdout },
    );

    const result = await preflightStrix(run, "linux/amd64", {});
    expect(result).toEqual({ state: "unavailable", reason });
    expect(JSON.stringify(result)).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });

  it("does not inspect Docker after a failed, noisy, or ambiguous version probe", async () => {
    for (const stdout of [
      "1.5.2\n",
      "strix 1.5.2 extra\n",
      "warning\nstrix 1.5.2\n",
      "strix 1.5.2\u0000",
    ]) {
      let calls = 0;
      const run = fakeRunner(() => {
        calls += 1;
        return { stdout };
      });
      await expect(preflightStrix(run, "linux/amd64", {})).resolves.toEqual({
        state: "unavailable",
        reason: "strix-version-mismatch",
      });
      expect(calls).toBe(1);
    }
  });

  it("returns bounded stable reasons instead of subprocess output", async () => {
    const run = fakeRunner((argv) =>
      argv[0] === "strix"
        ? { stdout: "strix 1.5.2\n" }
        : { code: 1, stderr: `/home/operator/private\u0000${"x".repeat(20_000)}` },
    );

    await expect(preflightStrix(run, "linux/arm64", {})).resolves.toEqual({
      state: "unavailable",
      reason: "sandbox-image-unavailable",
    });
  });
});
