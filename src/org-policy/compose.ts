import {
  COMMAND_LEXICON,
  type CommandRule,
  type PolicyTier,
} from "../guardrails/command-policy.js";
import { RISK_GATES, type RiskGate } from "../guardrails/risk-gates.js";
import { LICENSE_MATRIX, type LicenseTier } from "../guardrails/sca.js";
import type { OrgPolicy } from "./schema.js";

export interface ComposedOrgPolicy {
  minimumPosture: OrgPolicy["minimumPosture"];
  references: OrgPolicy["references"];
  command: Record<PolicyTier, CommandRule[]>;
  riskGates: RiskGate[];
  licenses: LicenseTier[];
  mcp: {
    allowedServers: string[];
    allowManagedOnly: boolean;
    disabledServers: string[];
  };
}

function cloneRules(rules: readonly CommandRule[]): CommandRule[] {
  return rules.map((rule) => ({ ...rule }));
}

function applyCommandDelta(
  base: readonly CommandRule[],
  delta: { add?: CommandRule[]; remove?: string[] } | undefined,
): CommandRule[] {
  const remove = new Set(delta?.remove ?? []);
  const kept = base.filter((rule) => !remove.has(rule.pattern)).map((rule) => ({ ...rule }));
  const seen = new Set(kept.map((rule) => rule.pattern));
  for (const rule of delta?.add ?? []) {
    if (seen.has(rule.pattern)) continue;
    kept.push({ ...rule });
    seen.add(rule.pattern);
  }
  return kept;
}

function composeCommand(policy: OrgPolicy): Record<PolicyTier, CommandRule[]> {
  return {
    deny: applyCommandDelta(COMMAND_LEXICON.deny, policy.command?.deny),
    ask: applyCommandDelta(COMMAND_LEXICON.ask, policy.command?.ask),
    safe_read_only: cloneRules(COMMAND_LEXICON.safe_read_only),
    safe_verification: cloneRules(COMMAND_LEXICON.safe_verification),
  };
}

function composeRiskGates(policy: OrgPolicy): RiskGate[] {
  const byName = new Map<string, RiskGate>(
    RISK_GATES.map((gate) => [gate.name, { ...gate, behavior: "ask" as const }]),
  );
  for (const [name, delta] of Object.entries(policy.riskGates?.override ?? {})) {
    const existing = byName.get(name);
    if (existing === undefined) continue;
    byName.set(name, { ...existing, ...delta, behavior: "ask" });
  }
  for (const gate of policy.riskGates?.add ?? []) {
    byName.set(gate.name, { ...gate, behavior: "ask" });
  }
  return [...byName.values()];
}

function composeLicenses(policy: OrgPolicy): LicenseTier[] {
  const overrides = policy.licenses?.disposition ?? {};
  return LICENSE_MATRIX.map((tier) => ({
    ...tier,
    disposition:
      tier.disposition === "block" ? "block" : (overrides[tier.category] ?? tier.disposition),
  }));
}

export function composeOrgPolicy(policy: OrgPolicy): ComposedOrgPolicy {
  return {
    minimumPosture: policy.minimumPosture,
    references: policy.references,
    command: composeCommand(policy),
    riskGates: composeRiskGates(policy),
    licenses: composeLicenses(policy),
    mcp: {
      allowedServers: [...(policy.mcp?.allowedServers ?? [])],
      allowManagedOnly: policy.mcp?.allowManagedOnly ?? false,
      disabledServers: [...(policy.mcp?.disabledServers ?? [])],
    },
  };
}
