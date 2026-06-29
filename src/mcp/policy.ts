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
 * Both branches read ONLY the risk axes (egress / credentials / supplyChain), so the
 * one engine drives community defaults, the enterprise gate (the `aih mcp` policy
 * probe + governance doc), and — later — the report. aih REPORTS the verdicts; it
 * never silently drops a server from the written config.
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

/** Evaluate one server against a posture — pure, reads only the risk axes. */
function evaluateOne(s: McpServer, posture: McpPosture): Omit<ServerPolicy, "name"> {
  if (posture === "enterprise") {
    if (s.egress === "third-party") {
      return {
        verdict: "deny",
        reason:
          "third-party egress — self-host the server or remove it; data must not leave for a non-incumbent vendor",
      };
    }
    if (s.supplyChain === "unpinned") {
      return {
        verdict: "deny",
        reason:
          "unpinned supply chain — pin an exact version (or vendor an absolute command) for reproducible, reviewable installs",
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
): ServerPolicy[] {
  return Object.entries(servers).map(([name, s]) => ({ name, ...evaluateOne(s, posture) }));
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
export function mcpGovernanceDoc(policies: ServerPolicy[], posture: McpPosture): string {
  const denied = policies.filter((p) => p.verdict === "deny");
  const warned = policies.filter((p) => p.verdict === "warn");
  const allowed = policies.filter((p) => p.verdict === "allow");
  const withReason = (items: ServerPolicy[]): string[] =>
    items.length > 0 ? items.map((p) => `  - ${p.name} — ${p.reason}`) : ["  (none)"];
  const nameOnly = (items: ServerPolicy[]): string[] =>
    items.length > 0 ? items.map((p) => `  - ${p.name}`) : ["  (none)"];
  return lines(
    `MCP governance — ${posture} posture`,
    "===================================",
    "",
    "Same catalog, judged ONLY on each server's risk axes (egress / credentials /",
    "supply chain) — the auditable line item a reviewer signs off on. aih REPORTS",
    "these verdicts; it does not silently drop servers from .mcp.json.",
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
