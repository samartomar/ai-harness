import { z } from "zod";
import type { AdminCatalogProvenanceV1 } from "./admin-catalog-operations-v1.js";
import { policyAuthoringCatalog } from "./catalog.js";
import {
  DISPOSITIONABLE_POLICY_FINDING_CODES,
  FENCED_POLICY_PREREQUISITE_CODES,
  UNWAIVABLE_POLICY_DANGER_CODES,
} from "./effective.js";
import {
  canonicalGovernanceDecisionV1,
  type GovernanceDecisionV1,
  GovernanceDecisionV1Schema,
  parseGovernanceDecisionV1,
} from "./governance-decision-v1.js";
import {
  HTTPS_ORIGIN_ARGUMENT_PREFIXES,
  type OrgPolicy,
  OrgPolicySchema,
  POLICY_HTTPS_ORIGIN_PATTERN,
  parseOrgPolicy,
} from "./schema.js";

/** Valid, no-repository starting point for the generated Policy Workbench. */
export function defaultStudioPolicy(): OrgPolicy {
  return parseOrgPolicy({
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "1",
      catalog: { reviewed: [], custom: [] },
      activations: [],
      authority: { approvals: [] },
      externalCuration: [],
      externalSelections: [],
    },
  });
}

/**
 * The generator's import/export boundary. It uses the product Zod grammar,
 * rejects unknown fields, and emits only the parsed policy shape — no Studio
 * DTO or lossy adapter exists between a policy and its download.
 */
export function parseStudioPolicyImport(text: string): OrgPolicy {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Policy import is not valid JSON");
  }
  return parseOrgPolicy(value);
}

export function exportStudioPolicy(policy: unknown): string {
  return `${JSON.stringify(parseOrgPolicy(policy), null, 2)}\n`;
}

/** Strict, standalone decision transport for the Workbench's inert inspection surface. */
export function parseStudioDecisionImport(text: string): GovernanceDecisionV1 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Decision import is not valid JSON");
  }
  return parseGovernanceDecisionV1(value);
}

/** Canonical decision bytes are a transport identity only; this function verifies no authority. */
export function exportStudioDecision(decision: unknown): string {
  return `${canonicalGovernanceDecisionV1(parseGovernanceDecisionV1(decision))}\n`;
}

export interface PolicyStudioModel {
  initialPolicy: OrgPolicy;
  catalog: ReturnType<typeof policyAuthoringCatalog>;
  /**
   * Verified supported-catalog provenance when the administrator route resolved
   * one, else absent. The visible provenance line renders tier, source,
   * channel, resolved time, age, and bootstrap provenance; this closed embedded
   * model also carries its safe sequence, digests, posture, member count, and
   * verification time — never a locator, path, token, signature, raw
   * attestation, signer identity, root digest, or machine detail.
   */
  catalogProvenance?: AdminCatalogProvenanceV1;
  schema: Record<string, unknown>;
  decisionSchema: Record<string, unknown>;
  unwaivable: readonly string[];
  /**
   * The two halves of the finding model. `unwaivable` stays as their union so
   * existing consumers keep working, but a surface that tells an administrator
   * what it may act on must read these, not that.
   */
  findings: {
    dispositionable: readonly string[];
    fenced: readonly string[];
  };
  semantics: {
    httpsOriginArgumentPrefixes: readonly string[];
    httpsOriginPattern: string;
  };
}

/** Serializable payload embedded in every portable workbench artifact. */
export function policyStudioModel(catalogProvenance?: AdminCatalogProvenanceV1): PolicyStudioModel {
  return {
    initialPolicy: defaultStudioPolicy(),
    catalog: policyAuthoringCatalog(),
    ...(catalogProvenance === undefined ? {} : { catalogProvenance }),
    schema: z.toJSONSchema(OrgPolicySchema, { io: "input" }) as Record<string, unknown>,
    decisionSchema: z.toJSONSchema(GovernanceDecisionV1Schema, { io: "input" }) as Record<
      string,
      unknown
    >,
    unwaivable: UNWAIVABLE_POLICY_DANGER_CODES,
    findings: {
      dispositionable: DISPOSITIONABLE_POLICY_FINDING_CODES,
      fenced: FENCED_POLICY_PREREQUISITE_CODES,
    },
    semantics: {
      httpsOriginArgumentPrefixes: HTTPS_ORIGIN_ARGUMENT_PREFIXES,
      httpsOriginPattern: POLICY_HTTPS_ORIGIN_PATTERN,
    },
  };
}
