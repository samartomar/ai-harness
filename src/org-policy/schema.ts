import { join, resolve } from "node:path";
import { z } from "zod";
import { AihError } from "../errors.js";
import { readIfExists } from "../internals/fsxn.js";
import { AIH_ORG_POLICY_FILE } from "./constants.js";

const PostureSchema = z.enum(["vibe", "team", "enterprise"]);

const CommandRuleSchema = z.object({
  pattern: z.string().min(1),
  reason: z.string().optional(),
});

const CommandDeltaSchema = z
  .object({
    add: z.array(CommandRuleSchema).default([]),
    remove: z.array(z.string().min(1)).default([]),
  })
  .strict();

const RiskGateDeltaSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  pathPatterns: z.array(z.string()).default([]),
  commandPatterns: z.array(z.string()).default([]),
});

const RiskGateOverrideSchema = z
  .object({
    description: z.string().optional(),
    pathPatterns: z.array(z.string()).optional(),
    commandPatterns: z.array(z.string()).optional(),
  })
  .strict();

const LicenseDispositionSchema = z.enum(["auto-approve", "alert", "fail", "block"]);

const TrustApprovedSourceSchema = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    pinnedSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    reason: z.string().optional(),
  })
  .strict();

export const OrgPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    minimumPosture: PostureSchema,
    references: z.object({
      repoContract: z.string().min(1),
    }),
    command: z
      .object({
        deny: CommandDeltaSchema.optional(),
        ask: CommandDeltaSchema.optional(),
      })
      .strict()
      .optional(),
    riskGates: z
      .object({
        add: z.array(RiskGateDeltaSchema).default([]),
        override: z.record(z.string(), RiskGateOverrideSchema).default({}),
      })
      .strict()
      .optional(),
    licenses: z
      .object({
        disposition: z.record(z.string(), LicenseDispositionSchema).default({}),
      })
      .strict()
      .optional(),
    mcp: z
      .object({
        allowedServers: z.array(z.string().min(1)).default([]),
        allowManagedOnly: z.boolean().default(false),
      })
      .strict()
      .optional(),
    trust: z
      .object({
        approvedSources: z.array(TrustApprovedSourceSchema).optional(),
        requireSignedSource: z.boolean().default(false),
        // semgrep is future work: add names only when a detector adapter exists.
        requiredDetectors: z.array(z.enum(["skillspector", "cisco", "mcp-scanner"])).optional(),
        /**
         * Named checks `aih skill approve` must see satisfied in the vet evidence
         * before it approves: "license", "pin", "no-exec", "no-mcp", or a detector
         * name that must appear in the evidence's analyzersRun (e.g. "skillspector").
         * Absent → approve adds no extra constraints beyond the evidence chain.
         */
        requiredChecks: z.array(z.string().min(1)).optional(),
        internalScopes: z.array(z.string()).default([]),
      })
      .strict()
      .optional(),
  })
  .strict();

export type OrgPolicy = z.infer<typeof OrgPolicySchema>;

export class OrgPolicyError extends AihError {
  constructor(message: string) {
    super(message, "AIH_ORG_POLICY");
  }
}

export function parseOrgPolicy(value: unknown): OrgPolicy {
  try {
    return OrgPolicySchema.parse(value);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new OrgPolicyError(
        `org-policy is invalid: ${err.issues.map((i) => i.message).join("; ")}`,
      );
    }
    throw err;
  }
}

export function orgPolicyPath(root: string, env: NodeJS.ProcessEnv): string {
  if (env.AIH_ORG_POLICY && env.AIH_ORG_POLICY.trim().length > 0) {
    return resolve(root, env.AIH_ORG_POLICY.trim());
  }
  return join(root, AIH_ORG_POLICY_FILE);
}

export function readOrgPolicy(root: string, env: NodeJS.ProcessEnv): OrgPolicy | undefined {
  const path = orgPolicyPath(root, env);
  const raw = readIfExists(path);
  if (raw === undefined) return undefined;
  try {
    return parseOrgPolicy(JSON.parse(raw));
  } catch (err) {
    if (err instanceof OrgPolicyError) throw err;
    throw new OrgPolicyError(
      `aih-org-policy could not be read from ${path}: ${(err as Error).message}`,
    );
  }
}
