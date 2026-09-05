import type { PlanContext } from "../internals/plan.js";
import { mcpApprovalSubject } from "../mcp/policy.js";
import { type McpServer, mcpServers } from "../mcp/servers.js";
import { scanRepo } from "../profile/scan.js";
import { type PolicyAuthorityVerification, verifyPolicyAuthorityReceipt } from "./authority.js";
import { aihPolicyControls } from "./catalog.js";
import {
  type EffectiveOrgPolicy,
  type RuntimeReviewedControl,
  resolveEffectiveOrgPolicy,
  reviewedControlDigest,
} from "./effective.js";
import { resolveNpmPackageEffectiveStateWithAuthorityV1 } from "./npm-package-effective-state-v1.js";
import { governanceOwnsAihSurfaces, type OrgPolicy } from "./schema.js";
import { resolveUpstreamArtifactEffectiveStateWithAuthorityV1 } from "./upstream-artifact-effective-state-v1.js";
import { consumeWorkbenchPolicy } from "./workbench/policy-consumption.js";

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
  authorityVerification?: PolicyAuthorityVerification,
): Promise<RuntimeOrgPolicyResolution> {
  const authoringSelections = policy.schemaVersion === 3 ? policy.authoringSelections : undefined;
  if (policy.schemaVersion === 3 && authoringSelections === undefined)
    throw new Error(
      "refusing invalid Workbench authoring selection: selection envelope is missing",
    );
  const consumed =
    authoringSelections === undefined
      ? undefined
      : consumeWorkbenchPolicy(
          policy as Record<string, unknown>,
          authoringSelections as Parameters<typeof consumeWorkbenchPolicy>[1],
        );
  if (consumed !== undefined && (!consumed.accepted || consumed.policy === undefined))
    throw new Error(
      `refusing invalid Workbench authoring selection: ${(consumed.diagnostics ?? []).join("; ")}`,
    );
  const evaluatedPolicy = consumed?.policy ?? policy;
  const catalog = mcpServers(
    "project",
    scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir }),
  );
  const governance = governanceOwnsAihSurfaces(evaluatedPolicy)
    ? evaluatedPolicy.governance
    : undefined;
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
  const verification = authorityVerification ?? (await verifyPolicyAuthorityReceipt(ctx));
  const npmPackageLifecycle = governanceOwnsAihSurfaces(evaluatedPolicy)
    ? resolveNpmPackageEffectiveStateWithAuthorityV1(ctx.root, verification)
    : [];
  const upstreamArtifactLifecycle = await resolveUpstreamArtifactEffectiveStateWithAuthorityV1(
    ctx,
    verification,
  );
  const projectorsDisabledAtVibe = (ctx.posture ?? evaluatedPolicy.minimumPosture) === "vibe";
  const effective = resolveEffectiveOrgPolicy(evaluatedPolicy, {
    authority: verification.authority,
    targets: ctx.targets ?? ["claude"],
    projectorsEnabled: !projectorsDisabledAtVibe,
    ...(projectorsDisabledAtVibe ? { projectorDisabledReason: "vibe-posture" as const } : {}),
    aihReviewedControls,
    mcpIdentities: Object.fromEntries(
      Object.entries(catalog).map(([name, server]) => [
        name,
        {
          subject: mcpApprovalSubject(server),
          projectable: server.type === "stdio",
          kiroProjectable: server.type === "stdio",
        },
      ]),
    ),
    hookIdentities: {
      "usage-metering": { scriptDigest: usageControl.source.scriptDigest, projectable: true },
    },
    npmPackageLifecycle,
    upstreamArtifactLifecycle,
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
