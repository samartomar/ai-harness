/**
 * Typed error hierarchy for the harness. Every error carries a stable machine
 * `code` so `--json` output and `doctor` reports stay parseable across versions.
 */
export class AihError extends Error {
  readonly code: string;

  constructor(message: string, code = "AIH_ERROR") {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Invalid/contradictory configuration (env or CLI). Fail-closed. */
export class SettingsError extends AihError {
  constructor(message: string) {
    super(message, "AIH_SETTINGS");
  }
}

/** A host/platform probe could not be satisfied on this OS. */
export class PlatformError extends AihError {
  constructor(message: string) {
    super(message, "AIH_PLATFORM");
  }
}

/** A staged filesystem transaction failed (and was rolled back). */
export class FsTxnError extends AihError {
  constructor(message: string) {
    super(message, "AIH_FSTXN");
  }
}

/** A verification probe failed in a way that should halt the run. */
export class VerificationError extends AihError {
  constructor(message: string) {
    super(message, "AIH_VERIFY");
  }
}

/** Capability not yet implemented (foundation stub). */
export class NotImplementedError extends AihError {
  constructor(message: string) {
    super(message, "AIH_NOT_IMPLEMENTED");
  }
}

/** Existing config could not be parsed for a merge — fail closed, never partial-merge. */
export class MergeError extends AihError {
  constructor(message: string) {
    super(message, "AIH_MERGE");
  }
}

/** An action path escaped its intended root (path-containment violation). Fail-closed. */
export class PathContainmentError extends AihError {
  constructor(message: string) {
    super(message, "AIH_PATH_CONTAINMENT");
  }
}

/** An `--apply` was attempted on a dirty git worktree without `--force`. Fail-closed. */
export class DirtyWorktreeError extends AihError {
  constructor(message: string) {
    super(message, "AIH_DIRTY_WORKTREE");
  }
}

export interface ChangeProfileInputIssue {
  issueCode: string;
  path: string;
}

const MAX_CHANGE_PROFILE_ISSUES = 20;

function safeChangeProfileIssuePath(path: string): string {
  if (
    /^(?:schemaVersion|source|expectRuleTableVersion|changes)(?:\.(?:\d+|scope|status|path|previousPath|before|after|beforeRevision|afterRevision|kind|text|byteLength|reason|revision|code))*$/.test(
      path,
    )
  ) {
    return path;
  }
  return "<invalid>";
}

function safeChangeProfileIssues(
  issues: readonly ChangeProfileInputIssue[],
): ChangeProfileInputIssue[] {
  return issues
    .map((issue) => ({
      issueCode: /^[a-z0-9][a-z0-9.-]{0,63}$/.test(issue.issueCode)
        ? issue.issueCode
        : "input.invalid",
      path: safeChangeProfileIssuePath(issue.path),
    }))
    .sort(
      (a, b) =>
        (a.issueCode < b.issueCode ? -1 : a.issueCode > b.issueCode ? 1 : 0) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
}

function renderChangeProfileIssues(issues: readonly ChangeProfileInputIssue[]): string {
  const rendered = issues
    .slice(0, MAX_CHANGE_PROFILE_ISSUES)
    .map((issue) => `${issue.issueCode}@${issue.path}`)
    .join(", ");
  const omitted = issues.length - Math.min(issues.length, MAX_CHANGE_PROFILE_ISSUES);
  return `change-profile input is invalid (${issues.length} issue${issues.length === 1 ? "" : "s"}): ${rendered}${
    omitted > 0 ? `, +${omitted} more` : ""
  }`;
}

/** Supplied change facts are malformed or contradictory. Details are deliberately redacted. */
export class ChangeProfileInputError extends AihError {
  readonly issues: readonly ChangeProfileInputIssue[];
  readonly issueTotal: number;

  constructor(issues: readonly ChangeProfileInputIssue[]) {
    const safeIssues = safeChangeProfileIssues(issues);
    super(renderChangeProfileIssues(safeIssues), "AIH_CHANGE_PROFILE_INPUT");
    this.issueTotal = safeIssues.length;
    this.issues = safeIssues.slice(0, MAX_CHANGE_PROFILE_ISSUES);
  }

  toJSON(): {
    name: string;
    code: string;
    message: string;
    issueTotal: number;
    issues: readonly ChangeProfileInputIssue[];
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      issueTotal: this.issueTotal,
      issues: this.issues,
    };
  }
}

/** A live command option or prompt file failed its bounded input contract. */
type LiveErrorCli = "codex" | "claude" | "kimi";
type LiveErrorSafety = "read_only" | "non_read_only";

function liveErrorMessage(summary: string, cli?: LiveErrorCli, safety?: LiveErrorSafety): string {
  return cli === undefined || safety === undefined
    ? summary
    : `${summary}; cli=${cli}; safety=${safety}`;
}

class LiveCliError extends AihError {
  readonly cli: LiveErrorCli | undefined;
  readonly safety: LiveErrorSafety | undefined;

  constructor(summary: string, code: string, cli?: LiveErrorCli, safety?: LiveErrorSafety) {
    super(liveErrorMessage(summary, cli, safety), code);
    this.cli = cli;
    this.safety = safety;
  }
}

export class LiveInputError extends LiveCliError {
  constructor(cli?: LiveErrorCli, safety?: LiveErrorSafety) {
    super("live input is invalid", "AIH_LIVE_INPUT", cli, safety);
  }
}

/** Kimi's native-tools risk was not explicitly acknowledged. */
export class LiveConsentError extends LiveCliError {
  constructor() {
    super("Kimi requires --allow-kimi-non-read-only", "AIH_LIVE_CONSENT", "kimi", "non_read_only");
  }
}

/** The explicitly selected local CLI cannot be launched through an allowed transport. */
export class LiveUnavailableError extends LiveCliError {
  constructor(cli: LiveErrorCli, safety: LiveErrorSafety) {
    super("the selected live CLI is unavailable", "AIH_LIVE_UNAVAILABLE", cli, safety);
  }
}

/** The selected local CLI could not be spawned. */
export class LiveSpawnError extends LiveCliError {
  constructor(cli: LiveErrorCli, safety: LiveErrorSafety) {
    super("the selected live CLI could not be started", "AIH_LIVE_SPAWN", cli, safety);
  }
}

/** The selected local CLI exceeded the operator's bounded timeout. */
export class LiveTimeoutError extends LiveCliError {
  constructor(cli: LiveErrorCli, safety: LiveErrorSafety) {
    super("the selected live CLI timed out", "AIH_LIVE_TIMEOUT", cli, safety);
  }
}

/** The selected local CLI's stream failed before a terminal result settled. */
export class LiveStreamError extends LiveCliError {
  constructor(cli: LiveErrorCli, safety: LiveErrorSafety) {
    super("the selected live CLI stream failed", "AIH_LIVE_STREAM", cli, safety);
  }
}

/** The selected local CLI exited without its pinned terminal result shape. */
export class LiveResultError extends LiveCliError {
  constructor(cli: LiveErrorCli, safety: LiveErrorSafety) {
    super(
      "the selected live CLI returned no valid terminal result",
      "AIH_LIVE_RESULT",
      cli,
      safety,
    );
  }
}
