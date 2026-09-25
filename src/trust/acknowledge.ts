import { AihError } from "../errors.js";
import type { PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { trustCodeClassV1 } from "./evidence.js";
import { TRUST_REVIEW_CODES } from "./grade.js";

export const TRUST_DANGER_CODES = new Set<string>([
  "trust.auto-exec-hook",
  "trust.malicious-code",
  "trust.prompt-injection",
  "trust.hidden-unicode",
  "trust.unpinned-dependency",
  "trust.dependency-confusion",
  "trust.typosquat",
  "trust.source-changed",
  "trust.source-drift",
  "trust.unsigned-source",
]);

export interface AcknowledgementResult {
  checks: Check[];
  acceptedFingerprints: string[];
}

export function acknowledgeReason(ctx: PlanContext): string | undefined {
  const value = ctx.options.reason;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function requestedAcknowledgementFingerprints(ctx: PlanContext): string[] {
  const value = ctx.options.acknowledge;
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function wantsAcknowledgeAll(ctx: PlanContext): boolean {
  return ctx.options.acknowledgeAll === true;
}

export function hasAcknowledgementRequest(ctx: PlanContext): boolean {
  return wantsAcknowledgeAll(ctx) || requestedAcknowledgementFingerprints(ctx).length > 0;
}

function actor(ctx: PlanContext): string {
  return (
    ctx.env.GIT_AUTHOR_NAME ??
    ctx.env.GIT_COMMITTER_NAME ??
    ctx.env.USER ??
    ctx.env.USERNAME ??
    "local operator"
  );
}

/**
 * Any finding or evidence problem can be acknowledged: the acknowledgement records
 * the consumer's decision and is never required (D50). An integrity failure cannot:
 * the scanned bytes are not the recorded source, so there is nothing to decide on.
 */
function isAcknowledgeable(check: Check): boolean {
  const trustClass = trustCodeClassV1(check.code);
  return (
    trustClass === "finding" ||
    trustClass === "evidence-problem" ||
    (check.code !== undefined && TRUST_REVIEW_CODES.has(check.code)) ||
    check.code === "mcp.policy-denied"
  );
}

function integrityRefusal(check: Check): AihError {
  return new AihError(
    `cannot acknowledge ${check.code ?? check.name}; the scanned bytes do not match the recorded source, so the evidence itself is not usable — re-fetch or re-pin the source and scan again`,
    "AIH_TRUST",
  );
}

function acknowledgementDetail(check: Check, ctx: PlanContext): string {
  const when = new Date().toISOString();
  const who = actor(ctx);
  const reason = acknowledgeReason(ctx);
  const suffix = reason ? `; reason: ${reason}` : "";
  return `acknowledged by ${who} at ${when}${suffix}${check.detail ? ` (${check.detail})` : ""}`;
}

export function applyTrustAcknowledgements(
  checks: readonly Check[],
  ctx: PlanContext,
): AcknowledgementResult {
  if (!hasAcknowledgementRequest(ctx)) return { checks: [...checks], acceptedFingerprints: [] };

  const explicit = new Set(requestedAcknowledgementFingerprints(ctx));
  const acknowledgeAll = wantsAcknowledgeAll(ctx);
  const selected = checks.filter((check) => {
    if (check.verdict !== "fail" || check.fingerprint === undefined) return false;
    return acknowledgeAll || explicit.has(check.fingerprint);
  });

  const integrity = selected.find((check) => trustCodeClassV1(check.code) === "integrity");
  if (integrity !== undefined) throw integrityRefusal(integrity);
  const other = selected.find((check) => !isAcknowledgeable(check));
  if (other !== undefined) {
    throw new AihError(
      `cannot acknowledge ${other.code ?? other.name}; only findings and evidence problems can be acknowledged`,
      "AIH_TRUST",
    );
  }
  if (selected.length > 0 && acknowledgeReason(ctx) === undefined) {
    throw new AihError(
      "--acknowledge requires --reason; the acknowledgement records your decision and why",
      "AIH_TRUST",
    );
  }

  const selectedFingerprints = new Set(
    selected.map((check) => check.fingerprint).filter((fp): fp is string => fp !== undefined),
  );
  return {
    acceptedFingerprints: [...selectedFingerprints],
    checks: checks.map((check) => {
      if (check.fingerprint === undefined || !selectedFingerprints.has(check.fingerprint)) {
        return check;
      }
      return {
        ...check,
        verdict: "skip",
        detail: acknowledgementDetail(check, ctx),
      };
    }),
  };
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

export function acknowledgeCommandHint(
  command: "workspace add" | "trust scan",
  source: string,
  checks: readonly Check[],
): string | undefined {
  const fingerprints = checks
    .filter((check) => check.verdict === "fail" && check.fingerprint !== undefined)
    .filter(isAcknowledgeable)
    .map((check) => check.fingerprint as string);
  if (fingerprints.length === 0) return undefined;
  return `To record your decision on the current finding(s), rerun: aih ${command} ${quoteArg(
    source,
  )} --acknowledge ${quoteArg(fingerprints.join(","))} --reason ${quoteArg("<reason>")}`;
}
