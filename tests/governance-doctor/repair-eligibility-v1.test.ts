import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertGovernanceDoctorRepairEligibilityV1,
  GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
  mintGovernanceDoctorRepairEligibilityV1,
} from "../../src/governance-doctor/repair-eligibility-v1.js";

const ROOT_SHA256 = "a".repeat(64);
const CANONICAL = GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1;

function minted() {
  const record = mintGovernanceDoctorRepairEligibilityV1(CANONICAL, CANONICAL, ROOT_SHA256);
  if (record === undefined) throw new Error("expected a minted eligibility record");
  return record;
}

describe("mintGovernanceDoctorRepairEligibilityV1", () => {
  it("mints a frozen record only when both context directories are the canonical path", () => {
    const record = minted();
    expect(record).toEqual({
      markerContextDir: "ai-coding",
      protocol: "GovernanceDoctorRepairEligibilityV1",
      resolvedContextDir: "ai-coding",
      rootSha256: ROOT_SHA256,
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(assertGovernanceDoctorRepairEligibilityV1(record)).toEqual(record);
  });

  it("mints nothing for an alternate, absolute, traversal, nested, or case-varied marker path", () => {
    for (const path of [
      "ai-coding-2",
      "docs",
      "/ai-coding",
      "C:/ai-coding",
      "../ai-coding",
      "./ai-coding",
      "ai-coding/",
      "ai-coding/rules",
      "AI-Coding",
      " ai-coding",
      "",
      undefined,
      null,
      1,
    ])
      expect(
        mintGovernanceDoctorRepairEligibilityV1(path, CANONICAL, ROOT_SHA256),
        String(path),
      ).toBeUndefined();
  });

  it("mints nothing when the resolved execution context dir is not the canonical path", () => {
    // A `--context-dir` override, an environment-derived value, or a fallback
    // setting that disagrees with the committed marker is exactly this shape.
    for (const resolved of ["ai-coding-2", "/ai-coding", "../ai-coding", "", undefined])
      expect(
        mintGovernanceDoctorRepairEligibilityV1(CANONICAL, resolved, ROOT_SHA256),
        String(resolved),
      ).toBeUndefined();
  });

  it("refuses a malformed root binding rather than minting an unbound record", () => {
    for (const binding of ["", "z".repeat(64), "A".repeat(64), "a".repeat(63), undefined, 1])
      expect(
        () => mintGovernanceDoctorRepairEligibilityV1(CANONICAL, CANONICAL, binding),
        String(binding),
      ).toThrow(TypeError);
  });
});

describe("assertGovernanceDoctorRepairEligibilityV1", () => {
  it("refuses every hostile substitution for a minted record", () => {
    const record = minted();
    const spread = { ...record };
    const accessor: Record<string, unknown> = {
      protocol: record.protocol,
      resolvedContextDir: CANONICAL,
      rootSha256: ROOT_SHA256,
    };
    Object.defineProperty(accessor, "markerContextDir", { enumerable: true, get: () => CANONICAL });
    for (const [label, value] of [
      ["plain object", { ...spread }],
      ["spread copy", spread],
      ["proxy", new Proxy(record, {})],
      ["accessor", accessor],
      ["altered brand", { ...spread, protocol: "GovernanceDoctorRepairEligibilityV2" }],
      ["altered marker path", { ...spread, markerContextDir: "ai-coding-2" }],
      ["altered resolved path", { ...spread, resolvedContextDir: "ai-coding-2" }],
      ["prototype child", Object.create(record) as unknown],
      ["extra field", { ...spread, extra: 1 }],
      ["missing field", { protocol: record.protocol, rootSha256: record.rootSha256 }],
      ["null", null],
      ["array", [record]],
      ["undefined", undefined],
    ] as const)
      expect(() => assertGovernanceDoctorRepairEligibilityV1(value), label).toThrow(TypeError);
  });

  it("accepts the minted record itself and returns its own bound root", () => {
    const record = minted();
    expect(assertGovernanceDoctorRepairEligibilityV1(record).rootSha256).toBe(ROOT_SHA256);
  });
});

describe("repair eligibility static boundary", () => {
  const sourceRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../src/governance-doctor",
  );

  /**
   * The eligibility record is the one value the pure preview module accepts from
   * the trusted command boundary, so the module that brands it must itself stay
   * capability-free: the preview imports it, and a filesystem or settings reach
   * here would be a filesystem reach in the preview by transitivity.
   */
  it("loads no platform capability and opens no dynamic seam", () => {
    const source = readFileSync(resolve(sourceRoot, "repair-eligibility-v1.ts"), "utf8");
    for (const token of [
      "node:fs",
      "node:os",
      "node:path",
      "node:process",
      "node:child_process",
      "process.env",
      "require(",
      "import(",
      "eval",
      "new Function",
      "globalThis",
      "PlanContext",
      "readAihConfig",
    ])
      expect(source, token).not.toContain(token);
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    expect(imports).toEqual(["./capability-v1.js"]);
  });
});
