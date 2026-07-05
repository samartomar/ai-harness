import type { Posture, PostureSource } from "../config/posture.js";
import type { EnvShell, HostAdapter } from "../platform/base.js";
import {
  legacyChecksToVerificationRun,
  type StructuredVerificationRunCheckOptions,
  structuredVerificationRunToCheck,
} from "../verification/legacy.js";
import type { VerificationPipelineRun } from "../verification/types.js";
import type { Cli } from "./clis.js";
import type { EnvVar } from "./envfile.js";
import type { Runner, RunResult } from "./proc.js";
import type { Prompter } from "./prompt.js";
import type { Check } from "./verify.js";

/**
 * The harness never performs a remote mutation. Every unit of work is one of:
 *  - `write`:    create/merge a local file (transactional, with backup);
 *  - `doc`:      emit guidance / commands for a human (printed, or written to a
 *                doc file) — this is where cloud setup steps live, deliberately
 *                not run;
 *  - `probe`:    a read-only verification that yields a {@link Check} under
 *                --verify;
 *  - `exec`:     a LOCAL helper command run after writes under --apply (e.g.
 *                icacls/chmod to lock down a PEM, `mklink`/`ln` for a VDI
 *                junction, or a read-only quarantined tarball fetch) — it must
 *                never mutate a remote system;
 *  - `envblock`: upsert an aih-managed env block (one `scope`) into a shell
 *                profile; multiple scopes targeting the same file compose
 *                instead of clobbering each other;
 *  - `digest`:   a read-only computed result printed verbatim (an analytics
 *                report / roll-up) plus optional structured `data` echoed into
 *                `--json` — mutates nothing, never contacts a remote system.
 *  - `remove`:   delete a repo-LOCAL file aih exclusively owns (a stale per-CLI
 *                adapter / kiro extra when its CLI is dropped), reversibly by
 *                default (moved to gitignored `.aih/legacy/`). Fail-closed:
 *                contained, symlink-guarded, backed up before unlink. Never remote.
 * Because no action kind can mutate a remote system, an autonomous run cannot
 * "fake provisioning" — the capability simply does not exist.
 */
export type ActionKind = "write" | "probe" | "doc" | "exec" | "envblock" | "digest" | "remove";

export interface WriteAction {
  kind: "write";
  path: string;
  describe: string;
  /** Raw file contents (for text files). */
  contents?: string;
  /** Structured value (for JSON files); enables `merge`. */
  json?: unknown;
  /** Deep-merge `json` onto an existing file instead of overwriting. */
  merge?: boolean;
  /** Remove named child keys from top-level JSON objects after merge. */
  removeJsonKeys?: Record<string, readonly string[]>;
  /** Replace named top-level JSON keys with the generated value after merge. */
  replaceJsonKeys?: readonly string[];
  /** Replace named child JSON keys with generated values after merge. */
  replaceJsonChildKeys?: Record<string, readonly string[]>;
  /** Prune generated child JSON keys after merge, while keeping keys present in the new value. */
  pruneJsonChildKeys?: Record<string, { exact?: readonly string[]; prefixes?: readonly string[] }>;
  /** Remove named top-level JSON keys after merge. */
  removeJsonTopLevelKeys?: readonly string[];
  /** POSIX file mode, e.g. 0o755 for hooks. */
  mode?: number;
  /** Write only if the file is absent; never overwrite (user-owned seed files). */
  once?: boolean;
  /**
   * Allow this write to land OUTSIDE the target root (home/system files: PEM
   * bundles, shell profiles, VDI redirects). Repo-scoped writes leave this unset
   * and the executor fails closed if their resolved path escapes the root.
   */
  external?: boolean;
}

export interface DocAction {
  kind: "doc";
  describe: string;
  text: string;
  /** When set, the guidance is also written to this doc file. */
  path?: string;
}

export type ProbeRun = (ctx: PlanContext) => Promise<Check> | Check;

export interface StructuredLegacyProbeRun {
  verification?: VerificationPipelineRun;
  reportChecks: Check[];
}

export interface ProbeAction {
  kind: "probe";
  describe: string;
  run: ProbeRun;
  /** Dynamic scans may expand to several 1:1 checks after a prior exec action. */
  runMany?: (ctx: PlanContext) => Promise<Check[]> | Check[];
  /** Structured verification runs are adapted by the executor into the legacy report. */
  runStructured?: (ctx: PlanContext) => Promise<VerificationPipelineRun> | VerificationPipelineRun;
  /** Structured verification paired with explicit legacy checks for compatibility. */
  runStructuredLegacy?: (
    ctx: PlanContext,
  ) => Promise<StructuredLegacyProbeRun> | StructuredLegacyProbeRun;
  /** Legacy adaptation options for structured verification runs. */
  structured?: StructuredProbeOptions;
}

export type StructuredProbeOptions = Omit<StructuredVerificationRunCheckOptions, "name"> & {
  name?: string;
};

function structuredProbeCheckOptions(
  describe: string,
  structured: StructuredProbeOptions,
): StructuredVerificationRunCheckOptions {
  return { ...structured, name: structured.name ?? describe };
}

/**
 * A LOCAL helper command run after writes under `--apply` (e.g. icacls/chmod to
 * lock down a PEM, `mklink /J` for a VDI junction, `update-ca-certificates`, or
 * a read-only quarantined tarball fetch). It must never mutate a remote system —
 * that is what keeps the "no faked provisioning" guarantee intact.
 */
export interface ExecAction {
  kind: "exec";
  describe: string;
  argv: string[];
  /** Optional working directory for local, quarantined helper commands. */
  cwd?: string;
  /** Optional scrubbed environment for local helper commands. */
  env?: NodeJS.ProcessEnv;
  /** Optional timeout override for long-but-bounded local helpers. */
  timeoutMs?: number;
  /** Optional verification check to emit when the command exits non-zero. */
  failureCheck?: Check | ((result: RunResult) => Check);
  /** Skip follow-on probes when this command fails. */
  blockProbesOnFailure?: boolean;
  /** Continue the plan even if the command exits non-zero. */
  allowFailure?: boolean;
  /**
   * Apply-time content pin: refuse to run (abort the apply) unless the file's
   * bytes still hash to `sha256` — pins an apply-time exec to the plan-time
   * preflighted content, so nothing swapped in between plan and apply can ever
   * be consumed by the command (the validate-then-use TOCTOU).
   */
  expect?: { path: string; sha256: string };
}

/**
 * Upsert an aih-managed env block (one `scope`) into a shell profile. Unlike a
 * plain `write`, multiple `envblock` actions targeting the SAME file COMPOSE:
 * the executor folds every scope's block into the file in order (starting from
 * the on-disk content), so e.g. `bootstrap` can layer certs + hardware + vdi +
 * telemetry blocks into one profile without any of them clobbering the others.
 */
export interface EnvBlockAction {
  kind: "envblock";
  path: string;
  scope: string;
  shell: EnvShell;
  vars: EnvVar[];
  describe: string;
}

/**
 * A read-only ANALYSIS result surfaced to the operator. Unlike {@link DocAction}
 * (whose body only ever lands in a file), a digest's `text` is printed verbatim
 * beneath its headline by the summary, and its optional `data` rides into
 * `--json` — the shape analytics reports and inventory roll-ups need. It mutates
 * nothing and never contacts a remote system.
 */
export interface DigestAction {
  kind: "digest";
  describe: string;
  /** Report body, printed verbatim beneath the headline in text mode. */
  text?: string;
  /** Machine-readable payload echoed into `--json` output. */
  data?: unknown;
  /** Optional late-bound digest for analyses that depend on earlier exec/probe actions. */
  run?: (
    ctx: PlanContext,
  ) =>
    | Promise<string | { text: string; data?: unknown }>
    | string
    | { text: string; data?: unknown };
}

/**
 * Remove a repo-LOCAL file or directory that aih exclusively owns — aih's only
 * destructive action. Three emitters: `aih prune` (artifacts its detection proved
 * aih-owned — a per-CLI adapter note, a kiro steering/hook extra — once the CLI is
 * dropped), `aih skill remove` (a user-directed removal of an installed skill's
 * directory + committed card), and `aih skill quarantine` (the same reversible move,
 * but into `.aih/quarantine/` with the skill's approval kept). The executor fails
 * closed: mandatory {@link assertContained} on the raw
 * path (no `external` field exists, so a global `~/home` file is structurally
 * unreachable), a symlink guard, and a backup before unlink. By default it MOVES the
 * file to gitignored `.aih/legacy/<path>` (reversible; occupied destinations are never
 * overwritten); `archiveRoot` picks `.aih/quarantine/` instead, with the identical
 * containment/symlink/never-overwrite machinery. Under `hardDelete` it instead renames
 * to the sibling `<path>.aih.bak`
 * — the same single-slot, latest-wins backup every aih write gets — for users who
 * explicitly opt out of the archive.
 */
export interface RemoveAction {
  kind: "remove";
  /** Repo-relative path of the file to remove. */
  path: string;
  describe: string;
  /** Opt-in: single-slot `<path>.aih.bak` rename instead of the `.aih/legacy/` archive. */
  hardDelete?: boolean;
  /** Archive root for the reversible move. Closed union — never an arbitrary path. */
  archiveRoot?: ".aih/legacy" | ".aih/quarantine";
}

export type Action =
  | WriteAction
  | DocAction
  | ProbeAction
  | ExecAction
  | EnvBlockAction
  | DigestAction
  | RemoveAction;

export interface Plan {
  capability: string;
  actions: Action[];
}

/** Everything a capability needs to compute (and a runner to execute) its plan. */
export interface PlanContext {
  /** Target repository / workstation root. */
  root: string;
  /** Canonical context directory name (default ".ai-context"). */
  contextDir: string;
  /** Harness-wide governance posture dial, resolved by the shared ladder. */
  posture?: Posture;
  /** Where the active posture came from (flag/marker/env/default/org floor). */
  postureSource?: PostureSource;
  /** When false (default), the plan is computed but nothing is written. */
  apply: boolean;
  /** When true, probe actions run and contribute to the verification report. */
  verify: boolean;
  json: boolean;
  /**
   * Local process runner. During `plan()` (dry-run) only READ-ONLY tools on FIXED targets
   * may be run, and only to DECIDE the plan (heal's node/npm/TLS checks pick the repair
   * ladder; certs reads the OS trust store; report shells `git` for stats). Never shell out
   * an arbitrary or interpolated command at plan time — that is the `AIH_GRAPH_CMD` class of
   * bug. The read-only allowlist is pinned by `tests/internals/plan-purity.test.ts` (#35).
   */
  run: Runner;
  host: HostAdapter;
  env: NodeJS.ProcessEnv;
  /**
   * Interactive prompt seam. Present only when the user opted into an interactive
   * flow (e.g. `--detect`) in a TTY; undefined keeps the harness non-interactive.
   */
  prompter?: Prompter;
  /**
   * The resolved CLI target set, injected by an orchestrator (`aih init`) that
   * resolves `--detect`/`--cli` ONCE and threads the result into every phase. A
   * tool-specific phase emits a tool's files only when that tool is targeted (see
   * {@link isTargeted}). Undefined when a leaf command runs standalone — it then
   * keeps its single-tool identity (`aih profile` is the Cursor profiler, `aih
   * secrets` the Claude secrets guard) and always writes.
   */
  targets?: Cli[];
  /** Capability-specific options parsed from the CLI. */
  options: Record<string, unknown>;
}

export type PlanFn = (ctx: PlanContext) => Plan | Promise<Plan>;

export interface CommandOption {
  flags: string;
  description: string;
  default?: string | boolean;
  /** Mask this option's value before argv is written to logs/support artifacts. */
  sensitive?: boolean;
}

export interface CommandPositional {
  name: string;
  description?: string;
  required?: boolean;
  /** When set, the positional value is passed through ctx.options[optionName]. */
  optionName?: string;
}

export interface CommandSpec {
  name: string;
  summary: string;
  /** Current command aliases that dispatch without a deprecation warning. */
  aliases?: string[];
  /**
   * Old command NAMES this command still answers to after a rename — the
   * alias-before-removal deprecation machinery (STABILITY.md). Each entry
   * registers as a commander alias of this command on the shared registerSpec
   * path (src/commands/index.ts): the old name dispatches the SAME action with
   * the same flags, after ONE stderr line naming the replacement. An alias
   * lives for at least one minor release and is removed only by the next
   * major (VERSIONING.md), staying reserved in {@link builtinCommandNames}
   * for its whole grace window. Core-only: the plugin registry strips this
   * field from plugin specs — a plugin ships new commands, it never renames
   * (or shadows) core ones. TOP-LEVEL commands only: specs registered through
   * the manual parent-group paths (trust/skill/pack/marketplace/policy/
   * evidence subcommands) never pass through registerSpec, so the field is
   * silently ignored there — wire alias support into that path before the
   * first nested rename.
   */
  deprecatedAliases?: string[];
  positional?: CommandPositional;
  options?: CommandOption[];
  plan: PlanFn;
  /** Read-only commands (doctor/status) skip the apply path entirely. */
  readOnly?: boolean;
  /**
   * Read-only commands usually validate `--posture` for script compatibility but
   * do not let it change the resolved posture. Set this for read-only verifiers
   * whose checks are explicitly posture-scoped and remain mutation-free.
   */
  honorReadOnlyPostureFlag?: boolean;
  /**
   * Force `verify` on every run so the capability's probes always populate the
   * verification report — i.e. it DIAGNOSES by default (like `doctor`) yet still
   * mutates under `--apply` (unlike `readOnly`). `heal` uses this so a bare
   * `aih heal` surfaces the health report and a non-zero exit when broken.
   */
  alwaysVerify?: boolean;
  /**
   * Exempt from the dirty-worktree `--apply` preflight. For pure-analytics commands
   * (`aih report`) whose only writes are gitignored OUTPUT artifacts (the `.aih/`
   * report file + its ignore rule) — those never clobber uncommitted work, so
   * blocking the report on a dirty tree is wrong.
   */
  skipWorktreeGate?: boolean;
  /**
   * Wire an interactive prompter for this command in a TTY even without `--detect`,
   * so a bare run can offer a confirmation (e.g. `aih ready` asking to install the
   * missing core tools). Still suppressed under `--json`/`--yes`/non-TTY, so
   * automation stays non-interactive.
   */
  wantsInstallPrompt?: boolean;
}

// ---- builders -------------------------------------------------------------

export function writeText(
  path: string,
  contents: string,
  describe: string,
  opts: { merge?: boolean; mode?: number; once?: boolean; external?: boolean } = {},
): WriteAction {
  return {
    kind: "write",
    path,
    contents,
    describe,
    merge: opts.merge,
    mode: opts.mode,
    once: opts.once,
    external: opts.external,
  };
}

export function writeJson(
  path: string,
  value: unknown,
  describe: string,
  opts: {
    merge?: boolean;
    external?: boolean;
    removeJsonKeys?: Record<string, readonly string[]>;
    replaceJsonKeys?: readonly string[];
    replaceJsonChildKeys?: Record<string, readonly string[]>;
    pruneJsonChildKeys?: Record<
      string,
      { exact?: readonly string[]; prefixes?: readonly string[] }
    >;
    removeJsonTopLevelKeys?: readonly string[];
  } = {},
): WriteAction {
  return {
    kind: "write",
    path,
    json: value,
    describe,
    merge: opts.merge,
    external: opts.external,
    removeJsonKeys: opts.removeJsonKeys,
    replaceJsonKeys: opts.replaceJsonKeys,
    replaceJsonChildKeys: opts.replaceJsonChildKeys,
    pruneJsonChildKeys: opts.pruneJsonChildKeys,
    removeJsonTopLevelKeys: opts.removeJsonTopLevelKeys,
  };
}

export function doc(describe: string, text: string, path?: string): DocAction {
  return { kind: "doc", describe, text, path };
}

export function digest(describe: string, text: string, data?: unknown): DigestAction {
  return { kind: "digest", describe, text, data };
}

export function dynamicDigest(
  describe: string,
  run: NonNullable<DigestAction["run"]>,
): DigestAction {
  return { kind: "digest", describe, run };
}

export function probe(describe: string, run: ProbeRun): ProbeAction {
  return { kind: "probe", describe, run };
}

export function structuredProbe(
  describe: string,
  runStructured: NonNullable<ProbeAction["runStructured"]>,
  structured: StructuredProbeOptions = {},
): ProbeAction {
  return {
    kind: "probe",
    describe,
    run: async (ctx) =>
      structuredVerificationRunToCheck(
        await runStructured(ctx),
        structuredProbeCheckOptions(describe, structured),
      ),
    runStructured,
    structured,
  };
}

export function probeMany(
  describe: string,
  runMany: NonNullable<ProbeAction["runMany"]>,
): ProbeAction {
  return {
    kind: "probe",
    describe,
    run: () => ({ name: describe, verdict: "skip", detail: "multi-check probe" }),
    runMany,
  };
}

export function structuredChecksProbe(
  describe: string,
  runMany: NonNullable<ProbeAction["runMany"]>,
): ProbeAction {
  return {
    kind: "probe",
    describe,
    run: () => ({ name: describe, verdict: "skip", detail: "structured check probe" }),
    runMany,
    runStructuredLegacy: async (ctx) => {
      const reportChecks = await runMany(ctx);
      return {
        verification: legacyChecksToVerificationRun(reportChecks),
        reportChecks,
      };
    },
  };
}

export function exec(
  describe: string,
  argv: string[],
  opts: {
    allowFailure?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    failureCheck?: ExecAction["failureCheck"];
    blockProbesOnFailure?: boolean;
    expect?: ExecAction["expect"];
  } = {},
): ExecAction {
  return {
    kind: "exec",
    describe,
    argv,
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    failureCheck: opts.failureCheck,
    blockProbesOnFailure: opts.blockProbesOnFailure,
    allowFailure: opts.allowFailure,
    expect: opts.expect,
  };
}

export function envBlock(
  path: string,
  scope: string,
  shell: EnvShell,
  vars: EnvVar[],
  describe: string,
): EnvBlockAction {
  return { kind: "envblock", path, scope, shell, vars, describe };
}

export function remove(
  path: string,
  describe: string,
  opts: { hardDelete?: boolean; archiveRoot?: RemoveAction["archiveRoot"] } = {},
): RemoveAction {
  return {
    kind: "remove",
    path,
    describe,
    hardDelete: opts.hardDelete,
    archiveRoot: opts.archiveRoot,
  };
}

export function plan(capability: string, ...actions: Action[]): Plan {
  return { capability, actions };
}
