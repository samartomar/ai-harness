import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import {
  BaselineEvidenceBlockedError,
  baselineInstallPhasePlan,
  captureBaselineGate,
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

function mixedCatalog() {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: "a".repeat(40),
    components: [
      { id: "skill:clean", paths: ["skills/clean"] },
      { id: "skill:held", paths: ["skills/held"] },
    ],
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

function mixedVendorLock() {
  mkdirSync(join(root, "skills", "held"), { recursive: true });
  writeFileSync(join(root, "skills", "held", "SKILL.md"), "# Held\n");
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
            treeSha256: hashComponentTree(root, ["skills/clean"]).treeSha256,
            verdict: "pass",
            analyzers: [{ name: "aih-native", version: "2.8.0" }],
            findings: [],
          },
          {
            id: "skill:held",
            paths: ["skills/held"],
            treeSha256: hashComponentTree(root, ["skills/held"]).treeSha256,
            verdict: "blocked",
            analyzers: [{ name: "aih-native", version: "2.8.0" }],
            findings: [
              {
                code: "trust.auto-exec-hook",
                detail: "SKILL body contains a leading ! auto-run line",
              },
            ],
          },
        ],
      },
    ],
  });
}

describe("guarded baseline install phases", () => {
  it("captures an evidence-cleared gate with authorization receipts", () => {
    const gate = captureBaselineGate({
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
      captureBaselineGate({
        ctx: ctx(),
        sourceRoot: root,
        catalog: catalog(),
        componentIds: ["skill:clean"],
        vendorLock: vendorLock("0".repeat(64)),
        vendorLockSha256: "f".repeat(64),
      }),
    ).toThrow(BaselineEvidenceBlockedError);
  });

  it("builds a mixed gate and installs only the authorized component subset", async () => {
    const gate = captureBaselineGate({
      ctx: ctx(),
      allowPartial: true,
      sourceRoot: root,
      catalog: mixedCatalog(),
      componentIds: ["skill:clean", "skill:held"],
      vendorLock: mixedVendorLock(),
      vendorLockSha256: "f".repeat(64),
    });
    expect(gate.authorizations).toEqual([expect.objectContaining({ componentId: "skill:clean" })]);
    expect(gate.held).toEqual([
      expect.objectContaining({
        componentId: "skill:held",
        routeCode: "baseline.evidence-blocked",
        codes: ["trust.auto-exec-hook"],
      }),
    ]);
    const build = vi.fn(() => [doc("install", "verified partial install")]);

    const phase = await baselineInstallPhasePlan(ctx(), gate, build);

    expect(build).toHaveBeenCalledWith([expect.objectContaining({ componentId: "skill:clean" })]);
    expect(phase.actions.map((action) => action.kind)).toEqual(["probe", "digest", "doc"]);
  });

  it("keeps mixed evidence all-or-nothing unless the caller opts into partial mode", () => {
    expect(() =>
      captureBaselineGate({
        ctx: ctx(),
        sourceRoot: root,
        catalog: mixedCatalog(),
        componentIds: ["skill:clean", "skill:held"],
        vendorLock: mixedVendorLock(),
        vendorLockSha256: "f".repeat(64),
      }),
    ).toThrow(BaselineEvidenceBlockedError);
  });

  it("rejects the whole mixed request when one component hash drifts", () => {
    const lock = mixedVendorLock();
    const held = lock.sources[0]?.components.find((component) => component.id === "skill:held");
    if (held === undefined) throw new Error("missing held fixture component");
    held.treeSha256 = "0".repeat(64);

    expect(() =>
      captureBaselineGate({
        ctx: ctx(),
        allowPartial: true,
        sourceRoot: root,
        catalog: mixedCatalog(),
        componentIds: ["skill:clean", "skill:held"],
        vendorLock: lock,
        vendorLockSha256: "f".repeat(64),
      }),
    ).toThrow(BaselineEvidenceBlockedError);
  });

  it("builds install actions only after the same tree re-verifies", async () => {
    const gate = captureBaselineGate({
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
    const gate = captureBaselineGate({
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
    expect(phase.actions.map((action) => action.kind)).toEqual(["probe", "digest"]);
    expect(phase.actions[0]?.kind).toBe("probe");
    const probe = phase.actions[0];
    if (probe?.kind !== "probe") throw new Error("missing guard probe");
    const check = await probe.run(ctx());
    expect(check).toMatchObject({ verdict: "fail", code: "baseline.evidence-mismatch" });
  });
});
