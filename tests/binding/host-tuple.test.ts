import { arch } from "node:process";
import { describe, expect, it } from "vitest";
import {
  classifyTuple,
  type HostTuple,
  measureHostTuple,
  SUPPORTED_HOST_TUPLE,
} from "../../src/binding/host-tuple.js";
import { fakeRunner } from "../../src/internals/proc.js";

/**
 * W7 §B.3 — the D16 host tuple measurement + classification (Phase 1b). Pinned
 * hard facts (arch, windowsBuild, bun, RAM-class, vCPU-class) are exact; Node is a
 * tested-major range (24.x); the Claude Code version is PROVENANCE only (never a
 * gate). Off-tuple downgrades support; a newer CLI over equal hard facts is a
 * benign version-drift. `classifyTuple` is pure and exhaustively covered here.
 */

/** The pinned tuple, cloned so a test can perturb one field without mutating the constant. */
function pinnedClone(over: Partial<HostTuple> = {}): HostTuple {
  return {
    ...SUPPORTED_HOST_TUPLE,
    ...over,
    claudeCode: { ...SUPPORTED_HOST_TUPLE.claudeCode, ...(over.claudeCode ?? {}) },
  };
}

describe("classifyTuple", () => {
  it("returns in-tuple when every field (incl. the CLI provenance) matches", () => {
    expect(classifyTuple(pinnedClone(), SUPPORTED_HOST_TUPLE)).toBe("in-tuple");
  });

  it("returns in-tuple when only the Node minor/patch differs (tested-major range 24.x)", () => {
    expect(classifyTuple(pinnedClone({ node: "24.10.5" }), SUPPORTED_HOST_TUPLE)).toBe("in-tuple");
  });

  it("returns version-drift when hard facts hold but the Claude Code version advanced", () => {
    const measured = pinnedClone({ claudeCode: { measuredOn: "2.1.999" } });
    expect(classifyTuple(measured, SUPPORTED_HOST_TUPLE)).toBe("version-drift");
  });

  it("still classifies version-drift when the CLI drifts AND Node minor differs but stays 24.x", () => {
    const measured = pinnedClone({ node: "24.20.0", claudeCode: { measuredOn: "2.2.0" } });
    expect(classifyTuple(measured, SUPPORTED_HOST_TUPLE)).toBe("version-drift");
  });

  it("classifies RAM ABOVE the pinned class as version-drift, never off-tuple (the recorded Hyper-V dynamic-memory balloon)", () => {
    // W4-attempt-4 environment record: first post-restore reads say 48 GB and
    // settle to the 24 GB standing allocation — above-pin is provenance drift.
    expect(classifyTuple(pinnedClone({ ramClassGb: 48 }), SUPPORTED_HOST_TUPLE)).toBe(
      "version-drift",
    );
  });

  it("RAM BELOW the pinned class stays off-tuple (the rollback signal RAM exists to catch)", () => {
    expect(classifyTuple(pinnedClone({ ramClassGb: 23 }), SUPPORTED_HOST_TUPLE)).toBe("off-tuple");
  });

  it.each<[string, Partial<HostTuple>]>([
    ["arch", { arch: "arm64" }],
    ["windowsBuild", { windowsBuild: "26100.1000" }],
    ["bun", { bun: "1.2.0" }],
    ["node major", { node: "20.18.0" }],
    ["ramClassGb", { ramClassGb: 16 }],
    ["vcpuClass", { vcpuClass: 8 }],
  ])("returns off-tuple when the hard fact %s differs", (_label, over) => {
    // Even with the CLI provenance matching, any hard-fact mismatch is off-tuple.
    expect(classifyTuple(pinnedClone(over), SUPPORTED_HOST_TUPLE)).toBe("off-tuple");
  });

  it("off-tuple wins even if the CLI version also matches (hard fact dominates)", () => {
    expect(classifyTuple(pinnedClone({ vcpuClass: 2 }), SUPPORTED_HOST_TUPLE)).toBe("off-tuple");
  });
});

describe("measureHostTuple", () => {
  const host = { totalRamGb: async () => 23.6, cpuPhysicalCores: async () => 24 };

  it("reads Node/arch from the process, bun & claude via the runner, ram/vcpu via the host", async () => {
    const run = fakeRunner((argv) => {
      if (argv[0] === "bun") return { stdout: "1.3.14\n" };
      if (argv[0] === "claude") return { stdout: "2.1.217 (Claude Code)\n" };
      return undefined;
    });
    const measured = await measureHostTuple({ run, host });
    expect(measured.node).toBe(process.versions.node);
    expect(measured.arch).toBe(arch);
    expect(measured.bun).toBe("1.3.14");
    expect(measured.claudeCode.measuredOn).toBe("2.1.217");
    expect(measured.ramClassGb).toBe(24); // 23.6 rounds to 24 (RAM class)
    expect(measured.vcpuClass).toBe(24);
  });

  it("records `unknown` (never fabricates) when bun/claude cannot be spawned", async () => {
    const run = fakeRunner(() => ({ spawnError: true, code: 127 }));
    const measured = await measureHostTuple({ run, host });
    expect(measured.bun).toBe("unknown");
    expect(measured.claudeCode.measuredOn).toBe("unknown");
  });

  it("is deterministic — two consecutive measurements on fixed inputs are equal", async () => {
    const run = fakeRunner((argv) =>
      argv[0] === "bun" ? { stdout: "1.3.14" } : { stdout: "2.1.217" },
    );
    expect(await measureHostTuple({ run, host })).toEqual(await measureHostTuple({ run, host }));
  });
});
