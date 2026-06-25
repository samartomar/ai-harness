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
