/**
 * D16 host tuple — the code representation of the qualified host environment a
 * binding is verified against (W7 design §B.3).
 *
 * PHASE 1a is TYPE + CONSTANT ONLY. This module is the seam Phase 1b builds on:
 * the {@link HostTuple} shape and the committed {@link SUPPORTED_HOST_TUPLE}
 * constant (from the W1 environment record). The measurement functions
 * (`measureHostTuple`, `classifyTuple`) and the doctor probes that compare a
 * measured tuple against the pinned one are PHASE 1b — deliberately absent here
 * so nothing in Phase 1a shells out or reads host facts.
 *
 * CLI-version tolerance (design §B.3): `claudeCode.measuredOn` is PROVENANCE, not
 * a gate — it records the Claude Code version the tuple was measured on and is
 * never compared as a stop. The hard facts (Windows build, arch, Node, Bun,
 * RAM class, vCPU class) are what a Phase 1b doctor compares; a mismatch
 * downgrades the Framework Card's support label rather than hard-failing a
 * read-only doctor.
 */

/** The qualified-host tuple (design §B.3). */
export interface HostTuple {
  /** PROVENANCE only — the Claude Code version the tuple was measured on; never a gate. */
  claudeCode: { measuredOn: string };
  /** Hard: the exact tested Windows build. */
  windowsBuild: string;
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
  windowsBuild: "26200.8875",
  arch: "x64",
  node: "24.18.0",
  bun: "1.3.14",
  ramClassGb: 24,
  vcpuClass: 24,
};
