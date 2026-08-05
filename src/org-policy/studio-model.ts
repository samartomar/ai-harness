import { z } from "zod";
import { policyAuthoringCatalog } from "./catalog.js";
import { UNWAIVABLE_POLICY_DANGER_CODES } from "./effective.js";
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
    schemaVersion: 1,
    minimumPosture: "team",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "1",
      catalog: { reviewed: [], custom: [] },
      activations: [],
      authority: { approvals: [] },
      externalCuration: [],
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

export interface PolicyStudioModel {
  initialPolicy: OrgPolicy;
  catalog: ReturnType<typeof policyAuthoringCatalog>;
  schema: Record<string, unknown>;
  unwaivable: readonly string[];
  semantics: {
    httpsOriginArgumentPrefixes: readonly string[];
    httpsOriginPattern: string;
  };
}

/** Serializable payload embedded in every portable workbench artifact. */
export function policyStudioModel(): PolicyStudioModel {
  return {
    initialPolicy: defaultStudioPolicy(),
    catalog: policyAuthoringCatalog(),
    schema: z.toJSONSchema(OrgPolicySchema, { io: "input" }) as Record<string, unknown>,
    unwaivable: UNWAIVABLE_POLICY_DANGER_CODES,
    semantics: {
      httpsOriginArgumentPrefixes: HTTPS_ORIGIN_ARGUMENT_PREFIXES,
      httpsOriginPattern: POLICY_HTTPS_ORIGIN_PATTERN,
    },
  };
}
