import { createHash } from "node:crypto";
import type { PlanContext } from "../internals/plan.js";
import { mcpApprovalSubject } from "../mcp/policy.js";
import { type McpServer, mcpServers } from "../mcp/servers.js";
import { scanRepo } from "../profile/scan.js";
import { usageRecorderScript } from "../usage/capture.js";
import { verifyPolicyAuthorityReceipt } from "./authority.js";
import {
  type EffectiveOrgPolicy,
  type RuntimeReviewedControl,
  resolveEffectiveOrgPolicy,
  reviewedControlDigest,
} from "./effective.js";
import type { OrgPolicy } from "./schema.js";

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
  const policyCandidates = [
    ...(policy.governance?.catalog.reviewed ?? []),
    ...(policy.governance?.catalog.custom ?? []),
  ];
  const usageRecorderDigest = `sha256:${createHash("sha256")
    .update(usageRecorderScript(), "utf8")
    .digest("hex")}`;
  const aihReviewedControls: Record<string, RuntimeReviewedControl> = {};
  for (const [server, value] of Object.entries(catalog)) {
    const control = {
      id: server,
      kind: "mcp" as const,
      source: { type: "mcp" as const, server, subject: mcpApprovalSubject(value) },
      targets: ["claude"] as ("claude" | "codex")[],
      projector: "mcp-managed-settings" as const,
      lifecycle: "supported" as const,
    };
    aihReviewedControls[server] = { control, controlDigest: reviewedControlDigest(control) };
  }
  const usageHookControl = {
    id: "usage-metering",
    kind: "hook" as const,
    source: {
      type: "hook" as const,
      handler: "usage-metering" as const,
      scriptDigest: usageRecorderDigest,
    },
    targets: ["claude", "codex"] as ("claude" | "codex")[],
    projector: "usage-hook" as const,
    lifecycle: "supported" as const,
  };
  aihReviewedControls[usageHookControl.id] = {
    control: usageHookControl,
    controlDigest: reviewedControlDigest(usageHookControl),
  };
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
    hookIdentities: { "usage-metering": { scriptDigest: usageRecorderDigest, projectable: true } },
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
