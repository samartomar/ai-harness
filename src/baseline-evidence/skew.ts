import { BASELINE_EVIDENCE_SCHEMA_VERSION } from "./schema.js";

/**
 * Version-skew floor for baseline evidence locks (ruling 2026-08-06, "Break the
 * coupling"). The lock is becoming a separately versioned, signed artifact, so
 * an installed build can be handed a lock produced by a NEWER build — one that
 * may legally name schema fields or component shapes this build's parser
 * rejects.
 *
 * The floor exists so that case is diagnosed by the declared version, before any
 * structural parse, and reported as what it is. Falling through to the parser
 * would surface skew as a shape error, or worse as the ABSENCE of evidence — the
 * silent-acceptance path that already injured these users at 3.1 and 3.4.
 *
 * This is a pure classifier on purpose: the org attested-bundle path consumes it
 * today, and the out-of-band fetch path consumes the same verdict when it lands.
 */
export type BaselineLockSkew =
  | { readonly status: "supported"; readonly declared: number }
  | {
      readonly status: "too-new";
      readonly declared: number;
      readonly supported: number;
      readonly detail: string;
    }
  | { readonly status: "unreadable"; readonly detail: string };

function declaredSchemaVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const declared = (value as { schemaVersion?: unknown }).schemaVersion;
  if (typeof declared !== "number" || !Number.isSafeInteger(declared) || declared < 1) {
    return undefined;
  }
  return declared;
}

/** Classify a candidate lock's declared schema version against this build. */
export function classifyBaselineLockSkew(value: unknown): BaselineLockSkew {
  const declared = declaredSchemaVersion(value);
  if (declared === undefined) {
    return {
      status: "unreadable",
      detail:
        "baseline evidence lock does not declare a positive integer schemaVersion, so this build cannot tell whether it can read it",
    };
  }
  if (declared > BASELINE_EVIDENCE_SCHEMA_VERSION) {
    return {
      status: "too-new",
      declared,
      supported: BASELINE_EVIDENCE_SCHEMA_VERSION,
      detail: `baseline evidence lock declares schema version ${declared}, but this build parses version ${BASELINE_EVIDENCE_SCHEMA_VERSION}; upgrade aih to read this evidence rather than installing against an older answer`,
    };
  }
  if (declared !== BASELINE_EVIDENCE_SCHEMA_VERSION) {
    return {
      status: "unreadable",
      detail: `baseline evidence lock declares schema version ${declared}, which this build does not parse (it parses version ${BASELINE_EVIDENCE_SCHEMA_VERSION})`,
    };
  }
  return { status: "supported", declared };
}
