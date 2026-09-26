import type { PlanContext } from "../internals/plan.js";
import {
  defaultNativeMcpServers,
  verifiedRootAwareLauncherSubjectV1,
} from "../mcp/default-native-runtime.js";
import { mcpApprovalSubject } from "../mcp/policy.js";
import { isRootAwareLauncherId } from "../mcp/root-aware-launcher-identity.js";
import { type McpServer, mcpServers } from "../mcp/servers.js";
import { scanRepo } from "../profile/scan.js";
import { type PolicyAuthorityVerification, verifyPolicyAuthorityReceipt } from "./authority.js";
import { aihPolicyControls } from "./catalog.js";
import type { AihPolicyControl } from "./catalog-provider-types.js";
import {
  type EffectiveOrgPolicy,
  type RuntimeMcpIdentity,
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
 * The MCP servers Core would project for this project: the shared catalog with
 * the root-aware authenticated native launchers in place of the portable ones.
 */
export function runtimeMcpCatalog(ctx: PlanContext): Record<string, McpServer> {
  return mcpServers("project", scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir }), {
    localRuntimeServers: defaultNativeMcpServers(ctx),
  });
}

/**
 * The subject the runtime reports for a server. A root-aware launcher id reports its
 * portable launcher identity only when the entry verifies as Core's own launcher, and no
 * subject otherwise; every other server keeps its approval subject.
 */
export function runtimeMcpSubject(id: string, server: McpServer): string | undefined {
  return isRootAwareLauncherId(id)
    ? verifiedRootAwareLauncherSubjectV1(id, server)
    : mcpApprovalSubject(server);
}

/** The identities the runtime check (`runtime-mcp-identity-mismatch`) compares selections with. */
export function runtimeMcpIdentities(
  catalog: Record<string, McpServer>,
): Record<string, RuntimeMcpIdentity> {
  return Object.fromEntries(
    Object.entries(catalog).flatMap(([name, server]) => {
      const subject = runtimeMcpSubject(name, server);
      return subject === undefined
        ? []
        : [
            [
              name,
              {
                subject,
                projectable: server.type === "stdio",
                kiroProjectable: server.type === "stdio",
              },
            ],
          ];
    }),
  );
}

/** The AIH reviewed controls the runtime matches selections with, under the runtime subjects. */
export function runtimeAihPolicyControls(catalog: Record<string, McpServer>): AihPolicyControl[] {
  return aihPolicyControls(catalog, runtimeMcpSubject);
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
  const catalog = runtimeMcpCatalog(ctx);
  const governance = governanceOwnsAihSurfaces(evaluatedPolicy)
    ? evaluatedPolicy.governance
    : undefined;
  const policyCandidates = [
    ...(governance?.catalog.reviewed ?? []),
    ...(governance?.catalog.custom ?? []),
  ];
  const aihReviewedControls: Record<string, RuntimeReviewedControl> = Object.fromEntries(
    runtimeAihPolicyControls(catalog).map((control) => [
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
    mcpIdentities: runtimeMcpIdentities(catalog),
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
