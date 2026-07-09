import { join, resolve } from "node:path";
import { z } from "zod";
import { AihError } from "../errors.js";
import { readIfExists } from "../internals/fsxn.js";
import { AIH_ORG_POLICY_FILE } from "./constants.js";

const PostureSchema = z.enum(["vibe", "team", "enterprise"]);

const CommandRuleSchema = z
  .object({
    pattern: z.string().min(1),
    reason: z.string().optional(),
  })
  .strict();

const CommandDeltaSchema = z
  .object({
    add: z.array(CommandRuleSchema).default([]),
    remove: z.array(z.string().min(1)).default([]),
  })
  .strict();

const RiskGateDeltaSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    pathPatterns: z.array(z.string()).default([]),
    commandPatterns: z.array(z.string()).default([]),
  })
  .strict();

const RiskGateOverrideSchema = z
  .object({
    description: z.string().optional(),
    pathPatterns: z.array(z.string()).optional(),
    commandPatterns: z.array(z.string()).optional(),
  })
  .strict();

const LicenseDispositionSchema = z.enum(["auto-approve", "alert", "fail", "block"]);

const HOST_WITH_OPTIONAL_PORT =
  "[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::(?:[0-9]|[1-9][0-9]{1,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?";
const HOSTNAME_PATTERN = new RegExp(`^${HOST_WITH_OPTIONAL_PORT}$`);
const HTTPS_ORIGIN_PATTERN = new RegExp(`^https://${HOST_WITH_OPTIONAL_PORT}$`);
const HTTPS_ORIGIN_MESSAGE = "must be an https origin such as https://github.example.com";

export function normalizePolicyHost(value: string, source = "host"): string {
  try {
    if (value !== value.trim() || !HOSTNAME_PATTERN.test(value)) {
      throw new Error("invalid host");
    }
    return new URL(`https://${value}`).host.toLowerCase();
  } catch {
    throw new Error(`${source} must be a hostname, optionally with a port`);
  }
}

export function normalizeHttpsOrigin(value: string, source = "value"): string {
  try {
    if (value !== value.trim() || !HTTPS_ORIGIN_PATTERN.test(value)) {
      throw new Error("invalid origin");
    }
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid origin");
    }
    return url.origin;
  } catch {
    throw new Error(`${source} ${HTTPS_ORIGIN_MESSAGE}`);
  }
}

const HostnameSchema = z
  .string()
  .regex(HOSTNAME_PATTERN, "host must be a hostname, optionally with a port")
  .transform((value) => normalizePolicyHost(value));

const HttpsOriginSchema = z
  .string()
  .regex(HTTPS_ORIGIN_PATTERN, HTTPS_ORIGIN_MESSAGE)
  .transform((value, ctx) => {
    try {
      return normalizeHttpsOrigin(value);
    } catch {
      ctx.addIssue({ code: "custom", message: HTTPS_ORIGIN_MESSAGE });
      return z.NEVER;
    }
  });

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

const SINGLE_LINE_POLICY_TEXT_PATTERN = "^(?=.*\\S)[^\\u0000-\\u001F\\u007F]+$";
const SingleLinePolicyTextPattern = new RegExp(SINGLE_LINE_POLICY_TEXT_PATTERN);

const SingleLinePolicyTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(SingleLinePolicyTextPattern, "must be a single line with visible text");

const ImageDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "imageDigest must be sha256:<64 lowercase hex chars>");

const SkillSpectorDigestApprovalSchema = z
  .object({
    imageTag: SingleLinePolicyTextSchema,
    imageDigest: ImageDigestSchema,
    sourceRevision: z
      .string()
      .regex(/^[0-9a-f]{40}$/, "sourceRevision must be a lowercase 40-character Git SHA"),
    reason: SingleLinePolicyTextSchema,
    reviewer: SingleLinePolicyTextSchema.optional(),
    approvedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T/, "approvedAt must be an ISO-8601 timestamp"),
  })
  .strict();

const McpApprovalSchema = z
  .object({
    server: SingleLinePolicyTextSchema,
    subject: SingleLinePolicyTextSchema.optional(),
    acceptEgress: z.literal(true),
    reason: SingleLinePolicyTextSchema,
    reviewer: SingleLinePolicyTextSchema.optional(),
    approvedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T/, "approvedAt must be an ISO-8601 timestamp"),
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
        approvals: z.array(McpApprovalSchema).default([]),
        allowManagedOnly: z.boolean().default(false),
        incumbentHosts: z.array(HostnameSchema).default([]),
        githubHost: HttpsOriginSchema.optional(),
        disabledServers: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .optional(),
    trust: z
      .object({
        approvedSources: z.array(TrustApprovedSourceSchema).optional(),
        requireSignedSource: z.boolean().default(false),
        requiredDetectors: z
          .array(
            z.enum([
              "skillspector",
              "cisco",
              "mcp-scanner",
              "semgrep",
              "snyk-agent-scan",
              "agentshield",
            ]),
          )
          .optional(),
        /**
         * Named checks `aih skill approve` must see satisfied in the vet evidence
         * before it approves: "license", "pin", "no-exec", "no-mcp", or a detector
         * name that must appear in the evidence's analyzersRun (e.g. "skillspector").
         * Absent → approve adds no extra constraints beyond the evidence chain.
         */
        requiredChecks: z.array(z.string().min(1)).optional(),
        internalScopes: z.array(z.string()).default([]),
        skillspector: z
          .object({
            approvedDigests: z.array(SkillSpectorDigestApprovalSchema).default([]),
          })
          .strict()
          .optional(),
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

function modulePolicyFormatMessage(path: string, raw: string): string | undefined {
  const trimmed = raw.trimStart();
  if (
    trimmed.startsWith("export default") ||
    trimmed.startsWith("export const") ||
    trimmed.startsWith("module.exports") ||
    trimmed.startsWith("exports.")
  ) {
    return (
      `aih-org-policy could not be read from ${path}: org-policy sources are JSON-only. ` +
      `JavaScript/module policy files are not executed; write ${AIH_ORG_POLICY_FILE} or point ` +
      `AIH_ORG_POLICY at a JSON policy file.`
    );
  }
  return undefined;
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
    const moduleMessage = modulePolicyFormatMessage(path, raw);
    if (moduleMessage !== undefined) throw new OrgPolicyError(moduleMessage);
    throw new OrgPolicyError(
      `aih-org-policy could not be read from ${path}: ${(err as Error).message}`,
    );
  }
}
