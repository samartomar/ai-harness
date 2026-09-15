import { GOVERNED_MCP_TARGETS } from "../internals/cli-registry.js";
import { stableJson } from "./policy-identity.js";

interface McpControlIdentity {
  id: string;
  kind: string;
  source: { type: string };
  targets: readonly string[];
  projector: string;
  lifecycle: string;
}

/** The exact target inventory shipped before native governed MCP expansion. */
export const LEGACY_GOVERNED_MCP_TARGETS_V1 = ["claude", "kiro"] as const;

/** Only this known inventory transition has a historical identity variant. */
export function hasExpandedMcpControlTargetsV1(control: {
  kind: string;
  source: { type: string };
  targets: readonly string[];
  projector: string;
  lifecycle: string;
}): boolean {
  return (
    control.kind === "mcp" &&
    control.source.type === "mcp" &&
    control.projector === "mcp-managed-settings" &&
    control.lifecycle === "supported" &&
    control.targets.length === GOVERNED_MCP_TARGETS.length &&
    GOVERNED_MCP_TARGETS.every((target) => control.targets.includes(target))
  );
}

/** Every action-significant field must match the known historical declaration. */
export function isExactLegacyMcpControlV1(
  candidate: McpControlIdentity,
  current: McpControlIdentity,
): boolean {
  return (
    hasExpandedMcpControlTargetsV1(current) &&
    candidate.id === current.id &&
    candidate.kind === current.kind &&
    stableJson(candidate.source) === stableJson(current.source) &&
    candidate.projector === current.projector &&
    candidate.lifecycle === current.lifecycle &&
    candidate.targets.length === LEGACY_GOVERNED_MCP_TARGETS_V1.length &&
    LEGACY_GOVERNED_MCP_TARGETS_V1.every((target) => candidate.targets.includes(target))
  );
}
