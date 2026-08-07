import { createHash } from "node:crypto";
import type { HookRegistration } from "../../src/org-policy/hook-registrar.js";

/**
 * Registration fixtures reproducing the 2026-08-06 workstation measurement that
 * the v3.5 ADR was ruled on. They are fixtures, not shipped data: AIH's pinned
 * ECC catalog records `baseline:hooks` and `module:hooks-runtime` as components,
 * never a per-hook registration table, so a shipped table would be invented.
 */

const ECC_REPOSITORY = "affaan-m/ECC";
const ECC_COMMIT = "623f2c020f052319657674e4e6c29ab5d0ad566b";
const ECC_RUNTIME_VERSION = "3.7.1";

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * An ECC Stop shim as its own installer writes it: an outer `node -e` that
 * requires `run-with-flags.js`, which then requires the target script.
 */
function eccStopCommand(script: string): string {
  return `node -e "require('~/.claude/scripts/hooks/run-with-flags.js').run('${script}')"`;
}

/**
 * Two processes for the shim chain (`node -e`, then `run-with-flags.js`), plus a
 * third when the target script has no `run()` export and run-with-flags spawns a
 * legacy child. Four of ECC's six Stop scripts lack that export.
 */
function eccStop(id: string, script: string, hasRunExport: boolean): HookRegistration {
  const command = eccStopCommand(script);
  return {
    id,
    event: "Stop",
    command,
    functionTags: [id],
    spawns: hasRunExport ? 2 : 3,
    owner: {
      kind: "third-party",
      framework: "ecc",
      declaredControls: ["ECC_HOOK_PROFILE", "ECC_DISABLED_HOOKS"],
      pin: {
        repository: ECC_REPOSITORY,
        commit: ECC_COMMIT,
        path: `scripts/hooks/${script}`,
        launcherSha256: sha256(command),
        runtimeVersion: ECC_RUNTIME_VERSION,
      },
    },
  };
}

/** One AIH composite dispatcher per event — the v3.4 contract, one process. */
export function aihDispatcher(event: string, functionTags: readonly string[]): HookRegistration {
  const command = `node C:/aih/ecc-runtime.js hook --client claude --event ${event}`;
  return {
    id: `aih-${event.toLowerCase()}`,
    event,
    command,
    functionTags: [...functionTags],
    spawns: 1,
    owner: { kind: "aih" },
  };
}

/** The repository's own Stop registration — a third writer, one process. */
export function repositoryStopHook(): HookRegistration {
  const command = "node tools/repo-ai-tools.mjs token-optimizer-stop";
  return {
    id: "repo-token-optimizer-stop",
    event: "Stop",
    command,
    functionTags: ["token-optimizer"],
    spawns: 1,
    owner: {
      kind: "third-party",
      framework: "repository",
      declaredControls: [],
      pin: {
        repository: "samartomar/ai-harness",
        commit: "4a236bba0d3c1e2f5a6b7c8d9e0f1a2b3c4d5e6f",
        path: "tools/repo-ai-tools.mjs",
        launcherSha256: sha256(command),
        runtimeVersion: "0.0.0",
      },
    },
  };
}

/**
 * ECC's six Stop registrations, four of which have no `run()` export.
 * 4 × 3 + 2 × 2 = 16 processes, the number measured on the workstation.
 */
export function eccStopRegistrations(): HookRegistration[] {
  return [
    eccStop("ecc-stop-session-summary", "session-summary.js", false),
    eccStop("ecc-stop-learning-capture", "learning-capture.js", false),
    eccStop("ecc-stop-delivery-gate", "delivery-gate.js", false),
    eccStop("ecc-stop-growth-log", "growth-log.js", false),
    eccStop("ecc-stop-instinct-observe", "instinct-observe.js", true),
    eccStop("ecc-stop-checkpoint", "checkpoint.js", true),
  ];
}

/**
 * The three overlaps that already existed on the workstation, unseen by either
 * owner because neither could read the other's entries.
 */
export function overlappingRegistrations(): HookRegistration[] {
  const mcpHealth = eccStop("ecc-pre-mcp-health-check", "mcp-health-check.js", true);
  const preCompact = eccStop("ecc-pre-compact", "compact.js", true);
  const blockNoVerify = eccStop("ecc-pre-bash-block-no-verify", "block-no-verify.js", true);
  return [
    { ...mcpHealth, event: "PreToolUse", functionTags: ["mcp-health"] },
    { ...blockNoVerify, event: "PreToolUse", functionTags: ["verification-bypass-guard"] },
    { ...preCompact, event: "PreCompact", functionTags: ["pre-compaction-summary"] },
    aihDispatcher("PreToolUse", ["mcp-health", "verification-bypass-guard"]),
    aihDispatcher("PreCompact", ["pre-compaction-summary"]),
  ];
}

/**
 * The trap the ADR proved live: `pre:edit-write:gateguard-fact-force` was listed
 * in `ECC_DISABLED_HOOKS` and still spawned on every Edit/Write, because the
 * control is read inside `run-with-flags.js` — after the process already exists.
 */
export function sourceDisabledRegistration(): HookRegistration {
  const base = eccStop("ecc-pre-edit-write-gateguard-fact-force", "gateguard-fact-force.js", true);
  return { ...base, event: "PreToolUse", sourceDisabled: true };
}

/** The full Stop event as measured: 8 entries, 18 processes. */
export function measuredStopEvent(): HookRegistration[] {
  return [
    ...eccStopRegistrations(),
    repositoryStopHook(),
    aihDispatcher("Stop", ["continuity-checkpoint"]),
  ];
}
