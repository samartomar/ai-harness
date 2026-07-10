import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import {
  BaselineEvidenceBlockedError,
  baselineInstallPhasePlan,
  captureClearedBaselineGate,
} from "../../src/baseline-evidence/run.js";
import { parseBaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";
import { doc, type PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-baseline-run-"));
  mkdirSync(join(root, "skills", "clean"), { recursive: true });
  writeFileSync(join(root, "skills", "clean", "SKILL.md"), "# Clean\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(posture: "vibe" | "team" | "enterprise" = "enterprise"): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture,
    apply: true,
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
    components: [{ id: "skill:clean", paths: ["skills/clean"] }],
  });
}

function vendorLock(hash = hashComponentTree(root, ["skills/clean"]).treeSha256) {
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
            id: "skill:clean",
            paths: ["skills/clean"],
            treeSha256: hash,
            verdict: "pass",
            analyzers: [{ name: "aih-native", version: "2.7.0" }],
            findings: [],
          },
        ],
      },
    ],
  });
}

describe("guarded baseline install phases", () => {
  it("captures an evidence-cleared gate with authorization receipts", () => {
    const gate = captureClearedBaselineGate({
      ctx: ctx(),
      sourceRoot: root,
      catalog: catalog(),
      componentIds: ["skill:clean"],
      vendorLock: vendorLock(),
      vendorLockSha256: "f".repeat(64),
    });
    expect(gate.authorizations).toEqual([
      expect.objectContaining({ componentId: "skill:clean", tier: "vendor" }),
    ]);
  });

  it("refuses to create a cleared gate when evidence blocks", () => {
    expect(() =>
      captureClearedBaselineGate({
        ctx: ctx(),
        sourceRoot: root,
        catalog: catalog(),
        componentIds: ["skill:clean"],
        vendorLock: vendorLock("0".repeat(64)),
        vendorLockSha256: "f".repeat(64),
      }),
    ).toThrow(BaselineEvidenceBlockedError);
  });

  it("builds install actions only after the same tree re-verifies", async () => {
    const gate = captureClearedBaselineGate({
      ctx: ctx(),
      sourceRoot: root,
      catalog: catalog(),
      componentIds: ["skill:clean"],
      vendorLock: vendorLock(),
      vendorLockSha256: "f".repeat(64),
    });
    const build = vi.fn(() => [doc("install", "verified install")]);
    const phase = await baselineInstallPhasePlan(ctx(), gate, build);
    expect(build).toHaveBeenCalledOnce();
    expect(phase.actions.map((action) => action.kind)).toEqual(["probe", "doc"]);
  });

  it("detects a post-clearance mutation and never constructs install actions", async () => {
    const gate = captureClearedBaselineGate({
      ctx: ctx(),
      sourceRoot: root,
      catalog: catalog(),
      componentIds: ["skill:clean"],
      vendorLock: vendorLock(),
      vendorLockSha256: "f".repeat(64),
    });
    writeFileSync(join(root, "skills", "clean", "SKILL.md"), "# Mutated\n");
    const build = vi.fn(() => [doc("install", "must not exist")]);
    const phase = await baselineInstallPhasePlan(ctx(), gate, build);
    expect(build).not.toHaveBeenCalled();
    expect(phase.actions).toHaveLength(1);
    expect(phase.actions[0]?.kind).toBe("probe");
    const probe = phase.actions[0];
    if (probe?.kind !== "probe") throw new Error("missing guard probe");
    const check = await probe.run(ctx());
    expect(check).toMatchObject({ verdict: "fail", code: "baseline.evidence-mismatch" });
  });
});
