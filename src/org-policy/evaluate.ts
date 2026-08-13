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
} from "./project.js";
import { resolveRuntimeOrgPolicy } from "./runtime.js";
import { governanceOwnsAihSurfaces, readOrgPolicy } from "./schema.js";

function requestedCandidates(effective: EffectiveOrgPolicy) {
  return effective.candidates.filter((candidate) => candidate.requested);
}

function blockedDetail(effective: EffectiveOrgPolicy): string {
  const blocked = requestedCandidates(effective).filter((candidate) => !candidate.effective);
  return blocked
    .map((candidate) => {
      const codes = [...candidate.dangerCodes, ...candidate.blockingCodes];
      const reasons = candidate.resolutionReasons;
      return `${candidate.id}: ${codes.length === 0 ? "not-effective" : codes.join(", ")}${
        reasons.length === 0 ? "" : `; resolution=${reasons.join(", ")}`
      }`;
    })
    .join("; ");
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
      return {
        name: "org policy effective resolution",
        verdict: "skip",
        detail: "no governed candidate inventory is active in this repo",
      };
    }
    const requested = requestedCandidates(effective);
    if (effective.blocking) {
      return {
        name: "org policy effective resolution",
        verdict: "fail",
        code: "org-policy.effective-blocked",
        detail: `requested policy is blocked: ${blockedDetail(effective)}`,
        location: { uri: "aih-org-policy.json" },
        fingerprint: "org-policy-effective-blocked",
      };
    }
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
    if (mcpReceipt.state !== "not-requested" && mcpReceipt.state !== "clean") {
      return {
        name: "org policy effective resolution",
        verdict: "fail",
        code: "org-policy.effective-blocked",
        detail: `managed-MCP ownership is ${mcpReceipt.state}: ${mcpReceipt.detail}`,
        location: { uri: ".claude/managed-settings.json" },
        fingerprint: `org-policy-mcp-receipt:${mcpReceipt.state}`,
      };
    }
    if (kiroMcpReceipt.state !== "not-requested" && kiroMcpReceipt.state !== "clean") {
      return {
        name: "org policy effective resolution",
        verdict: "fail",
        code: "org-policy.effective-blocked",
        detail: `Kiro workspace-MCP ownership is ${kiroMcpReceipt.state}: ${kiroMcpReceipt.detail}`,
        location: { uri: ".kiro/settings/mcp.json" },
        fingerprint: `org-policy-kiro-mcp-receipt:${kiroMcpReceipt.state}`,
      };
    }
    return {
      name: "org policy effective resolution",
      verdict: "pass",
      detail: `${requested.length} requested candidate(s) effective through supported AIH projectors`,
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
    if (!governanceOwnsAihSurfaces(policy)) return undefined;
    const effective = (await resolveRuntimeOrgPolicy(ctx, policy)).effective;
    const hookReceipt = orgPolicyHookReceiptState(ctx, effective);
    const mcpReceipt = orgPolicyMcpReceiptState(ctx, effective);
    const kiroMcpReceipt = orgPolicyKiroMcpReceiptState(ctx, effective);
    const hookRegistrar = hookRegistrarReport(ctx.root);
    const candidates = effective.candidates;
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
          approval === undefined
            ? candidate.evidence
            : `${approval.issuer} @ ${approval.repository}; ${approval.attestationId}; ${approval.reason}; clarification=${approval.clarification}`;
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
        const projection = `${targetProjector}; supported=${candidate.projection.supportedTargets.join(",") || "none"}; available=${candidate.projection.availableTargets.join(",") || "none"}; ${candidate.projection.coverage}`;
        const receipt =
          candidate.kind === "hook"
            ? `${hookReceipt.state}: ${hookReceipt.detail}`
            : candidate.kind === "mcp"
              ? `${candidate.projection.requestedTargets.includes("kiro") ? `${kiroMcpReceipt.state}: ${kiroMcpReceipt.detail}` : `${mcpReceipt.state}: ${mcpReceipt.detail}`}`
              : candidate.projection.receipt;
        const notes =
          [candidate.clarification, candidate.annotation].filter(Boolean).join(" / ") || "—";
        const codes = [...candidate.dangerCodes, ...candidate.blockingCodes].join(", ") || "—";
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
    return digest(
      `Effective org policy — ${candidates.filter((candidate) => candidate.effective).length} effective · ${candidates.filter((candidate) => candidate.requested && !candidate.effective).length} blocked`,
      body,
      {
        policyVersion: effective.policyVersion,
        blocking: effective.blocking,
        candidates,
        activeMcpServerIds: effective.activeMcpServerIds,
        frameworkSelections: effective.frameworkSelections,
        externalCuration: effective.externalCuration,
        authority: effective.authority,
        hookReceipt,
        mcpReceipt,
        kiroMcpReceipt,
        hookRegistrar,
      },
    );
  } catch (error) {
    return digest("Effective org policy — invalid", "Effective policy cannot be resolved safely.", {
      blocking: true,
      error: (error as Error).message,
    });
  }
}
