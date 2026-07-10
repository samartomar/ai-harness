import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import { parseBaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";
import { executeEccEvidencePipeline } from "../../src/ecc/pipeline.js";
import { doc, plan, type PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { resolveTrustSource } from "../../src/trust/fetch.js";

let root: string;
let sourceRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-pipeline-"));
  sourceRoot = join(root, "ecc-source");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "install.sh"), "echo verified\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(apply = true): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

function catalog() {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: "a".repeat(40),
    components: [{ id: "runtime:ecc-kiro", paths: ["install.sh"] }],
  });
}

function vendorLock(verdict: "pass" | "blocked" = "pass") {
  return parseBaselineEvidenceLock({
    schemaVersion: 1,
    sources: [
      {
        id: "ecc",
        owner: "affaan-m",
        repo: "ECC",
        pinnedSha: "a".repeat(40),
        components: [
          {
            id: "runtime:ecc-kiro",
            paths: ["install.sh"],
            treeSha256: hashComponentTree(sourceRoot, ["install.sh"]).treeSha256,
            verdict,
            analyzers: [{ name: "aih-native", version: "2.7.0" }],
            findings:
              verdict === "blocked"
                ? [{ code: "prompt-injection", severity: "danger", detail: "blocked" }]
                : [],
          },
        ],
      },
    ],
  });
}

const request = { clis: ["kiro" as const], profile: "core", packs: [] };

describe("ECC baseline evidence pipeline", () => {
  it("constructs install actions only after exact evidence clears", async () => {
    const buildInstallPlan = vi.fn(() => plan("verified install", doc("install", "verified")));
    const result = await executeEccEvidencePipeline(ctx(), request, {
      catalog: catalog(),
      source: resolveTrustSource(sourceRoot, { root }),
      vendorLock: vendorLock(),
      vendorLockSha256: "f".repeat(64),
      buildInstallPlan,
    });

    expect(buildInstallPlan).toHaveBeenCalledOnce();
    expect(result.docs).toEqual([expect.objectContaining({ describe: "install" })]);
    expect(result.report?.exitCode()).toBe(0);
  });

  it("never constructs install actions when signed evidence blocks", async () => {
    const buildInstallPlan = vi.fn(() => plan("must not build"));
    const result = await executeEccEvidencePipeline(ctx(), request, {
      catalog: catalog(),
      source: resolveTrustSource(sourceRoot, { root }),
      vendorLock: vendorLock("blocked"),
      vendorLockSha256: "f".repeat(64),
      buildInstallPlan,
    });

    expect(buildInstallPlan).not.toHaveBeenCalled();
    expect(result.report?.checks).toEqual([
      expect.objectContaining({ verdict: "fail", code: "baseline.evidence-blocked" }),
    ]);
  });

  it("fails closed on invalid configured org evidence before install construction", async () => {
    const buildInstallPlan = vi.fn(() => plan("must not build"));
    const result = await executeEccEvidencePipeline(ctx(), request, {
      catalog: catalog(),
      source: resolveTrustSource(sourceRoot, { root }),
      vendorLock: vendorLock(),
      vendorLockSha256: "f".repeat(64),
      buildInstallPlan,
      resolveOrgEvidence: async () => ({
        checks: [
          {
            name: "org baseline evidence",
            verdict: "fail",
            code: "baseline.evidence-mismatch",
            detail: "signature invalid",
          },
        ],
      }),
    });

    expect(buildInstallPlan).not.toHaveBeenCalled();
    expect(result.report?.exitCode()).toBe(1);
  });

  it("previews an exact remote pin without fetching or constructing installs", async () => {
    const buildInstallPlan = vi.fn(() => plan("must not build"));
    const source = resolveTrustSource("affaan-m/ECC", {
      root,
      pin: "a".repeat(40),
    });
    if (source.kind !== "github") throw new Error("expected GitHub source");

    const result = await executeEccEvidencePipeline(ctx(false), request, {
      catalog: catalog(),
      source,
      vendorLock: vendorLock(),
      vendorLockSha256: "f".repeat(64),
      buildInstallPlan,
    });

    expect(result.execs).toEqual([
      expect.objectContaining({ ran: false, argv: expect.arrayContaining(["-e"]) }),
    ]);
    expect(buildInstallPlan).not.toHaveBeenCalled();
    expect(existsSync(source.quarantineRoot)).toBe(false);
  });
});
