import { asPosture, type PolicyVerdict, type Posture } from "../config/posture.js";
import { lines } from "../internals/render.js";
import type { McpServer } from "./servers.js";

/**
 * MCP governance — the SAME catalog, two policies. This is the other half of the
 * "benefits the community AND survives enterprise friction" story: per-server risk
 * is made legible in `.mcp.json` (the axes on {@link McpServer}); this module turns
 * those axes into a posture-aware verdict a reviewer can sign off on.
 *
 *  - `vibe` / `team` — permissive: nothing is blocked; third-party egress (and an
 *                      unpinned supply chain) is WARNED so a reviewer still eyeballs it.
 *  - `enterprise` — restrictive: third-party egress and unpinned supply chains are
 *                   DENIED (self-host or pin instead); a token-bearing server is
 *                   allowed but WARNED (source the secret from env, never commit it).
 *
 * Both branches read the risk axes (egress / credentials / supplyChain) plus the
 * explicit org-policy approval set. aih REPORTS the verdicts; it never silently
 * drops a server from the written config.
 */
export { asPosture };
export type McpPosture = Posture;
export type { PolicyVerdict };

/** One server's verdict under a posture, with a human reason for the doc / probe detail. */
export interface ServerPolicy {
  name: string;
  verdict: PolicyVerdict;
  reason: string;
}

export interface McpApproval {
  server: string;
  acceptEgress: true;
  reason: string;
  reviewer?: string;
  approvedAt?: string;
}

export interface McpPolicyOptions {
  allowedServers?: readonly string[];
  approvals?: readonly McpApproval[];
  disabledServers?: readonly string[];
}

export function mcpPolicyOptionsFromConfig(
  mcp: McpPolicyOptions | undefined,
  opts: { includeEgressApprovals?: boolean } = {},
): McpPolicyOptions | undefined {
  if (mcp === undefined) return undefined;
  return {
    allowedServers: mcp.allowedServers,
    approvals: opts.includeEgressApprovals === false ? [] : mcp.approvals,
    disabledServers: mcp.disabledServers,
  };
}

function approvalFor(name: string, opts: McpPolicyOptions | undefined): McpApproval | undefined {
  if (!(opts?.allowedServers ?? []).includes(name)) return undefined;
  return opts?.approvals?.find((approval) => approval.server === name && approval.acceptEgress);
}

function approvedEgressReason(approval: McpApproval): string {
  const reviewer = approval.reviewer !== undefined ? `; reviewer: ${approval.reviewer}` : "";
  return `third-party egress accepted by org policy — ${approval.reason}${reviewer}`;
}

/** Evaluate one server against a posture — pure, reads only risk axes + approval data. */
function evaluateOne(
  name: string,
  s: McpServer,
  posture: McpPosture,
  opts: McpPolicyOptions | undefined,
): Omit<ServerPolicy, "name"> {
  if ((opts?.disabledServers ?? []).includes(name)) {
    return {
      verdict: "deny",
      reason: "disabled by org policy — remove it from generated/user MCP config",
    };
  }
  if (posture === "enterprise") {
    if (s.supplyChain === "unpinned") {
      return {
        verdict: "deny",
        reason:
          "unpinned supply chain — pin an exact version (or vendor an absolute command) for reproducible, reviewable installs",
      };
    }
    if (s.egress === "third-party") {
      const approval = approvalFor(name, opts);
      if (approval !== undefined) {
        return {
          verdict: "warn",
          reason: approvedEgressReason(approval),
        };
      }
      return {
        verdict: "deny",
        reason:
          "third-party egress — self-host the server or remove it; data must not leave for a non-incumbent vendor",
      };
    }
    if (s.credentials === "token") {
      return {
        verdict: "warn",
        reason: "requires a token — source it from the environment, never commit it to .mcp.json",
      };
    }
    return {
      verdict: "allow",
      reason: "local or vendor-incumbent egress, pinned/hosted, no plaintext secret",
    };
  }
  // vibe/team — permissive, but a reviewer still sees the egress surface.
  if (s.egress === "third-party") {
    return {
      verdict: "warn",
      reason:
        "third-party egress — your data leaves for a non-incumbent vendor; vet before relying on it",
    };
  }
  if (s.supplyChain === "unpinned") {
    return {
      verdict: "warn",
      reason: "unpinned supply chain — consider pinning a version for reproducibility",
    };
  }
  return { verdict: "allow", reason: "no egress concern" };
}

/** Evaluate every server against a posture (stable order = the input map's order). */
export function evaluateMcpPolicy(
  servers: Record<string, McpServer>,
  posture: McpPosture,
  opts?: McpPolicyOptions,
): ServerPolicy[] {
  return Object.entries(servers).map(([name, s]) => ({
    name,
    ...evaluateOne(name, s, posture, opts),
  }));
}

/** The denied subset — the "skipped-with-reason" list an enterprise rollout must resolve. */
export function deniedServers(policies: ServerPolicy[]): ServerPolicy[] {
  return policies.filter((p) => p.verdict === "deny");
}

/**
 * The governance doc: the verdict table grouped by outcome, with the denied set
 * called out first (the skipped-with-reason list) plus how to remediate. Emitted as
 * a `doc` action under the enterprise posture — guidance only, no file is mutated.
 */
export function mcpGovernanceDoc(
  policies: ServerPolicy[],
  posture: McpPosture,
  opts: { compliantApply?: boolean } = {},
): string {
  const denied = policies.filter((p) => p.verdict === "deny");
  const warned = policies.filter((p) => p.verdict === "warn");
  const allowed = policies.filter((p) => p.verdict === "allow");
  const withReason = (items: ServerPolicy[]): string[] =>
    items.length > 0 ? items.map((p) => `  - ${p.name} — ${p.reason}`) : ["  (none)"];
  const nameOnly = (items: ServerPolicy[]): string[] =>
    items.length > 0 ? items.map((p) => `  - ${p.name}`) : ["  (none)"];
  const governanceMode = opts.compliantApply
    ? "With --mcp-compliant, denied servers are omitted from generated MCP configs and listed here with reasons."
    : "aih REPORTS these verdicts; it does not silently drop servers from .mcp.json.";
  return lines(
    `MCP governance — ${posture} posture`,
    "===================================",
    "",
    "Same catalog, judged ONLY on each server's risk axes (egress / credentials /",
    "supply chain) plus explicit org-policy approvals — the auditable line item a reviewer signs off on.",
    governanceMode,
    "",
    `Denied (${denied.length}) — remediate or remove before an enterprise rollout:`,
    ...withReason(denied),
    "",
    `Warn (${warned.length}) — allowed, but review:`,
    ...withReason(warned),
    "",
    `Allowed (${allowed.length}):`,
    ...nameOnly(allowed),
    "",
    "Remediation: a denied THIRD-PARTY server can usually be self-hosted (run the",
    "vendor's container behind your perimeter and point its URL there) or dropped to",
    "the CLI / vendor-docs fallback; an UNPINNED server just needs an exact version",
    "pin. Keep .mcp.json under CODEOWNERS so this set cannot change without review.",
  );
}
