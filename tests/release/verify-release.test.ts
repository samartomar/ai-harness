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
      if (argv.slice(0, 3).join(" ") === "npm view @aihq/harness version") {
        return { code: 0, stdout: "1.0.1\n" };
      }
      if (argv.slice(0, 3).join(" ") === "npm audit signatures") return { code: 0, stdout: "ok" };
      if (argv[0] === "gh" && argv[1] === "release" && argv[2] === "download") {
        return { code: 0 };
      }
      if (argv[0] === "cosign" && argv[1] === "verify-blob") return { code: 0, stdout: "ok" };
      if (argv[0] === "npm" && argv[1] === "pack") return { code: 0, stdout: "aihq-harness-1.0.1.tgz\n" };
      return undefined;
    });

    const result = await executePlan(await verifyReleaseCommand.plan(ctx(run)), ctx(run));

    expect(result.report?.ok).toBe(true);
    expect(result.report?.checks.map((check) => check.verdict)).toEqual([
      "pass",
      "pass",
      "pass",
    ]);
    expect(seen.some((argv) => argv.join(" ").startsWith("npm audit signatures"))).toBe(true);
    expect(seen.some((argv) => argv.join(" ").includes("gh release download v1.0.1"))).toBe(true);
    expect(seen.some((argv) => argv.join(" ").includes("cosign verify-blob"))).toBe(true);
  });

  it("skips only the cosign leg when cosign is unavailable", async () => {
    const run = fakeRunner((argv) => {
      if (argv.slice(0, 3).join(" ") === "npm audit signatures") return { code: 0, stdout: "ok" };
      if (argv[0] === "gh" && argv[1] === "release" && argv[2] === "download") return { code: 0 };
      if (argv[0] === "cosign") return { code: 127, spawnError: true, stderr: "not found" };
      if (argv[0] === "npm" && argv[1] === "pack") return { code: 0, stdout: "aihq-harness-1.0.1.tgz\n" };
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
});
