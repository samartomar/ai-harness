import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { Check } from "../internals/verify.js";
import { type EffectiveOrgPolicy, stableJson } from "./effective.js";
import { hookRegistrarReport } from "./hook-registrar.js";
import {
  ORG_POLICY_HOOK_RECEIPT_PATH,
  orgPolicyHookReceiptState,
  orgPolicyKiroMcpReceiptState,
  orgPolicyMcpReceiptState,
  publicDecisionView,
} from "./project.js";
import { resolveRuntimeOrgPolicy } from "./runtime.js";
import { governanceOwnsAihSurfaces, readOrgPolicy } from "./schema.js";

export interface OrgPolicyEffectiveDigestResolution {
  effective: EffectiveOrgPolicy;
  receipts: {
    hook: Pick<ReturnType<typeof orgPolicyHookReceiptState>, "state">;
    mcp: Pick<ReturnType<typeof orgPolicyMcpReceiptState>, "state">;
    kiro: Pick<ReturnType<typeof orgPolicyKiroMcpReceiptState>, "state">;
    registrar: Pick<ReturnType<typeof hookRegistrarReport>, "state">;
  };
}

const effectiveDigestResolutions = new WeakMap<DigestAction, OrgPolicyEffectiveDigestResolution>();

/** Runtime facts paired with one effective digest without widening its public JSON data. */
export function orgPolicyEffectiveResolution(
  digest: DigestAction | undefined,
): OrgPolicyEffectiveDigestResolution | undefined {
  return digest === undefined ? undefined : effectiveDigestResolutions.get(digest);
}

function requestedCandidates(effective: EffectiveOrgPolicy) {
  return effective.candidates.filter((candidate) => candidate.requested);
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function publicList(values: readonly string[]): string {
  const ordered = [...new Set(values)].sort(ordinalCompare);
  return ordered.length === 0 ? "none" : ordered.join(",");
}

function publicPolicyDecisionBlockers(effective: EffectiveOrgPolicy): string {
  return publicList(
    effective.decisionBlockers.map(
      (blocker) => `${blocker.code}${blocker.decision === undefined ? "" : `:${blocker.decision}`}`,
    ),
  );
}

/** Bounded public decision facts shared by policy evaluate and doctor checks. */
function requestedCandidateSummary(effective: EffectiveOrgPolicy): string {
  const summaries = requestedCandidates(effective)
    .slice()
    .sort((left, right) => ordinalCompare(left.id, right.id))
    .map((candidate) => {
      const decision = candidate.decision;
      const risk = decision === undefined ? "none" : (decision.riskState ?? "blocked");
      return (
        `${candidate.id}{decision=${decision?.id ?? "none"}; ` +
        `observedFindings=${publicList(decision?.observedFindings ?? [])}; ` +
        `observedGaps=${publicList(decision?.observedGaps ?? [])}; ` +
        `acceptedFindings=${publicList(decision?.acceptedFindings ?? [])}; ` +
        `acceptedGaps=${publicList(decision?.acceptedGaps ?? [])}; ` +
        `risk=${risk}; ` +
        `danger=${publicList(candidate.dangerCodes)}; ` +
        `blocking=${publicList(candidate.blockingCodes)}; ` +
        `decisionBlockers=${publicList(candidate.decisionBlockers.map((blocker) => blocker.code))}}`
      );
    });
  const lifecycle = (effective.npmPackageLifecycle ?? [])
    .map(
      (item) =>
        `${item.subjectId ?? "store"}@${item.target ?? "none"}{state=${item.state}; reason=${item.reason}}`,
    )
    .sort(ordinalCompare);
  const upstream = (effective.upstreamArtifactLifecycle ?? [])
    .map(
      (item) =>
        `${item.subject?.kind ?? "artifact"}:${item.subject?.id ?? "store"}@${item.target ?? "none"}{effect=${item.effect ?? "none"}; state=${item.state}; reason=${item.reason}}`,
    )
    .sort(ordinalCompare);
  return `requested candidates: ${summaries.length === 0 ? "none" : summaries.join(" | ")}; npmLifecycle=${lifecycle.length === 0 ? "none" : lifecycle.join(" | ")}; upstreamArtifactLifecycle=${upstream.length === 0 ? "none" : upstream.join(" | ")}; policyDecisionBlockers=${publicPolicyDecisionBlockers(effective)}`;
}

function withRequestedCandidateSummary(detail: string, effective: EffectiveOrgPolicy): string {
  return `${detail}; ${requestedCandidateSummary(effective)}`;
}

function blockedDetail(effective: EffectiveOrgPolicy): string {
  const blocked = requestedCandidates(effective).filter((candidate) => !candidate.effective);
  const candidates = blocked
    .map((candidate) => {
      const codes = [
        ...candidate.dangerCodes,
        ...candidate.blockingCodes,
        ...candidate.decisionBlockers.map((blocker) => blocker.code),
      ];
      const reasons = candidate.resolutionReasons;
      return `${candidate.id}: ${codes.length === 0 ? "not-effective" : codes.join(", ")}${
        reasons.length === 0 ? "" : `; resolution=${reasons.join(", ")}`
      }`;
    })
    .join("; ");
  const lifecycle = (effective.npmPackageLifecycle ?? [])
    .filter((item) => item.state !== "observed-effective")
    .map(
      (item) =>
        `${item.subjectId ?? "store"}@${item.target ?? "none"}: ${item.state}; reason=${item.reason}`,
    )
    .sort(ordinalCompare);
  const upstream = (effective.upstreamArtifactLifecycle ?? [])
    .filter((item) => item.state !== "observed-effective")
    .map(
      (item) =>
        `${item.subject?.kind ?? "artifact"}:${item.subject?.id ?? "store"}@${item.target ?? "none"}: ${item.state}; reason=${item.reason}`,
    )
    .sort(ordinalCompare);
  return [...(candidates.length === 0 ? [] : [candidates]), ...lifecycle, ...upstream].join("; ");
}

/** Read-only verdict used by doctor and policy evaluate; never trusts policy booleans as proof. */
export async function orgPolicyEffectiveCheck(ctx: PlanContext): Promise<Check> {
  try {
    const policy = readOrgPolicy(ctx.root, ctx.env);
    if (policy === undefined) {
      const hookReceipt = orgPolicyHookReceiptState(ctx, {
        candidates: [],
        activeMcpServerIds: [],
        frameworkSelections: [],
        externalCuration: [],
        externalSelections: [],
        decisionBlockers: [],
        blocking: false,
        authority: { verified: false },
      });
      if (hookReceipt.state !== "absent") {
        return {
          name: "org policy effective resolution",
          verdict: "fail",
          code: "org-policy.effective-blocked",
          detail: hookReceipt.detail,
          location: { uri: ORG_POLICY_HOOK_RECEIPT_PATH },
          fingerprint: `org-policy-hook-receipt:${hookReceipt.state}`,
        };
      }
      return {
        name: "org policy effective resolution",
        verdict: "skip",
        detail: "no governed candidate inventory is active in this repo",
      };
    }
    const effective = (await resolveRuntimeOrgPolicy(ctx, policy)).effective;
    const hookReceipt = orgPolicyHookReceiptState(ctx, effective);
    const mcpReceipt = orgPolicyMcpReceiptState(ctx, effective);
    const kiroMcpReceipt = orgPolicyKiroMcpReceiptState(ctx, effective);
    if (!governanceOwnsAihSurfaces(policy)) {
      if (hookReceipt.state !== "absent" && hookReceipt.state !== "active") {
        return {
          name: "org policy effective resolution",
          verdict: "fail",
          code: "org-policy.effective-blocked",
          detail: hookReceipt.detail,
          location: { uri: ORG_POLICY_HOOK_RECEIPT_PATH },
          fingerprint: `org-policy-hook-receipt:${hookReceipt.state}`,
        };
      }
      if ((effective.upstreamArtifactLifecycle ?? []).length === 0) {
        return {
          name: "org policy effective resolution",
          verdict: "skip",
          detail: "no governed candidate inventory is active in this repo",
        };
      }
      return effective.blocking
        ? {
            name: "org policy effective resolution",
            verdict: "fail",
            code: "org-policy.effective-blocked",
            detail: withRequestedCandidateSummary(
              `organization-managed artifact lifecycle is blocked: ${blockedDetail(effective)}`,
              effective,
            ),
            location: { uri: ".aih/governance/upstream-artifact-lifecycle/v1" },
            fingerprint: "upstream-artifact-lifecycle-blocked",
          }
        : {
            name: "org policy effective resolution",
            verdict: "pass",
            detail: withRequestedCandidateSummary(
              "organization-managed artifact lifecycle is currently observed",
              effective,
            ),
          };
    }
    const requested = requestedCandidates(effective);
    if (hookReceipt.state !== "absent" && hookReceipt.state !== "active") {
      return {
        name: "org policy effective resolution",
        verdict: "fail",
        code: "org-policy.effective-blocked",
        detail: withRequestedCandidateSummary(hookReceipt.detail, effective),
        location: { uri: ORG_POLICY_HOOK_RECEIPT_PATH },
        fingerprint: `org-policy-hook-receipt:${hookReceipt.state}`,
      };
    }
    if (mcpReceipt.state !== "not-requested" && mcpReceipt.state !== "clean") {
      return {
        name: "org policy effective resolution",
        verdict: "fail",
        code: "org-policy.effective-blocked",
        detail: withRequestedCandidateSummary(
          `managed-MCP ownership is ${mcpReceipt.state}: ${mcpReceipt.detail}`,
          effective,
        ),
        location: { uri: ".claude/managed-settings.json" },
        fingerprint: `org-policy-mcp-receipt:${mcpReceipt.state}`,
      };
    }
    if (kiroMcpReceipt.state !== "not-requested" && kiroMcpReceipt.state !== "clean") {
      return {
        name: "org policy effective resolution",
        verdict: "fail",
        code: "org-policy.effective-blocked",
        detail: withRequestedCandidateSummary(
          `Kiro workspace-MCP ownership is ${kiroMcpReceipt.state}: ${kiroMcpReceipt.detail}`,
          effective,
        ),
        location: { uri: ".kiro/settings/mcp.json" },
        fingerprint: `org-policy-kiro-mcp-receipt:${kiroMcpReceipt.state}`,
      };
    }
    if (effective.blocking) {
      return {
        name: "org policy effective resolution",
        verdict: "fail",
        code: "org-policy.effective-blocked",
        detail: withRequestedCandidateSummary(
          `requested policy is blocked: ${blockedDetail(effective)}`,
          effective,
        ),
        location: { uri: "aih-org-policy.json" },
        fingerprint: "org-policy-effective-blocked",
      };
    }
    return {
      name: "org policy effective resolution",
      verdict: "pass",
      detail: withRequestedCandidateSummary(
        `${requested.length} requested candidate(s) effective through supported AIH projectors`,
        effective,
      ),
    };
  } catch (error) {
    return {
      name: "org policy effective resolution",
      verdict: "fail",
      code: "org-policy.effective-blocked",
      detail: `effective resolution failed closed: ${(error as Error).message}`,
      location: { uri: "aih-org-policy.json" },
      fingerprint: "org-policy-effective-resolution-error",
    };
  }
}

/** Deterministic export payload for CLI/report consumers and future Policy Studio downloads. */
export async function orgPolicyEffectiveDigest(
  ctx: PlanContext,
): Promise<DigestAction | undefined> {
  try {
    const policy = readOrgPolicy(ctx.root, ctx.env);
    if (policy === undefined) return undefined;
    const effective = (await resolveRuntimeOrgPolicy(ctx, policy)).effective;
    if (
      !governanceOwnsAihSurfaces(policy) &&
      (effective.upstreamArtifactLifecycle ?? []).length === 0
    )
      return undefined;
    const hookReceipt = orgPolicyHookReceiptState(ctx, effective);
    const mcpReceipt = orgPolicyMcpReceiptState(ctx, effective);
    const kiroMcpReceipt = orgPolicyKiroMcpReceiptState(ctx, effective);
    const hookRegistrar = hookRegistrarReport(ctx.root);
    const candidates = effective.candidates;
    const lifecycle = effective.npmPackageLifecycle ?? [];
    const upstreamLifecycle = effective.upstreamArtifactLifecycle ?? [];
    const body = lines(
      "Requested vs effective governed candidates. A requested item is never active merely because",
      "it appears below: evidence/authority, immutable identity, safety, target, ownership, and projector",
      "gates must all pass. GitHub approval references without separately verified proof remain blocked.",
      "",
      "| Candidate | Requested | Effective | Source / evidence | Approval | Target / projector coverage | Receipt / drift | Clarification / annotation | Blocking reason |",
      "|---|---:|---:|---|---|---|---|---|---|",
      ...candidates.map((candidate) => {
        const approval = candidate.approval;
        const sourceEvidence = `${candidate.sourceDigest}; ${stableJson(candidate.source)}; evidence=${candidate.evidenceRecord?.evidenceDigest ?? "unverified"}`;
        const authority =
          candidate.decision === undefined
            ? approval === undefined
              ? candidate.evidence
              : `${approval.issuer} @ ${approval.repository}; ${approval.attestationId}; ${approval.reason}; clarification=${approval.clarification}`
            : `${candidate.decision.id}; digest=${candidate.decision.digest}; issuer=${candidate.decision.issuer}; actor=${candidate.decision.actor}; disposition=${candidate.decision.disposition}; risk=${candidate.decision.riskState ?? "blocked"}; accepted=${candidate.decision.acceptedFindings.join(",") || "none"}; observed=${candidate.decision.observedFindings.join(",") || "none"}`;
        const requestedTargets = candidate.projection.requestedTargets;
        const targetProjector =
          candidate.kind === "mcp" && candidate.projection.projector === "mcp-managed-settings"
            ? requestedTargets
                .map((target) =>
                  target === "kiro"
                    ? "kiro / workspace MCP distribution"
                    : `${target} / mcp-managed-settings`,
                )
                .join(", ") || "none / mcp-managed-settings"
            : `${requestedTargets.join(",") || "none"} / ${candidate.projection.projector}`;
        // `supported` is per-candidate capability; `selected` is this INVOCATION's target
        // set, identical on every row. Rendering the latter as `available` beside the
        // former read as a per-candidate value, so an operator seeing `supported=claude;
        // available=claude,kiro` concluded the two were meant to intersect. The field name
        // now says which axis it is; the values are unchanged.
        const projection = `${targetProjector}; supported=${candidate.projection.supportedTargets.join(",") || "none"}; selected=${candidate.projection.availableTargets.join(",") || "none"} (this invocation); ${candidate.projection.coverage}`;
        const receipt =
          candidate.kind === "hook"
            ? `${hookReceipt.state}: ${hookReceipt.detail}`
            : candidate.kind === "mcp"
              ? `${candidate.projection.requestedTargets.includes("kiro") ? `${kiroMcpReceipt.state}: ${kiroMcpReceipt.detail}` : `${mcpReceipt.state}: ${mcpReceipt.detail}`}`
              : candidate.projection.receipt;
        const notes =
          [candidate.clarification, candidate.annotation].filter(Boolean).join(" / ") || "—";
        const codes =
          [
            ...candidate.dangerCodes,
            ...candidate.blockingCodes,
            ...candidate.decisionBlockers.map((blocker) => blocker.code),
          ].join(", ") || "—";
        const blocked =
          candidate.resolutionReasons.length === 0
            ? codes
            : `${codes}; resolution=${candidate.resolutionReasons.join(", ")}`;
        const revocation =
          candidate.revocation === undefined
            ? ""
            : `; revoked by ${candidate.revocation.issuer} at ${candidate.revocation.revokedAt}: ${candidate.revocation.reason}`;
        return `| ${candidate.id} | ${candidate.requested ? "yes" : "no"} | ${candidate.effective ? "yes" : "no"} | ${sourceEvidence} | ${authority} | ${projection} | ${receipt} | ${notes} | ${blocked}${revocation} |`;
      }),
      "",
      `Hook receipt: ${hookReceipt.state} — ${hookReceipt.detail}.`,
      `Managed-MCP receipt: ${mcpReceipt.state} — ${mcpReceipt.detail}.`,
      `Kiro workspace-MCP receipt: ${kiroMcpReceipt.state} — ${kiroMcpReceipt.detail}.`,
      `Hook registrar: ${hookRegistrar.state} — ${hookRegistrar.detail}.`,
      `Policy decision blockers: ${publicPolicyDecisionBlockers(effective)}.`,
      "",
      "Observed npm package lifecycle (read-only; never installed, configured, projected, or executed):",
      ...lifecycle.map(
        (item) =>
          `- ${item.subjectId ?? "store"}; target=${item.target ?? "none"}; state=${item.state}; reason=${item.reason}; decision=${item.decision?.id ?? "none"}; record=${item.recordDigest ?? "none"}`,
      ),
      ...(lifecycle.length === 0 ? ["- none"] : []),
      "",
      "Observed organization-managed artifact lifecycle (read-only; verifies files already placed by the organization and never installs, configures, projects, or executes them):",
      ...upstreamLifecycle.map(
        (item) =>
          `- ${item.subject?.kind ?? "artifact"}:${item.subject?.id ?? "store"}; target=${item.target ?? "none"}; effect=${item.effect ?? "none"}; state=${item.state}; reason=${item.reason}; decision=${item.decision?.id ?? "none"}; record=${item.recordDigest ?? "none"}`,
      ),
      ...(upstreamLifecycle.length === 0 ? ["- none"] : []),
      ...(hookRegistrar.unowned.length === 0
        ? []
        : [
            "",
            "Hook entries AIH did not emit (drift). AIH never absorbs one silently; adopt or remove each:",
            ...hookRegistrar.unowned.map(
              (entry: { owner: string; event: string; command: string }) =>
                `- owner=${entry.owner}; event=${entry.event}; command=${entry.command}`,
            ),
          ]),
      "",
      "External framework curation (report-only; never projected or enforced):",
      ...effective.externalCuration.flatMap((curation) =>
        curation.items.map(
          (item) =>
            `- ${curation.framework} ${item.kind}:${item.id}; source=${item.source.repository}@${item.source.commit}:${item.source.path}; audit=${item.audit.record}/${item.audit.digest}; clarification=${item.clarification ?? "—"}; status=${curation.status}`,
        ),
      ),
      ...(effective.externalCuration.length === 0 ? ["- none"] : []),
    );
    const result = digest(
      `Effective org policy — ${candidates.filter((candidate) => candidate.effective).length} effective · ${candidates.filter((candidate) => candidate.requested && !candidate.effective).length} blocked`,
      body,
      {
        policyVersion: effective.policyVersion,
        blocking: effective.blocking,
        decisionBlockers: effective.decisionBlockers,
        candidates: candidates.map((candidate) => ({
          ...candidate,
          ...(candidate.decision === undefined
            ? {}
            : { decision: publicDecisionView(candidate.decision) }),
        })),
        activeMcpServerIds: effective.activeMcpServerIds,
        frameworkSelections: effective.frameworkSelections,
        externalCuration: effective.externalCuration,
        npmPackageLifecycle: lifecycle,
        upstreamArtifactLifecycle: upstreamLifecycle,
        authority: effective.authority,
        hookReceipt,
        mcpReceipt,
        kiroMcpReceipt,
        hookRegistrar,
      },
    );
    effectiveDigestResolutions.set(result, {
      effective,
      receipts: {
        hook: hookReceipt,
        mcp: mcpReceipt,
        kiro: kiroMcpReceipt,
        registrar: hookRegistrar,
      },
    });
    return result;
  } catch (error) {
    return digest("Effective org policy — invalid", "Effective policy cannot be resolved safely.", {
      blocking: true,
      error: (error as Error).message,
    });
  }
}
