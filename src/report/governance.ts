import { gradeVerdict, type PolicyVerdict, type Posture } from "../config/posture.js";
import { COMMAND_LEXICON } from "../guardrails/command-policy.js";
import { RISK_GATES } from "../guardrails/risk-gates.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { scanConfigSecrets, scanSecrets } from "../secrets/scan.js";
import { contractSnapshot } from "./contract.js";
import { mcpGovernanceSummary } from "./mcp-governance.js";

interface GovernanceRow {
  control: string;
  verdict: PolicyVerdict;
  detail: string;
  count?: number;
}

const TRUST_ENV_KEYS = [
  "NODE_EXTRA_CA_CERTS",
  "PIP_CERT",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CARGO_HTTP_CAINFO",
  "GIT_SSL_CAINFO",
  "JAVA_TOOL_OPTIONS",
  "SSL_CERT_DIR",
] as const;

function postureOf(ctx: PlanContext): Posture {
  return ctx.posture ?? "vibe";
}

function verdictCounts(rows: readonly GovernanceRow[]): Record<PolicyVerdict, number> {
  return rows.reduce<Record<PolicyVerdict, number>>(
    (acc, row) => {
      acc[row.verdict] += 1;
      return acc;
    },
    { allow: 0, warn: 0, deny: 0 },
  );
}

function secretsRow(ctx: PlanContext, posture: Posture): GovernanceRow {
  const plaintext = scanSecrets(ctx.root).matches.length;
  const mcpHardcoded = scanConfigSecrets(ctx.root).length;
  const total = plaintext + mcpHardcoded;
  return {
    control: "secrets",
    verdict: total > 0 ? gradeVerdict("warn", "secrets", posture) : "allow",
    detail:
      total > 0
        ? `${total} finding(s): ${plaintext} plaintext path(s), ${mcpHardcoded} hardcoded MCP secret(s)`
        : "no plaintext secret paths or hardcoded MCP config secrets found",
    count: total,
  };
}

function pathPortabilityRow(ctx: PlanContext, posture: Posture): GovernanceRow | undefined {
  const contract = contractSnapshot(ctx);
  if (contract === undefined) return undefined;
  return {
    control: "path-portability",
    verdict: contract.unportable > 0 ? gradeVerdict("warn", "path-portability", posture) : "allow",
    detail:
      contract.unportable > 0
        ? `${contract.unportable} non-portable contract path(s)`
        : "committed repo contract paths are portable",
    count: contract.unportable,
  };
}

function commandPolicyRow(posture: Posture): GovernanceRow {
  const deny = COMMAND_LEXICON.deny.length;
  const ask = COMMAND_LEXICON.ask.length;
  return {
    control: "command-policy",
    verdict: gradeVerdict("warn", "command-policy", posture),
    detail: `${deny} deny pattern(s), ${ask} ask pattern(s); ${
      posture === "vibe"
        ? "advisory-only"
        : posture === "team"
          ? "project managed-settings/CI sidecar"
          : "required CI + enterprise managed-settings"
    }`,
    count: deny + ask,
  };
}

function riskGatesRow(posture: Posture): GovernanceRow {
  return {
    control: "risk-gates",
    verdict: gradeVerdict("warn", "risk-gates", posture),
    detail: `${RISK_GATES.length} ask-not-deny gate(s); behavior remains ask`,
    count: RISK_GATES.length,
  };
}

function mcpRow(ctx: PlanContext, posture: Posture): GovernanceRow {
  const summary = mcpGovernanceSummary(ctx, posture);
  return {
    control: "mcp",
    verdict: summary.counts.denied > 0 ? "deny" : summary.counts.warned > 0 ? "warn" : "allow",
    detail: `${summary.counts.allowed} allowed, ${summary.counts.warned} warn, ${summary.counts.denied} denied under ${summary.posture}`,
    count: summary.counts.allowed + summary.counts.warned + summary.counts.denied,
  };
}

function caTrustRow(ctx: PlanContext, posture: Posture): GovernanceRow {
  const configured = TRUST_ENV_KEYS.filter((key) => trustEnvConfigured(key, ctx.env[key]));
  return {
    control: "ca-trust",
    verdict: configured.length > 0 ? "allow" : gradeVerdict("warn", "ca-trust", posture),
    detail:
      configured.length > 0
        ? `trust env present: ${configured.join(", ")}`
        : "no CA trust env vars in this process; run `aih certs --apply` on managed workstations",
    count: configured.length,
  };
}

function trustEnvConfigured(key: (typeof TRUST_ENV_KEYS)[number], raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim();
  if (value.length === 0) return false;
  if (key === "JAVA_TOOL_OPTIONS") {
    return value.includes("-Djavax.net.ssl.trustStore=");
  }
  return true;
}

function governanceRows(ctx: PlanContext): GovernanceRow[] {
  const posture = postureOf(ctx);
  const rows: Array<GovernanceRow | undefined> = [
    secretsRow(ctx, posture),
    pathPortabilityRow(ctx, posture),
    commandPolicyRow(posture),
    riskGatesRow(posture),
    mcpRow(ctx, posture),
    caTrustRow(ctx, posture),
  ];
  return rows.filter((row): row is GovernanceRow => row !== undefined);
}

export function governanceRollupDigest(ctx: PlanContext): DigestAction {
  const posture = postureOf(ctx);
  const rows = governanceRows(ctx);
  const counts = verdictCounts(rows);
  const body = lines(
    `Active posture: ${posture}${ctx.postureSource ? ` (${ctx.postureSource})` : ""}`,
    "",
    "| Control | Verdict | Signal |",
    "|---|---|---|",
    ...rows.map((row) => `| ${row.control} | ${row.verdict.toUpperCase()} | ${row.detail} |`),
  );
  return digest(
    `Governance roll-up — ${counts.deny} deny · ${counts.warn} warn · ${counts.allow} allow (${posture} posture)`,
    body,
    {
      posture,
      postureSource: ctx.postureSource,
      counts,
      controls: rows,
    },
  );
}
