import { ECC_MCP_CATALOG_PROVENANCE, eccExternalMcpCatalog } from "./ecc-mcp-catalog.js";

/**
 * Portable, deliberately conservative email grammar for a human policy approver.
 * New Workbench-authored approvals use email; legacy stable identifiers remain
 * readable so an existing protected policy does not become invalid on upgrade.
 */
export const POLICY_APPROVER_EMAIL_PATTERN =
  "^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$";

const POLICY_APPROVER_EMAIL_REGEX = new RegExp(POLICY_APPROVER_EMAIL_PATTERN);

/** Exact external IDs from the pinned ECC snapshot, excluding AIH-owned MCPs. */
export const ECC_EXTERNAL_MCP_APPROVAL_IDS = [
  "nexus",
  "ito-compute",
  "jira",
  "firecrawl",
  "supabase",
  "ecc-memory-vault",
  "memory",
  "omega-memory",
  "longhand",
  "vercel",
  "railway",
  "cloudflare-docs",
  "cloudflare-workers-builds",
  "cloudflare-workers-bindings",
  "cloudflare-observability",
  "clickhouse",
  "exa-web-search",
  "parallel-search",
  "codescene",
  "magic",
  "memxus",
  "filesystem",
  "fal-ai",
  "browserbase",
  "browser-use",
  "devfleet",
  "token-optimizer",
  "laraplugins",
  "confluence",
  "evalview",
  "squish",
] as const;

export type EccExternalMcpApprovalId = (typeof ECC_EXTERNAL_MCP_APPROVAL_IDS)[number];

export interface EccMcpApprovalRecord {
  id: EccExternalMcpApprovalId;
  sourceContentSha256: string;
  state: "approved" | "revoked";
  approvedBy: string;
  authenticationMode: string;
  allowedDataClasses: readonly string[];
}

export type EccMcpApprovalResolution =
  | { state: "approved"; approval: EccMcpApprovalRecord }
  | { state: "revoked"; approval: EccMcpApprovalRecord }
  | { state: "source-mismatch" }
  | { state: "unapproved" };

const EXTERNAL_IDS = new Set<string>(ECC_EXTERNAL_MCP_APPROVAL_IDS);
const RECORD_KEYS = [
  "allowedDataClasses",
  "approvedBy",
  "authenticationMode",
  "id",
  "sourceContentSha256",
  "state",
] as const;

function fail(message: string): never {
  throw new Error(`invalid ECC MCP approval inventory: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStableId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function isApproverIdentity(value: unknown): value is string {
  return (
    isStableId(value) ||
    (typeof value === "string" &&
      value.length <= 254 &&
      value === value.trim() &&
      POLICY_APPROVER_EMAIL_REGEX.test(value))
  );
}

function isSafePolicyText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 500 &&
    value === value.trim() &&
    /\S/u.test(value) &&
    !/\p{C}/u.test(value)
  );
}

function isExactApprovalRecord(value: unknown): value is EccMcpApprovalRecord {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== RECORD_KEYS.length || keys.some((key, index) => key !== RECORD_KEYS[index])) {
    return false;
  }
  return (
    isStableId(value.id) &&
    EXTERNAL_IDS.has(value.id) &&
    typeof value.sourceContentSha256 === "string" &&
    (value.state === "approved" || value.state === "revoked") &&
    isApproverIdentity(value.approvedBy) &&
    isSafePolicyText(value.authenticationMode) &&
    Array.isArray(value.allowedDataClasses) &&
    value.allowedDataClasses.length > 0 &&
    value.allowedDataClasses.length <= 20 &&
    value.allowedDataClasses.every(isStableId)
  );
}

/**
 * Resolves only an administrator's declaration over the exact pinned source.
 * It deliberately returns no launcher, configuration, projection, scan, or
 * endpoint/tool-surface fact; a future explicit Add flow must do that separately.
 */
export function resolveEccMcpApproval(
  approvals: readonly unknown[],
  id: string,
): EccMcpApprovalResolution {
  if (!EXTERNAL_IDS.has(id)) return { state: "source-mismatch" };
  const matching = approvals.filter((approval) => isRecord(approval) && approval.id === id);
  if (matching.length === 0) return { state: "unapproved" };
  if (matching.length !== 1 || !isExactApprovalRecord(matching[0])) {
    return { state: "source-mismatch" };
  }
  const approval = matching[0];
  if (approval.sourceContentSha256 !== ECC_MCP_CATALOG_PROVENANCE.contentSha256) {
    return { state: "source-mismatch" };
  }
  return approval.state === "approved"
    ? { state: "approved", approval }
    : { state: "revoked", approval };
}

const expected = eccExternalMcpCatalog.map((entry) => entry.id);
if (
  expected.length !== ECC_EXTERNAL_MCP_APPROVAL_IDS.length ||
  expected.some((id, index) => id !== ECC_EXTERNAL_MCP_APPROVAL_IDS[index])
) {
  fail("approval ids do not match the pinned external catalog");
}
