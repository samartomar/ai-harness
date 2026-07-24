/**
 * D16 host tuple — the code representation of the qualified host environment a
 * binding is verified against (W7 design §B.3).
 *
 * Phase 1a shipped the {@link HostTuple} shape and the committed
 * {@link SUPPORTED_HOST_TUPLE} constant (from the W1 environment record). Phase 1b
 * adds the measurement ({@link measureHostTuple}) and the pure classification
 * ({@link classifyTuple}) the D16 doctor probe (`binding-doctor.ts`) compares with.
 *
 * CLI-version tolerance (design §B.3): `claudeCode.measuredOn` is PROVENANCE, not
 * a gate — it records the Claude Code version the tuple was measured on and is
 * never compared as a stop. The hard facts (Windows build, arch, Node, Bun,
 * RAM class, vCPU class) are what the doctor compares; a mismatch downgrades the
 * Framework Card's support label rather than hard-failing a read-only doctor.
 */

import { cpus, release } from "node:os";
import { arch as processArch, versions as processVersions } from "node:process";
import type { Runner } from "../internals/proc.js";

/** The qualified-host tuple (design §B.3). */
export interface HostTuple {
  /** PROVENANCE only — the Claude Code version the tuple was measured on; never a gate. */
  claudeCode: { measuredOn: string };
  /**
   * Hard: the exact tested Windows BUILD number (e.g. "26200"). The monthly
   * cumulative-update patch (UBR, e.g. ".8875") is deliberately NOT part of the
   * gate — it moves with Windows Update the way the Claude CLI version moves,
   * so it is provenance (recorded in `windowsUbr`), per the CLI-version-
   * tolerance precedent. `os.release()` yields "10.0.<build>"; the build is its
   * third dot-component.
   */
  windowsBuild: string;
  /** PROVENANCE only — the tested UBR patch level when known; never a gate. */
  windowsUbr?: string;
  /** Hard: the exact tested CPU architecture. */
  arch: string;
  /** Hard: the tested Node version (major range in Phase 1b). */
  node: string;
  /** Hard: the exact tested Bun version. */
  bun: string;
  /** Hard: rounded total-RAM class in GiB (detects a Hyper-V rollback). */
  ramClassGb: number;
  /** Hard: physical vCPU class. */
  vcpuClass: number;
}

/**
 * The committed, pinned host tuple from `W1-ENVIRONMENT-RECORD` — the exact
 * environment W1–W6 were calibrated on. A binding qualified against a DIFFERENT
 * tuple never satisfies the runtime-qualification cache (Phase 2) and downgrades
 * the Framework Card's support label (Phase 1b doctor).
 */
export const SUPPORTED_HOST_TUPLE: HostTuple = {
  claudeCode: { measuredOn: "2.1.217" },
  windowsBuild: "26200",
  windowsUbr: "8875",
  arch: "x64",
  node: "24.18.0",
  bun: "1.3.14",
  ramClassGb: 24,
  vcpuClass: 24,
};

// -- measurement + classification (Phase 1b) ---------------------------------

/**
 * The three-way tuple verdict (design §B.3, O5 ruling):
 *  - `in-tuple`      — every hard fact matches AND the Claude Code provenance matches.
 *  - `version-drift` — every hard fact matches but the Claude Code version differs
 *                      (e.g. a newer CLI). The read-only analogue of a no-content
 *                      re-verification: facts held, only the provenance advanced.
 *  - `off-tuple`     — at least one hard fact differs.
 */
export type TupleClass = "in-tuple" | "version-drift" | "off-tuple";

/** The Node MAJOR component — the tested-major-range granularity (O5: "Node tested major 24.x"). */
function nodeMajor(version: string): string {
  return version.split(".")[0] ?? "";
}

/**
 * Classify a MEASURED tuple against a PINNED one (design §B.3, O5). Hard facts are
 * EXACT — arch, Windows build, Bun, vCPU class — except Node, compared at MAJOR
 * granularity (a 24.x patch/minor bump is in-range), and RAM, which gates only
 * DOWNWARD: below the pinned class is a rollback signal (off-tuple), while ABOVE
 * it is the recorded Hyper-V dynamic-memory balloon on this infrastructure (the
 * W4-attempt-4 environment record: first reads say 48 GB, settled re-reads say
 * 24) and classifies as provenance-grade drift, never off-tuple. The Claude Code
 * version is PROVENANCE only: it never turns a hard-facts-equal host off-tuple,
 * it only distinguishes `in-tuple` from `version-drift`. Pure and deterministic.
 */
export function classifyTuple(measured: HostTuple, pinned: HostTuple): TupleClass {
  const hardFactsMatch =
    measured.arch === pinned.arch &&
    measured.windowsBuild === pinned.windowsBuild &&
    measured.bun === pinned.bun &&
    measured.ramClassGb >= pinned.ramClassGb &&
    measured.vcpuClass === pinned.vcpuClass &&
    nodeMajor(measured.node) === nodeMajor(pinned.node);
  if (!hardFactsMatch) return "off-tuple";
  const provenanceEqual =
    measured.claudeCode.measuredOn === pinned.claudeCode.measuredOn &&
    measured.ramClassGb === pinned.ramClassGb;
  return provenanceEqual ? "in-tuple" : "version-drift";
}

/**
 * The narrow context {@link measureHostTuple} needs — a runner, the RAM fact,
 * and the LOGICAL-processor count. `logicalProcessors` defaults to
 * `os.cpus().length` (the W1 record's "24 logical processors" semantics — NOT
 * the host adapter's physical-core count, which reads 12 on this SMT host); it
 * is injectable so a test can pin it deterministically across CI machines.
 */
export interface MeasureHostTupleContext {
  run: Runner;
  host: {
    totalRamGb(): Promise<number>;
  };
  logicalProcessors?: () => number;
}

/**
 * The first semver-shaped token in a `--version` stdout, or `"unknown"`. NEVER
 * fabricates a version: a spawn error or an unrecognizable payload yields
 * `"unknown"` (which is then off-tuple/version-drift, the fail-safe direction).
 */
async function measuredCliVersion(run: Runner, argv: string[]): Promise<string> {
  const res = await run(argv);
  if (res.spawnError) return "unknown";
  const match = res.stdout.match(/\d+\.\d+\.\d+(?:[0-9A-Za-z.+-]*)?/);
  return match ? match[0] : "unknown";
}

/**
 * Measure the live host tuple (design §B.3). Node/arch come from the running
 * process; the Windows build from `os.release()`; Bun and Claude Code versions via
 * the injected runner (`bun --version`, `claude --version`); the RAM class
 * (rounded GiB) and vCPU class from the host adapter. `claudeCode.measuredOn` is
 * recorded as PROVENANCE — the doctor re-measures the hard facts and never gates on
 * this CLI version. Deterministic given fixed inputs: no timestamps, no randomness.
 */
export async function measureHostTuple(ctx: MeasureHostTupleContext): Promise<HostTuple> {
  const [bun, claudeVersion, ramGb] = await Promise.all([
    measuredCliVersion(ctx.run, ["bun", "--version"]),
    measuredCliVersion(ctx.run, ["claude", "--version"]),
    ctx.host.totalRamGb(),
  ]);
  // LOGICAL processors — the W1 environment record's "24 logical processors"
  // semantics (the host adapter's cpuPhysicalCores() counts physical cores,
  // which on this SMT machine reads 12 and would mis-gate the reference host).
  const vcpu = (ctx.logicalProcessors ?? (() => cpus().length))();
  return {
    claudeCode: { measuredOn: claudeVersion },
    // "10.0.26200" -> "26200"; a non-Windows or unexpected shape keeps the raw
    // value, which then honestly reads off-tuple against the pinned build.
    windowsBuild: release().split(".")[2] ?? release(),
    arch: processArch,
    node: processVersions.node,
    bun,
    ramClassGb: Math.round(ramGb),
    vcpuClass: vcpu,
  };
}
