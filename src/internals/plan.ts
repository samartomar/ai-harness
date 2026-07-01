import type { Posture, PostureSource } from "../config/posture.js";
import type { EnvShell, HostAdapter } from "../platform/base.js";
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
 * Because no action kind can mutate a remote system, an autonomous run cannot
 * "fake provisioning" — the capability simply does not exist.
 */
export type ActionKind = "write" | "probe" | "doc" | "exec" | "envblock" | "digest";

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

export interface ProbeAction {
  kind: "probe";
  describe: string;
  run: (ctx: PlanContext) => Promise<Check> | Check;
  /** Dynamic scans may expand to several 1:1 checks after a prior exec action. */
  runMany?: (ctx: PlanContext) => Promise<Check[]> | Check[];
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

export type Action =
  | WriteAction
  | DocAction
  | ProbeAction
  | ExecAction
  | EnvBlockAction
  | DigestAction;

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
}

export interface CommandSpec {
  name: string;
  summary: string;
  options?: CommandOption[];
  plan: PlanFn;
  /** Read-only commands (doctor/status) skip the apply path entirely. */
  readOnly?: boolean;
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
  opts: { mode?: number; once?: boolean; external?: boolean } = {},
): WriteAction {
  return {
    kind: "write",
    path,
    contents,
    describe,
    mode: opts.mode,
    once: opts.once,
    external: opts.external,
  };
}

export function writeJson(
  path: string,
  value: unknown,
  describe: string,
  opts: { merge?: boolean; external?: boolean } = {},
): WriteAction {
  return { kind: "write", path, json: value, describe, merge: opts.merge, external: opts.external };
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

export function probe(describe: string, run: ProbeAction["run"]): ProbeAction {
  return { kind: "probe", describe, run };
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

export function plan(capability: string, ...actions: Action[]): Plan {
  return { capability, actions };
}
