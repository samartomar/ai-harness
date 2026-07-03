import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { verifyReleaseCommand } from "../../src/release/verify-release.js";

function ctx(run: Runner, options: Record<string, unknown> = {}): PlanContext {
  return {
    root: process.cwd(),
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options,
  };
}

describe("verify-release command", () => {
  const tarball = "aihq-harness-1.0.1.tgz";
  const tarballBody = "fake tarball bytes\n";
  const tarballHash = createHash("sha256").update(tarballBody).digest("hex");

  function seedReleaseAssets(argv: string[]): void {
    const dir = argv[argv.indexOf("--dir") + 1];
    if (dir === undefined) throw new Error("missing --dir");
    writeFileSync(`${dir}/SHA256SUMS.txt`, `${tarballHash}  ${tarball}\n`, "utf8");
    writeFileSync(`${dir}/SHA256SUMS.txt.sigstore.json`, "{}\n", "utf8");
  }

  function seedPackedTarball(argv: string[]): void {
    const dir = argv[argv.indexOf("--pack-destination") + 1];
    if (dir === undefined) throw new Error("missing --pack-destination");
    writeFileSync(`${dir}/${tarball}`, tarballBody, "utf8");
  }

  it("is a read-only top-level command with a version positional", () => {
    expect(verifyReleaseCommand).toMatchObject({
      name: "verify-release",
      readOnly: true,
      positional: { name: "version", required: false, optionName: "version" },
    });
  });

  it("runs npm, GitHub release, cosign, and tarball hash checks without overstating skips", async () => {
    const seen: string[][] = [];
    const run = fakeRunner((argv) => {
      seen.push(argv);
      if (argv.slice(0, 4).join(" ") === "npm view @aihq/harness version") {
        return { code: 0, stdout: "1.0.1\n" };
      }
      if (argv[0] === "npm" && argv[1] === "install") return { code: 0, stdout: "installed" };
      if (argv.slice(0, 3).join(" ") === "npm audit signatures") return { code: 0, stdout: "ok" };
      if (argv[0] === "gh" && argv[1] === "release" && argv[2] === "download") {
        seedReleaseAssets(argv);
        return { code: 0 };
      }
      if (argv[0] === "cosign" && argv[1] === "verify-blob") return { code: 0, stdout: "ok" };
      if (argv[0] === "npm" && argv[1] === "pack") {
        seedPackedTarball(argv);
        return { code: 0, stdout: `${tarball}\n` };
      }
      return undefined;
    });

    const result = await executePlan(await verifyReleaseCommand.plan(ctx(run)), ctx(run));

    expect(result.report?.ok).toBe(true);
    expect(result.report?.checks.map((check) => check.verdict)).toEqual(["pass", "pass", "pass"]);
    expect(
      seen.filter((argv) => argv.slice(0, 4).join(" ") === "npm view @aihq/harness version"),
    ).toHaveLength(1);
    const install = seen.find((argv) => argv[0] === "npm" && argv[1] === "install");
    expect(install).toEqual(
      expect.arrayContaining([
        "--ignore-scripts",
        "--audit=false",
        "--fund=false",
        "--prefix",
        "@aihq/harness@1.0.1",
      ]),
    );
    expect(seen.some((argv) => argv.join(" ").startsWith("npm audit signatures --prefix"))).toBe(
      true,
    );
    expect(seen.some((argv) => argv.join(" ").includes("gh release download v1.0.1"))).toBe(true);
    const cosign = seen.find((argv) => argv[0] === "cosign" && argv[1] === "verify-blob");
    expect(cosign).toEqual(
      expect.arrayContaining([
        "--certificate-identity",
        "https://github.com/samartomar/ai-harness/.github/workflows/release.yml@refs/tags/v1.0.1",
      ]),
    );
  });

  it("skips only the cosign leg when cosign is unavailable", async () => {
    const run = fakeRunner((argv) => {
      if (argv.slice(0, 3).join(" ") === "npm audit signatures") return { code: 0, stdout: "ok" };
      if (argv[0] === "gh" && argv[1] === "release" && argv[2] === "download") {
        seedReleaseAssets(argv);
        return { code: 0 };
      }
      if (argv[0] === "npm" && argv[1] === "install") return { code: 0, stdout: "installed" };
      if (argv[0] === "cosign") return { code: 127, spawnError: true, stderr: "not found" };
      if (argv[0] === "npm" && argv[1] === "pack") {
        seedPackedTarball(argv);
        return { code: 0, stdout: `${tarball}\n` };
      }
      return undefined;
    });

    const result = await executePlan(
      await verifyReleaseCommand.plan(ctx(run, { version: "1.0.1" })),
      ctx(run, { version: "1.0.1" }),
    );

    expect(result.report?.ok).toBe(true);
    expect(result.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "release cosign bundle",
          verdict: "skip",
          detail: expect.stringContaining("cosign not found"),
        }),
      ]),
    );
  });

  it("redacts secret-like environment values from release tool failures", async () => {
    const token = "super-secret-release-token";
    const run = fakeRunner((argv) => {
      if (argv[0] === "npm" && argv[1] === "install") {
        return { code: 1, stderr: `registry rejected token ${token}` };
      }
      return undefined;
    });
    const c = { ...ctx(run, { version: "1.0.1" }), env: { NPM_TOKEN: token } };

    const result = await executePlan(await verifyReleaseCommand.plan(c), c);

    const detail = result.report?.checks.find(
      (check) => check.name === "release npm signatures",
    )?.detail;
    expect(result.report?.ok).toBe(false);
    expect(detail).toContain("[REDACTED]");
    expect(detail).not.toContain(token);
  });
});
