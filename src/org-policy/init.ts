import { join, posix } from "node:path";
import {
  type CapabilitySurface,
  collectCapabilitySurfaces,
  surfaceSummary,
} from "../baseline/attestation.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import { readIfExists } from "../internals/fsxn.js";
import {
  type CommandSpec,
  digest,
  type Plan,
  type PlanContext,
  plan,
  probe,
  writeJson,
} from "../internals/plan.js";
import { AIH_ORG_POLICY_FILE } from "./constants.js";
import { OrgPolicyError, parseOrgPolicy } from "./schema.js";
import { localPolicyCheck } from "./validate.js";

/**
 * `aih policy init` — seed a starter `aih-org-policy.json` from OBSERVED fleet
 * state, so authoring the policy becomes a review exercise instead of a blank
 * page (issue #503). Without it, enterprise baseline attestation demands a
 * declared registry while `aih policy` offers no way to create one — and aih
 * fails its own attestation for MCP servers it generated (the first-setup
 * chicken-and-egg loop).
 *
 * The starter declares exactly what the attestation lens observes
 * ({@link collectCapabilitySurfaces} — the same collection
 * `enterpriseBaselineAttestationCheck` grades), which is what makes a fresh
 * setup pass attestation with no hand-editing. Fail-closed boundaries:
 *
 * - only CATALOG-BOUND MCP surfaces (aih's own generated shapes) are declared;
 *   anything attestation force-undeclares (stale workspace-graph residue, a
 *   non-catalog server) is listed for review, never silently declared;
 * - marketplace surfaces are NEVER auto-trusted: `trust.approvedSources`
 *   grants acquisition trust well beyond registry membership, so seeding it
 *   from mere observation would widen a trust gate — they are listed for
 *   explicit review instead;
 * - an existing policy is never overwritten (plan-time refusal AND an
 *   apply-time `{ absent: true }` pin), and an active `AIH_ORG_POLICY`
 *   override refuses outright — the starter only ever targets the committed
 *   default policy file, mirroring `aih mcp approve`;
 * - declaring `mcp.allowedServers` records registry membership only; reviewed
 *   third-party egress approval remains the `aih mcp approve` ceremony.
 */

function declarableServerNames(surfaces: readonly CapabilitySurface[]): string[] {
  const names = surfaces
    .filter((surface) => surface.kind === "mcp" && surface.forceUndeclared !== true)
    .map((surface) => surface.id);
  return [...new Set(names)].sort();
}

function starterDigestText(
  allowedServers: readonly string[],
  undeclarable: readonly CapabilitySurface[],
  marketplace: readonly CapabilitySurface[],
): string {
  const lines: string[] = [
    `Starter org policy seeded from observed fleet state — review it, then commit ${AIH_ORG_POLICY_FILE}:`,
    "",
    allowedServers.length > 0
      ? `- mcp.allowedServers declares ${allowedServers.length} catalog-bound MCP server(s): ${allowedServers.join(", ")}`
      : "- no catalog-bound MCP servers observed; mcp.allowedServers starts empty",
  ];
  if (undeclarable.length > 0) {
    lines.push(
      `- ${undeclarable.length} observed MCP surface(s) cannot be auto-declared (not aih catalog-bound, or stale generated residue) — review and remove, or bring under the catalog:`,
      ...undeclarable.map((surface) => `    ${surfaceSummary(surface)}`),
    );
  }
  if (marketplace.length > 0) {
    lines.push(
      `- ${marketplace.length} marketplace surface(s) observed but NOT auto-trusted — add pinned trust.approvedSources entries only after review:`,
      ...marketplace.map((surface) => `    ${surfaceSummary(surface)}`),
    );
  }
  lines.push(
    "",
    "Declaring a server in mcp.allowedServers records baseline-attestation registry membership only;",
    "reviewed third-party egress approval remains `aih mcp approve <server> --accept-egress`.",
  );
  return lines.join("\n");
}

function policyInitPlan(ctx: PlanContext): Plan {
  // The starter only ever targets the committed default policy file. An active
  // AIH_ORG_POLICY override makes "the policy" ambiguous, so refuse outright
  // (fail closed) — the same boundary `aih mcp approve` draws.
  const override = ctx.env.AIH_ORG_POLICY?.trim();
  if (override !== undefined && override.length > 0) {
    throw new OrgPolicyError(
      "AIH_ORG_POLICY is active; org policy wins over a local starter, so policy init refuses — " +
        `unset the override (or update that managed policy) before seeding ${AIH_ORG_POLICY_FILE}`,
    );
  }
  if (readIfExists(join(ctx.root, AIH_ORG_POLICY_FILE)) !== undefined) {
    throw new OrgPolicyError(
      `${AIH_ORG_POLICY_FILE} already exists in the target root; policy init never overwrites an ` +
        "existing policy — edit it under review, or record per-server approvals with `aih mcp approve`",
    );
  }
  const collected = collectCapabilitySurfaces(ctx);
  if (collected.error !== undefined) {
    throw new OrgPolicyError(
      `observed fleet state cannot be read to seed the starter policy: ${
        collected.error.detail ?? collected.error.name
      }`,
    );
  }
  const allowedServers = declarableServerNames(collected.surfaces);
  const undeclarable = collected.surfaces.filter(
    (surface) => surface.kind === "mcp" && surface.forceUndeclared === true,
  );
  const marketplace = collected.surfaces.filter((surface) => surface.kind === "marketplace");
  const minimumPosture = ctx.posture ?? "vibe";
  const starter = {
    schemaVersion: 2,
    minimumPosture,
    references: { repoContract: posix.join(ctx.contextDir, "project.json") },
    mcp: { allowedServers },
    ...(minimumPosture === "enterprise"
      ? {
          governance: { supportedClis: [...SUPPORTED_CLIS] },
        }
      : {}),
  };
  // The starter must be valid by construction — parse it through the same
  // schema `policy validate` enforces before ever planning the write.
  parseOrgPolicy(starter);
  return plan(
    "policy init",
    {
      ...writeJson(
        AIH_ORG_POLICY_FILE,
        starter,
        `starter org policy seeded from ${allowedServers.length} observed catalog-bound MCP server(s)`,
      ),
      // Never clobber a policy that appears between plan and apply: `once`
      // preserves an existing file, and the absent pin fails the write loudly.
      once: true,
      expect: { absent: true },
    },
    digest(
      "Org policy starter — observed capability surfaces",
      starterDigestText(allowedServers, undeclarable, marketplace),
      {
        allowedServers,
        undeclarable: undeclarable.map(surfaceSummary),
        marketplace: marketplace.map(surfaceSummary),
      },
    ),
    probe("org policy schema", (c) => localPolicyCheck(c)),
  );
}

export const policyInitCommand: CommandSpec = {
  name: "init",
  summary:
    "Seed a starter aih-org-policy.json from observed MCP surfaces so attestation becomes a review exercise",
  // Plannable in a repo whose policy is absent (the whole point) or malformed —
  // init's own refusal names the real issue instead of a pre-plan posture error.
  skipOrgPolicyFloor: true,
  plan: policyInitPlan,
};
