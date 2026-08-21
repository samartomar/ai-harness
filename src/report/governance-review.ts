import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { EffectiveOrgPolicy } from "../org-policy/effective.js";
import {
  type OrgPolicyEffectiveDigestResolution,
  orgPolicyEffectiveDigest,
  orgPolicyEffectiveResolution,
} from "../org-policy/evaluate.js";
import { publicDecisionView } from "../org-policy/project.js";
import { governanceOwnsAihSurfaces, readOrgPolicy } from "../org-policy/schema.js";
import type { StrictUsageRead, UsageEvent } from "../usage/events.js";
import { readUsageStrict } from "../usage/events.js";

const FORMAT = "aih-governance-review-v1";

type ReviewReceipts = OrgPolicyEffectiveDigestResolution["receipts"];

export interface GovernanceReviewInput {
  effective: EffectiveOrgPolicy;
  receipts: ReviewReceipts;
  usage: StrictUsageRead;
}

type Attribution = { exact: number; heuristic: number };

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mcpServerOf(candidate: EffectiveOrgPolicy["candidates"][number]): string | undefined {
  return candidate.kind === "mcp" && candidate.source.type === "mcp"
    ? candidate.source.server
    : undefined;
}

function nameMatchesSubject(event: UsageEvent, subject: string): boolean {
  if (event.name === undefined) return false;
  return event.name
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .includes(subject);
}

function attributeEvents(
  candidates: readonly EffectiveOrgPolicy["candidates"][number][],
  events: readonly UsageEvent[],
): { bySubject: ReadonlyMap<string, Attribution>; unmatched: number } {
  const bySubject = new Map<string, Attribution>(
    candidates.map((candidate) => [candidate.id, { exact: 0, heuristic: 0 }]),
  );
  let unmatched = 0;
  for (const event of events) {
    const exact = candidates.filter(
      (candidate) => event.kind === "mcp" && event.server === mcpServerOf(candidate),
    );
    const heuristic =
      exact.length === 0
        ? candidates.filter((candidate) => nameMatchesSubject(event, candidate.id))
        : [];
    const match = exact.length > 0 ? exact[0] : heuristic.length === 1 ? heuristic[0] : undefined;
    if (match === undefined) {
      unmatched += 1;
      continue;
    }
    const counts = bySubject.get(match.id);
    if (counts === undefined)
      throw new Error("governance review attribution lost a governed subject");
    if (exact.length > 0) counts.exact += 1;
    else counts.heuristic += 1;
  }
  return { bySubject, unmatched };
}

function captureState(
  installed: boolean,
  usage: StrictUsageRead,
  unmatched: number,
): "no-capture" | "installed-zero-observed" | "partial-attribution" | "attributed" {
  if (!installed) return "no-capture";
  if (usage.events.length === 0) return "installed-zero-observed";
  return unmatched > 0 || usage.malformed > 0 || usage.unknownKind > 0
    ? "partial-attribution"
    : "attributed";
}

function subjectCaptureState(
  installed: boolean,
  attribution: Attribution,
): "observed" | "not-observed-with-installed-capture" | "unknown-no-capture" {
  if (attribution.exact + attribution.heuristic > 0) return "observed";
  return installed ? "not-observed-with-installed-capture" : "unknown-no-capture";
}

function strictCaptureInstalled(
  candidates: readonly EffectiveOrgPolicy["candidates"][number][],
  receipts: ReviewReceipts,
): boolean {
  return (
    receipts.hook.state === "active" &&
    candidates.some(
      (candidate) =>
        candidate.id === "usage-metering" &&
        candidate.requested &&
        candidate.effective &&
        candidate.kind === "hook" &&
        candidate.source.type === "hook" &&
        candidate.source.handler === "usage-metering" &&
        candidate.projection.projector === "usage-hook" &&
        candidate.projection.ownership === "usage-hook-receipt",
    )
  );
}

function receiptFor(
  candidate: EffectiveOrgPolicy["candidates"][number],
  receipts: ReviewReceipts,
): { state: string; targets?: Record<string, string> } {
  if (candidate.kind === "mcp") {
    const targets = Object.fromEntries(
      candidate.projection.requestedTargets.flatMap((target) => {
        if (target === "claude") return [[target, receipts.mcp.state]];
        if (target === "kiro") return [[target, receipts.kiro.state]];
        return [];
      }),
    );
    const states = [...new Set(Object.values(targets))];
    return {
      state: states.length === 1 ? (states[0] ?? candidate.projection.receipt) : "multiple",
      ...(Object.keys(targets).length === 0 ? {} : { targets }),
    };
  }
  if (candidate.projection.ownership === "usage-hook-receipt")
    return { state: receipts.hook.state };
  if (candidate.projection.ownership === "hook-registrar-receipt") {
    return { state: receipts.registrar.state };
  }
  return { state: candidate.projection.receipt };
}

function decisionFacts(candidate: EffectiveOrgPolicy["candidates"][number]) {
  return {
    decision:
      candidate.decision === undefined
        ? { state: "absent" as const }
        : { state: "recorded" as const, ...publicDecisionView(candidate.decision) },
    approval:
      candidate.approval === undefined
        ? { state: "absent" as const }
        : { state: "present" as const, id: candidate.approval.id },
    revocation:
      candidate.revocation === undefined
        ? { state: "absent" as const }
        : {
            state: "present" as const,
            issuer: candidate.revocation.issuer,
            revokedAt: candidate.revocation.revokedAt,
          },
  };
}

/**
 * Pure, bounded governance-review composition. It neither resolves policy nor
 * changes it: effective state comes from the supplied resolver result only.
 */
export function governanceReviewView(input: GovernanceReviewInput): DigestAction {
  const candidates = [...input.effective.candidates].sort((left, right) =>
    ordinalCompare(left.id, right.id),
  );
  const attribution = attributeEvents(candidates, input.usage.events);
  const installed = strictCaptureInstalled(candidates, input.receipts);
  const capture = captureState(installed, input.usage, attribution.unmatched);
  const subjects = candidates.map((candidate, index) => {
    const counts = attribution.bySubject.get(candidate.id);
    if (counts === undefined)
      throw new Error("governance review subject is missing attribution counts");
    return {
      ordinal: index + 1,
      id: candidate.id,
      kind: candidate.kind,
      lifecycle: candidate.lifecycle,
      requested: candidate.requested,
      effective: candidate.effective,
      evidence: {
        state: candidate.evidence,
        findings: [...candidate.dangerCodes],
        blockers: [...candidate.blockingCodes],
        decisionBlockers: candidate.decisionBlockers.map((blocker) => blocker.code),
      },
      ...decisionFacts(candidate),
      projector: {
        name: candidate.projection.projector,
        requestedTargets: [...candidate.projection.requestedTargets],
        supportedTargets: [...candidate.projection.supportedTargets],
        selectedTargets: [...candidate.projection.availableTargets],
        coverage: candidate.projection.coverage,
        ownership: candidate.projection.ownership,
      },
      materialization: receiptFor(candidate, input.receipts),
      usage: {
        count: counts.exact + counts.heuristic,
        signal: subjectCaptureState(installed, counts),
      },
      attribution: counts,
    };
  });
  const data = {
    format: FORMAT,
    policy: {
      state: "governed" as const,
      ...(input.effective.policyVersion === undefined
        ? {}
        : { version: input.effective.policyVersion }),
      authority: input.effective.authority.verified ? "verified" : "unverified",
    },
    usage: {
      state: capture,
      validEvents: input.usage.events.length,
      malformedExcluded: input.usage.malformed,
      unknownKindExcluded: input.usage.unknownKind,
      unmatched: attribution.unmatched,
    },
    subjects,
  };
  const body = lines(
    "Read-only governance review. Usage is an attribution signal only; it never changes requested or effective state.",
    "Unmatched event names and rejected payloads are never rendered.",
    "",
    `Capture: ${data.usage.state}; valid=${data.usage.validEvents}; malformed-excluded=${data.usage.malformedExcluded}; unknown-kind-excluded=${data.usage.unknownKindExcluded}; unmatched=${data.usage.unmatched}.`,
    "",
    "| # | Subject | Requested | Effective | Evidence / blockers | Decision / approval / revocation | Projector / receipt | Capture / attribution |",
    "|---:|---|---:|---:|---|---|---|---|",
    ...subjects.map(
      (subject) =>
        `| ${subject.ordinal} | ${subject.id} | ${subject.requested ? "yes" : "no"} | ${subject.effective ? "yes" : "no"} | ${subject.evidence.state}; findings=${subject.evidence.findings.length}; blockers=${subject.evidence.blockers.length + subject.evidence.decisionBlockers.length} | decision=${subject.decision.state}; approval=${subject.approval.state}; revocation=${subject.revocation.state} | ${subject.projector.name}; coverage=${subject.projector.coverage}; receipt=${subject.materialization.state}${
          subject.materialization.targets === undefined
            ? ""
            : ` (${Object.entries(subject.materialization.targets)
                .map(([target, state]) => `${target}:${state}`)
                .join(",")})`
        } | ${subject.usage.signal}; count=${subject.usage.count}; exact=${subject.attribution.exact}; heuristic=${subject.attribution.heuristic} |`,
    ),
  );
  return digest(
    `Governance review — ${subjects.length} governed subject${subjects.length === 1 ? "" : "s"}`,
    body,
    data,
  );
}

function unavailableReview(
  state: "absent" | "invalid" | "not-governing",
  usage: StrictUsageRead,
): DigestAction {
  const data = {
    format: FORMAT,
    policy: { state },
    subjects: [],
    usage: {
      state: captureState(false, usage, usage.events.length),
      validEvents: usage.events.length,
      malformedExcluded: usage.malformed,
      unknownKindExcluded: usage.unknownKind,
      unmatched: usage.events.length,
    },
  };
  return digest(
    `Governance review — policy ${state}`,
    lines(
      `Governance review is unavailable because the policy is ${state}. No policy or receipt detail is rendered.`,
      "Usage remains read-only and cannot infer governance state.",
    ),
    data,
  );
}

export interface GovernanceReviewDigestOptions {
  /** Reuse a local-panel policy digest, including an explicitly absent digest. */
  effectiveDigest?: DigestAction;
  reuseEffectiveDigest?: boolean;
}

/** Read policy/runtime facts once and pass only bounded facts to the review view. */
export async function governanceReviewDigest(
  ctx: PlanContext,
  options: GovernanceReviewDigestOptions = {},
): Promise<DigestAction> {
  const usage = readUsageStrict(ctx);
  const effectiveDigest = options.reuseEffectiveDigest
    ? options.effectiveDigest
    : await orgPolicyEffectiveDigest(ctx);
  const resolution = orgPolicyEffectiveResolution(effectiveDigest);
  if (resolution !== undefined) {
    return governanceReviewView({ ...resolution, usage });
  }
  if (effectiveDigest !== undefined) return unavailableReview("invalid", usage);
  try {
    const policy = readOrgPolicy(ctx.root, ctx.env);
    if (policy === undefined) return unavailableReview("absent", usage);
    if (!governanceOwnsAihSurfaces(policy)) return unavailableReview("not-governing", usage);
    return unavailableReview("invalid", usage);
  } catch {
    return unavailableReview("invalid", usage);
  }
}
