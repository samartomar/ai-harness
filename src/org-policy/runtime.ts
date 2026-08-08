import type { PlanContext } from "../internals/plan.js";
import { mcpApprovalSubject } from "../mcp/policy.js";
import { type McpServer, mcpServers } from "../mcp/servers.js";
import { scanRepo } from "../profile/scan.js";
import { verifyPolicyAuthorityReceipt } from "./authority.js";
import { aihPolicyControls } from "./catalog.js";
import {
  type EffectiveOrgPolicy,
  type RuntimeReviewedControl,
  resolveEffectiveOrgPolicy,
  reviewedControlDigest,
} from "./effective.js";
import { governanceOwnsAihSurfaces, type OrgPolicy } from "./schema.js";

export interface RuntimeOrgPolicyResolution {
  catalog: Record<string, McpServer>;
  effective: EffectiveOrgPolicy;
  authorityProblem?: string;
}

/**
 * Resolve once against the real invocation target set and the externally
 * verified authority receipt. Projection, report, doctor, and evaluation all
 * call this function rather than accepting policy-authored proof objects.
 */
export async function resolveRuntimeOrgPolicy(
  ctx: PlanContext,
  policy: OrgPolicy,
): Promise<RuntimeOrgPolicyResolution> {
  const catalog = mcpServers(
    "project",
    scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir }),
  );
  const governance = governanceOwnsAihSurfaces(policy) ? policy.governance : undefined;
  const policyCandidates = [
    ...(governance?.catalog.reviewed ?? []),
    ...(governance?.catalog.custom ?? []),
  ];
  const aihReviewedControls: Record<string, RuntimeReviewedControl> = Object.fromEntries(
    aihPolicyControls(catalog).map((control) => [
      control.id,
      { control, controlDigest: reviewedControlDigest(control) },
    ]),
  );
  const usageControl = aihReviewedControls["usage-metering"]?.control;
  if (usageControl?.source.type !== "hook") {
    throw new Error("AIH policy catalog is missing the usage-metering hook control");
  }
  const verification = await verifyPolicyAuthorityReceipt(ctx);
  const effective = resolveEffectiveOrgPolicy(policy, {
    authority: verification.authority,
    targets: ctx.targets ?? ["claude"],
    projectorsEnabled: (ctx.posture ?? policy.minimumPosture) !== "vibe",
    aihReviewedControls,
    mcpIdentities: Object.fromEntries(
      Object.entries(catalog).map(([name, server]) => [
        name,
        { subject: mcpApprovalSubject(server), projectable: server.type === "stdio" },
      ]),
    ),
    hookIdentities: {
      "usage-metering": { scriptDigest: usageControl.source.scriptDigest, projectable: true },
    },
    projectorFindings: Object.fromEntries(
      policyCandidates
        .filter((candidate) => candidate.kind === "mcp" && candidate.source.type === "stdio")
        .filter((candidate) => catalog[candidate.id] !== undefined)
        .map((candidate) => [candidate.id, ["normalized-collision"] as const]),
    ),
  });
  if (verification.problem !== undefined) effective.authority.problem = verification.problem;
  return {
    catalog,
    effective,
    ...(verification.problem === undefined ? {} : { authorityProblem: verification.problem }),
  };
}
