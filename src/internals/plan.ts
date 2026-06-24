import type { EnvShell, HostAdapter } from "../platform/base.js";
import type { EnvVar } from "./envfile.js";
import type { Runner } from "./proc.js";
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
 *  - `exec`:     a LOCAL mutating command run after writes under --apply (e.g.
 *                icacls/chmod to lock down a PEM, `mklink`/`ln` for a VDI
 *                junction) — it must never contact a remote system;
 *  - `envblock`: upsert an aih-managed env block (one `scope`) into a shell
 *                profile; multiple scopes targeting the same file compose
 *                instead of clobbering each other.
 * Because no action kind can mutate a remote system, an autonomous run cannot
 * "fake provisioning" — the capability simply does not exist.
 */
export type ActionKind = "write" | "probe" | "doc" | "exec" | "envblock";

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
}

/**
 * A LOCAL mutating command run after writes under `--apply` (e.g. icacls/chmod
 * to lock down a PEM, `mklink /J` for a VDI junction, `update-ca-certificates`).
 * It must never contact or mutate a remote system — that is what keeps the
 * "no faked provisioning" guarantee intact.
 */
export interface ExecAction {
  kind: "exec";
  describe: string;
  argv: string[];
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

export type Action = WriteAction | DocAction | ProbeAction | ExecAction | EnvBlockAction;

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
  /** When false (default), the plan is computed but nothing is written. */
  apply: boolean;
  /** When true, probe actions run and contribute to the verification report. */
  verify: boolean;
  json: boolean;
  run: Runner;
  host: HostAdapter;
  env: NodeJS.ProcessEnv;
  /**
   * Interactive prompt seam. Present only when the user opted into an interactive
   * flow (e.g. `--detect`) in a TTY; undefined keeps the harness non-interactive.
   */
  prompter?: Prompter;
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
}

// ---- builders -------------------------------------------------------------

export function writeText(
  path: string,
  contents: string,
  describe: string,
  opts: { mode?: number; once?: boolean } = {},
): WriteAction {
  return { kind: "write", path, contents, describe, mode: opts.mode, once: opts.once };
}

export function writeJson(
  path: string,
  value: unknown,
  describe: string,
  opts: { merge?: boolean } = {},
): WriteAction {
  return { kind: "write", path, json: value, describe, merge: opts.merge };
}

export function doc(describe: string, text: string, path?: string): DocAction {
  return { kind: "doc", describe, text, path };
}

export function probe(describe: string, run: ProbeAction["run"]): ProbeAction {
  return { kind: "probe", describe, run };
}

export function exec(
  describe: string,
  argv: string[],
  opts: { allowFailure?: boolean } = {},
): ExecAction {
  return { kind: "exec", describe, argv, allowFailure: opts.allowFailure };
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
