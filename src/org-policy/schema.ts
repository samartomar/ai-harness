import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AihError } from "../errors.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import { readIfExists } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import { STRIX_INVOCATION_LIMITS } from "../security/detectors/types.js";
import { AIH_ORG_POLICY_FILE } from "./constants.js";
import {
  canonicalEccDisabledHookIds,
  ECC_DISABLE_ELIGIBLE_HOOK_IDS,
  type EccHookProfile,
} from "./ecc-hook-controls.js";
import { ECC_EXTERNAL_MCP_APPROVAL_IDS } from "./ecc-mcp-approval.js";
import { ECC_MCP_CATALOG_PROVENANCE } from "./ecc-mcp-catalog.js";

const PostureSchema = z.enum(["vibe", "enterprise"]);

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
export const POLICY_HTTPS_ORIGIN_PATTERN = `^https://${HOST_WITH_OPTIONAL_PORT}$`;
const HTTPS_ORIGIN_PATTERN = new RegExp(POLICY_HTTPS_ORIGIN_PATTERN);
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

/**
 * AIH hard ceilings for the declarative Strix security policy. These are not
 * claimed as upstream Strix limits: this repository has no upstream owner
 * ceiling yet, so the conservative bounds keep a future headless scan bounded
 * until an execution consumer owns tighter per-mode budgets.
 */
export const STRIX_POLICY_LIMITS = STRIX_INVOCATION_LIMITS;

const StrixSecurityPolicyBaseSchema = z
  .object({
    targetKind: z.literal("local-fixture"),
    mode: z.enum(["quick", "standard", "deep"]),
    maxBudgetCents: z.number().int().min(1).max(STRIX_POLICY_LIMITS.maxBudgetCents),
    maxTurns: z.number().int().min(1).max(STRIX_POLICY_LIMITS.maxTurns),
    timeoutMs: z.number().int().min(1).max(STRIX_POLICY_LIMITS.timeoutMs),
    telemetry: z.literal("off"),
    imageDigest: ImageDigestSchema,
    allowLiveTargets: z.literal(false).default(false),
    allowMounts: z.literal(false).default(false),
  })
  .strict();

export const StrixSecurityPolicySchema = z.discriminatedUnion("enabled", [
  StrixSecurityPolicyBaseSchema.extend({
    enabled: z.literal(true),
    required: z.boolean(),
  }),
  StrixSecurityPolicyBaseSchema.extend({
    enabled: z.literal(false),
    required: z.literal(false),
  }),
]);

const SecurityPolicySchema = z
  .object({
    strix: StrixSecurityPolicySchema,
  })
  .strict();

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

const BaselineOverrideBundleSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("./") &&
      !value.includes("\\") &&
      !value.includes("//") &&
      value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    "bundle must be a safe repo-relative POSIX path",
  );

const BaselineOverrideSchema = z
  .object({
    catalog: z.enum(["ecc", "superpowers"]),
    owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    pinnedSha: z.string().regex(/^[0-9a-f]{40}$/),
    bundle: BaselineOverrideBundleSchema,
    signingRepository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    reason: SingleLinePolicyTextSchema,
    reviewer: SingleLinePolicyTextSchema,
    approvedAt: z.string().refine((value) => {
      if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
      return Number.isFinite(Date.parse(value));
    }, "approvedAt must be an ISO-8601 timestamp"),
  })
  .strict();

/**
 * Headless Policy Studio contract. These fields are intentionally stricter than
 * the legacy policy controls: they name immutable candidates that a later UI
 * can author, while the resolver decides whether any requested activation is
 * actually effective. Configuration alone is never an activation grant.
 */
const SafePolicyTextSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value === value.trim(), "must not have leading or trailing whitespace")
  .refine(
    (value) => /\S/u.test(value) && !/\p{C}/u.test(value),
    "must be visible single-line text without control or hidden Unicode characters",
  );

const SafePolicyIdentifierSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, "must be a lowercase stable identifier");

const EccHookProfileSchema = z.enum(["minimal", "standard", "strict"]);
const EccHookControlsSchema = z
  .object({
    profile: EccHookProfileSchema,
    disabledIds: z
      .array(z.enum([...ECC_DISABLE_ELIGIBLE_HOOK_IDS] as [string, ...string[]]))
      .max(40)
      .optional(),
  })
  .strict()
  .transform((value, ctx) => {
    let disabledIds: string[];
    try {
      disabledIds = canonicalEccDisabledHookIds(
        value.disabledIds ?? [],
        value.profile as EccHookProfile,
      );
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["disabledIds"],
        message: error instanceof Error ? error.message : "invalid ECC disabled hook ids",
      });
      return z.NEVER;
    }
    return {
      profile: value.profile,
      ...(disabledIds.length === 0 ? {} : { disabledIds }),
    };
  });
export const SupportedCliSchema = z.enum(SUPPORTED_CLIS);
const SupportedCliListSchema = z
  .array(SupportedCliSchema)
  .min(1)
  .max(SUPPORTED_CLIS.length)
  .superRefine((clis, ctx) => {
    const duplicate = clis.find((cli, index) => clis.indexOf(cli) !== index);
    if (duplicate !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `supported CLI ${duplicate} appears more than once`,
      });
    }
  });
const PolicyTargetSchema = z.enum(["claude", "codex"]);

export function enterpriseSupportedClisJsonSchemaConstraint(): Record<string, unknown> {
  // JSON Schema conditional keyword; computed so this helper result is not a thenable.
  const conditionalThen = "then";
  return {
    if: {
      properties: { minimumPosture: { const: "enterprise" } },
      required: ["minimumPosture"],
    },
    [conditionalThen]: {
      required: ["governance"],
      properties: { governance: { required: ["supportedClis"] } },
    },
  };
}

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be a sha256 digest");
const GitRepositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be an owner/repository identity");
const GitCommitSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a lowercase immutable Git commit or tree digest");
const ExactPackageVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/,
    "must be an exact package version",
  );
const SafeCommandTokenSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._@:+-]*$/,
    "must be a safe command token without paths or shell syntax",
  );
/** Command arguments that are only safe when they carry an exact HTTPS origin. */
export const HTTPS_ORIGIN_ARGUMENT_PREFIXES = ["--registry=", "--index-url="] as const;

export function safePolicyCommandArgument(value: string): boolean {
  const prefix = HTTPS_ORIGIN_ARGUMENT_PREFIXES.find((candidate) => value.startsWith(candidate));
  if (prefix !== undefined) {
    try {
      normalizeHttpsOrigin(value.slice(prefix.length), "registry argument");
      return true;
    } catch {
      return false;
    }
  }
  return (
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !value.includes("..") &&
    !/[\\/;|&`$<>\p{C}]/u.test(value)
  );
}
const SafeCommandArgumentSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    safePolicyCommandArgument,
    "must be a safe relative argument without shell syntax, paths, or hidden Unicode characters",
  );
const IsoTimestampSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}, "must be an ISO-8601 timestamp");

const RemoteMcpApprovalSchema = z
  .object({
    approvedBy: SafePolicyIdentifierSchema,
    authenticationMode: SafePolicyTextSchema,
    allowedDataClasses: z.array(SafePolicyIdentifierSchema).min(1).max(20),
  })
  .strict();

/**
 * An administrator's declaration over an external ECC MCP from the exact
 * source-locked snapshot. It is neither a client configuration nor a grant to
 * contact, scan, inspect, project, or install that MCP.
 */
const EccMcpApprovalSchema = z
  .object({
    id: z.enum(ECC_EXTERNAL_MCP_APPROVAL_IDS),
    sourceContentSha256: z.literal(ECC_MCP_CATALOG_PROVENANCE.contentSha256),
    state: z.enum(["approved", "revoked"]),
    approvedBy: SafePolicyIdentifierSchema,
    authenticationMode: SafePolicyTextSchema,
    allowedDataClasses: z.array(SafePolicyIdentifierSchema).min(1).max(20),
  })
  .strict();

const RemoteMcpSourceFields = {
  type: z.literal("remote"),
  origin: HttpsOriginSchema,
  approval: RemoteMcpApprovalSchema,
  contentScanned: z.literal(false),
};

const RemoteMcpSourceSchema = z.union([
  z
    .object({
      ...RemoteMcpSourceFields,
      /**
       * An administrator-controlled availability record. It makes no claim
       * that AIH has contacted the endpoint or observed its tool surface.
       */
      administrativeStatus: z.enum(["approved", "revoked"]),
    })
    .strict(),
  z
    .object({
      ...RemoteMcpSourceFields,
      /** Legacy snapshot metadata; retained for schema-v2 document compatibility. */
      toolSurfaceDigest: Sha256Schema,
      /** Legacy snapshot metadata; `drifted` never becomes an AIH live check. */
      verdict: z.enum(["approved", "drifted", "revoked"]),
    })
    .strict(),
]);

export const CandidateSourceSchema = z.union([
  z
    .object({
      type: z.literal("git"),
      repository: GitRepositorySchema,
      commit: GitCommitSchema,
      tree: GitCommitSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("package"),
      registry: HttpsOriginSchema,
      package: z.string().regex(/^@?[A-Za-z0-9][A-Za-z0-9._/-]*$/, "must be a package identity"),
      version: ExactPackageVersionSchema,
      integrity: Sha256Schema,
    })
    .strict(),
  z
    .object({
      type: z.literal("command"),
      command: SafeCommandTokenSchema,
      args: z.array(SafeCommandArgumentSchema).default([]),
      executableDigest: Sha256Schema,
    })
    .strict(),
  z
    .object({
      type: z.literal("stdio"),
      /** The resolver is an identity selector, never an arbitrary executable. */
      resolver: z.enum(["npx", "uvx"]),
      registry: HttpsOriginSchema,
      package: z.string().regex(/^@?[A-Za-z0-9][A-Za-z0-9._/-]*$/, "must be a package identity"),
      version: ExactPackageVersionSchema,
      integrity: Sha256Schema,
    })
    .strict(),
  RemoteMcpSourceSchema,
  z
    .object({
      type: z.literal("mcp"),
      server: SafePolicyIdentifierSchema,
      subject: z
        .string()
        .regex(/^mcp-server-sha256:[0-9a-f]{64}$/, "must be an MCP server identity digest"),
    })
    .strict(),
  z
    .object({
      type: z.literal("hook"),
      handler: z.literal("usage-metering"),
      scriptDigest: Sha256Schema,
    })
    .strict(),
]);

const CandidateEvidenceSchema = z
  .object({
    /** Locator only: state and detector results come from the verified receipt. */
    record: SafePolicyIdentifierSchema,
  })
  .strict();

export const PolicyDangerCodeSchema = z.enum([
  "malicious-code",
  "prompt-injection",
  "auto-executing-hook",
  "hidden-unicode",
  "secrets",
  "unpinned-source",
  "dependency-confusion",
  "mandatory-detector-failed",
  "evidence-identity-drift",
  "unsafe-path",
  "normalized-collision",
  "missing-projector",
  "unsupported-target",
  "ownership-conflict",
]);

const PolicyCandidateSchema = z
  .object({
    id: SafePolicyIdentifierSchema,
    kind: z.enum(["mcp", "hook", "framework"]),
    description: SafePolicyTextSchema,
    capabilities: z.array(SafePolicyTextSchema).max(20).default([]),
    risks: z.array(SafePolicyTextSchema).max(20).default([]),
    source: CandidateSourceSchema,
    targets: z.array(PolicyTargetSchema).min(1).max(2),
    projector: z.enum([
      "mcp-managed-settings",
      "hook-managed-settings",
      "usage-hook",
      "framework-contract",
    ]),
    lifecycle: z.enum(["supported", "deprecated", "retired"]),
    evidence: CandidateEvidenceSchema,
    findings: z.array(PolicyDangerCodeSchema).default([]),
    autoExecute: z.boolean().default(false),
    framework: z.enum(["ecc", "superpowers"]).optional(),
    clarification: SafePolicyTextSchema.optional(),
    annotation: SafePolicyTextSchema.optional(),
  })
  .strict()
  .superRefine((candidate, ctx) => {
    if (
      candidate.kind === "mcp" &&
      candidate.source.type !== "mcp" &&
      candidate.source.type !== "stdio" &&
      candidate.source.type !== "remote"
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "MCP candidates must use an exact catalog, fully pinned stdio package, or fenced remote endpoint identity",
      });
    }
    if (
      candidate.kind === "mcp" &&
      candidate.source.type === "mcp" &&
      candidate.id !== candidate.source.server
    ) {
      ctx.addIssue({
        code: "custom",
        message: "built-in MCP candidate id must exactly match source.server",
      });
    }
    if (candidate.kind === "mcp" && candidate.targets.some((target) => target !== "claude")) {
      ctx.addIssue({
        code: "custom",
        message: "MCP managed-settings candidates support Claude targets only",
      });
    }
    if (candidate.kind === "hook" && candidate.source.type !== "hook") {
      ctx.addIssue({
        code: "custom",
        message: "hook candidates must use an AIH-owned hook identity",
      });
    }
    if (
      candidate.kind === "hook" &&
      candidate.source.type === "hook" &&
      candidate.id !== candidate.source.handler
    ) {
      ctx.addIssue({
        code: "custom",
        message: "AIH-owned hook candidate id must exactly match source.handler",
      });
    }
    if (candidate.kind === "framework" && candidate.framework === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "framework candidates must name ecc or superpowers",
      });
    }
    if (candidate.kind !== "framework" && candidate.framework !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "framework is only valid on framework candidates",
      });
    }
    if (
      candidate.kind === "framework" &&
      (candidate.projector !== "framework-contract" ||
        candidate.autoExecute ||
        candidate.targets.length !== 1 ||
        candidate.targets[0] !== "claude")
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "framework intents are Claude-only, non-autoexecuting framework-contract records until a binding lifecycle exists",
      });
    }
  });

const PolicyActivationSchema = z
  .object({
    candidate: SafePolicyIdentifierSchema,
    state: z.enum(["active", "disabled"]),
    targets: z.array(PolicyTargetSchema).min(1).max(2),
    clarification: SafePolicyTextSchema.optional(),
  })
  .strict();

export const PolicyApprovalSchema = z
  .object({
    id: SafePolicyIdentifierSchema,
    candidate: SafePolicyIdentifierSchema,
    kind: z.enum(["mcp", "hook", "framework"]),
    /** Exact immutable source, not only a mutable display label or package name. */
    source: CandidateSourceSchema,
    issuer: SafePolicyIdentifierSchema,
    sourceDigest: Sha256Schema,
    evidenceDigest: Sha256Schema,
    projector: z.enum([
      "mcp-managed-settings",
      "hook-managed-settings",
      "usage-hook",
      "framework-contract",
    ]),
    policyVersion: SafePolicyTextSchema,
    reason: SafePolicyTextSchema,
    /**
     * Optional only to preserve legacy receipt parsing. A missing clarification
     * can never satisfy a waivable evidence gap; when present it is signed.
     */
    clarification: SafePolicyTextSchema.optional(),
    scope: z.array(PolicyTargetSchema).min(1).max(2),
    notBefore: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
    github: z
      .object({
        repository: GitRepositorySchema,
        attestationId: SafePolicyTextSchema,
        subjectDigest: Sha256Schema,
      })
      .strict(),
  })
  .strict();

/**
 * External framework curation is intentionally an authored audit record, not
 * an AIH install/projection instruction. A source pin plus audit reference
 * makes the intent portable and reviewable without claiming control over an
 * upstream agent, skill, or command.
 */
const ExternalCurationItemSchema = z
  .object({
    kind: z.enum(["agent", "skill", "command"]),
    id: SafePolicyTextSchema,
    source: z
      .object({
        repository: GitRepositorySchema,
        commit: GitCommitSchema,
        path: BaselineOverrideBundleSchema,
      })
      .strict(),
    audit: z
      .object({
        record: SafePolicyTextSchema,
        digest: Sha256Schema,
      })
      .strict(),
    clarification: SafePolicyTextSchema.optional(),
  })
  .strict();

const ExternalFrameworkCurationSchema = z
  .object({
    framework: z.enum(["ecc", "superpowers"]),
    items: z.array(ExternalCurationItemSchema).default([]),
  })
  .strict()
  .superRefine((curation, ctx) => {
    const seen = new Set<string>();
    for (const [index, item] of curation.items.entries()) {
      const key = `${item.kind}\0${item.id}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index],
          message: `duplicate external curation item ${item.kind}:${item.id}`,
        });
      }
      seen.add(key);
    }
  });

/**
 * The authoring inventory's own kind vocabulary, duplicated here rather than
 * imported so the grammar module does not pull in the catalog constructors to
 * name nine strings — the same trade `PolicyDangerCodeSchema` already makes.
 * `studio-inventory-selection.test.ts` pins this against
 * `POLICY_AUTHORING_ASSET_KINDS` so the two copies cannot drift apart.
 */
const ExternalSelectionKindSchema = z.enum([
  "agent",
  "baseline",
  "capability",
  "framework",
  "lang",
  "mcp",
  "module",
  "runtime",
  "skill",
]);

/**
 * An administrator's selection over externally-owned inventory. Selecting
 * records requested intent immediately and carries the component's pinned
 * source as provenance; ECC and Superpowers install and run these, and AIH
 * only records that they were asked for. Evidence is the separate axis: an
 * item earns its place in `externalCuration` once an audit record and digest
 * exist, which is why this grammar deliberately has no `audit` field and why
 * it spans all nine inventory kinds rather than curation's three.
 */
const ExternalSelectionItemSchema = z
  .object({
    kind: ExternalSelectionKindSchema,
    id: SafePolicyTextSchema,
    source: z
      .object({
        repository: GitRepositorySchema,
        commit: GitCommitSchema,
        path: BaselineOverrideBundleSchema,
      })
      .strict(),
  })
  .strict();

const ExternalFrameworkSelectionSchema = z
  .object({
    framework: z.enum(["ecc", "superpowers"]),
    items: z.array(ExternalSelectionItemSchema).default([]),
  })
  .strict()
  .superRefine((selection, ctx) => {
    const seen = new Set<string>();
    for (const [index, item] of selection.items.entries()) {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index],
          message: `duplicate external selection ${item.id}`,
        });
      }
      seen.add(item.id);
    }
  });

/**
 * A hook event is a KEY, not merely a name. Every surface that groups entries by
 * event — the projection, the receipt's expectation, the owned-group subtraction
 * — puts it into a plain object, so a name that is already an own property of
 * `Object.prototype` resolves through the prototype chain on any bare lookup:
 * `constructor` yields a function, `toString` and `valueOf` and `hasOwnProperty`
 * likewise. The character fence below admits all four, so nothing else stops one
 * being authored into a policy or recorded into a receipt.
 *
 * Own-property reads are what make those lookups safe, and the projector does
 * them. This is the other half, and it is not redundant with them: it keeps the
 * name out of the authored grammar AND out of a parsed receipt, so a hand-written
 * or hostile receipt degrades to the projector's existing typed refusal — naming
 * the receipt — instead of reaching code that has to be individually careful.
 * AIH implements no event vocabulary of its own, so nothing else here narrows.
 */
const HookEventSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/, "must be a native client hook event name")
  .refine(
    (value) => !Object.hasOwn(Object.prototype, value),
    "must not name an Object.prototype member, which no plain object can key safely",
  );
const HookRegistrationIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._:-]{0,119}$/, "must be a safe registration identifier");

/**
 * A launcher is opaque bytes. It is length-bounded and rejected when it carries
 * control or hidden-Unicode characters, because those cannot survive a JSON
 * round trip into a client configuration intact — but it is never otherwise
 * inspected, and never rewritten.
 */
const HookLauncherCommandSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine(
    (value) => !/\p{C}/u.test(value),
    "must not contain control or hidden Unicode characters",
  );

/**
 * Fields captured verbatim from a native hook entry that AIH does not author —
 * a group's `matcher`, a hook's `async`, whatever else a third party writes.
 *
 * TRANSPORTED, NEVER INTERPRETED. AIH implements no scoping grammar and reads
 * no meaning out of these; it carries them back unchanged, which is the same
 * rule the launcher command already follows. Re-emitting an entry without them
 * would silently widen a hook scoped to one tool into one that fires on
 * everything, so faithfulness here is a correctness property, not tidiness.
 *
 * Bounded and structurally checked at the boundary all the same: unbounded
 * hostile JSON reaches a receipt, a policy document and an operator's screen.
 */
const NATIVE_HOOK_FIELD_MAX_JSON = 8192;
const NATIVE_HOOK_FIELD_MAX_DEPTH = 8;
const NATIVE_HOOK_FIELD_MAX_KEY = 120;
const NATIVE_HOOK_UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** The one copy of native-field validation, shared by the grammar and the projector. */
export function nativeHookFieldIssues(fields: unknown, reserved: readonly string[] = []): string[] {
  const issues: string[] = [];
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    return ["must be a JSON object of captured native fields"];
  }
  for (const key of reserved) {
    if (Object.hasOwn(fields, key)) issues.push(`must not carry ${key}; AIH authors that field`);
  }
  const walk = (value: unknown, depth: number, path: string): void => {
    const where = path === "" ? "the captured fields" : path;
    if (depth > NATIVE_HOOK_FIELD_MAX_DEPTH) {
      issues.push(`${where} nests deeper than ${NATIVE_HOOK_FIELD_MAX_DEPTH} levels`);
      return;
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) issues.push(`${where} is not a finite JSON number`);
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) walk(item, depth + 1, `${where}[${index}]`);
      return;
    }
    if (typeof value === "object") {
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        issues.push(`${where} does not have a plain object prototype`);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (NATIVE_HOOK_UNSAFE_KEYS.has(key)) issues.push(`${where} carries the unsafe key ${key}`);
        else if (key.length > NATIVE_HOOK_FIELD_MAX_KEY || /\p{C}/u.test(key)) {
          issues.push(`${where} carries an over-long or control-bearing key`);
        }
        walk(child, depth + 1, `${where}.${key}`);
      }
      return;
    }
    issues.push(`${where} is not JSON-representable`);
  };
  walk(fields, 0, "");
  // Only serialize once the bounded walk has passed. `JSON.stringify` recurses
  // over the whole value regardless of how deep it is, so measuring size first
  // turns one over-nested field into a raw `RangeError` thrown out of the
  // projection — untyped, and enough to pin the registrar to `invalid` forever.
  if (issues.length > 0) return issues;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(fields);
  } catch (error) {
    return [`could not be serialized safely: ${(error as Error).message}`];
  }
  if (serialized === undefined || serialized.length > NATIVE_HOOK_FIELD_MAX_JSON) {
    issues.push(`must serialize to at most ${NATIVE_HOOK_FIELD_MAX_JSON} JSON characters`);
  }
  return issues;
}

/**
 * MEASURED LIMIT, stated rather than implied: `z.record` builds a new object and
 * drops a `__proto__` key on the way, so the unsafe-key check below never sees
 * that one key when a value reaches the grammar as already-parsed JSON. The
 * check still does real work on every other key and on structure, depth and
 * size.
 *
 * What actually guards `__proto__` is on the capture path, where untrusted
 * content enters: the projector refuses it in the destination SOURCE TEXT
 * (`assertNoProtoMember`) before any of this runs. A `__proto__` written into a
 * policy document by its own administrator is dropped by `z.record` rather than
 * refused — a silent drop this module's doctrine dislikes, kept because the
 * wrappers that expose the raw value (`z.preprocess`, `z.custom`) either strip
 * `"default": []` from the published editor schema or cannot be represented in
 * JSON Schema at all. Not exploitable: no pollution occurs and nothing is
 * projected from it.
 */
function nativeHookFieldsSchema(reserved: readonly string[]) {
  return z.record(z.string(), z.unknown()).superRefine((fields, ctx) => {
    for (const message of nativeHookFieldIssues(fields, reserved)) {
      ctx.addIssue({ code: "custom", message });
    }
  });
}

export const ThirdPartyLauncherPinSchema = z
  .object({
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be an owner/repository identity"),
    commit: z.string().regex(/^[0-9a-f]{40}$/, "must be an exact commit"),
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) => !value.includes("..") && !value.startsWith("/") && !value.startsWith("\\"),
        "must be a contained component path",
      ),
    launcherSha256: Sha256Schema,
    runtimeVersion: z.string().min(1).max(120),
  })
  .strict();

const HookRegistrationOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("aih") }).strict(),
  z
    .object({
      kind: z.literal("third-party"),
      framework: HookRegistrationIdSchema,
      /**
       * Controls the source declares for its own hooks — recorded read-only.
       * AIH never implements, mirrors, or overrides them.
       */
      declaredControls: z.array(z.string().min(1).max(120)).max(20).default([]),
      pin: ThirdPartyLauncherPinSchema,
    })
    .strict(),
  /**
   * An adoption-emitted entry nobody could attribute. Provenance is
   * administrator-declared, never inferred, so an unattributable launcher
   * stays owner `unknown` — but the hash of its exact captured bytes still
   * binds the policy entry to the launcher, so mutation is still drift.
   */
  z.object({ kind: z.literal("unknown"), launcherSha256: Sha256Schema }).strict(),
]);

/**
 * The `hook-managed-settings` projector's own registration shape, carried by
 * the policy grammar as `governance.hookRegistrations` (G1). It lives here so
 * the grammar and the projector validate through ONE copy; the projector module
 * imports it rather than restating it.
 */
export const HookRegistrationSchema = z
  .object({
    id: HookRegistrationIdSchema,
    event: HookEventSchema,
    command: HookLauncherCommandSchema,
    /**
     * Declared overlap keys. AIH never infers a function by reading a command:
     * one AIH composite dispatcher carries several, which is exactly why the
     * overlap key is per-function and not per-entry.
     */
    functionTags: z.array(HookRegistrationIdSchema).min(1).max(20),
    /**
     * Operating-system processes ONE firing spawns, including nested launcher
     * spawns. Never zero: a source that gates its own hooks does so inside the
     * launcher, after the process already exists.
     */
    spawns: z.number().int().min(1).max(64),
    timeout: z.number().int().min(1).max(600).optional(),
    /** The source's own controls report this hook off. It still spawns a process. */
    sourceDisabled: z.boolean().default(false),
    /**
     * The native group's own fields, captured verbatim — `matcher` above all.
     * Absent means AIH authored this entry and the group carries nothing but
     * its `hooks` array.
     */
    nativeGroup: nativeHookFieldsSchema(["hooks"]).optional(),
    // `command` is always AIH's to write. `timeout` is reserved only while the
    // registration authors one: a captured timeout outside what the grammar can
    // author is carried here instead, so a third party writing `timeout: 900`
    // stays adoptable rather than bricking the destination.
    /**
     * The native hook object's own fields, captured verbatim. Absent means AIH
     * authored this entry and it is emitted as a plain `type: "command"` hook;
     * PRESENT-but-empty means the captured entry genuinely carried nothing but
     * its command, and it is emitted that way. The two are not the same entry
     * and must not normalize to the same thing.
     */
    nativeHook: nativeHookFieldsSchema(["command"]).optional(),
    owner: HookRegistrationOwnerSchema,
  })
  .strict();

export type ThirdPartyLauncherPin = z.infer<typeof ThirdPartyLauncherPinSchema>;
export type HookRegistrationOwner = z.infer<typeof HookRegistrationOwnerSchema>;
export interface HookRegistration extends z.input<typeof HookRegistrationSchema> {}
export type ResolvedHookRegistration = z.infer<typeof HookRegistrationSchema>;

export function hookCommandDigest(command: string): string {
  return `sha256:${createHash("sha256").update(command, "utf8").digest("hex")}`;
}

/**
 * The one copy of registration-set validation: the policy grammar refuses
 * through it at parse time and the projector refuses through it before
 * emitting. A launcher whose hash no longer matches its pin is drift — refused,
 * never projected, because projecting it would be a silent update of code AIH
 * cannot read.
 */
export function hookRegistrationSetIssues(
  registrations: readonly ResolvedHookRegistration[],
): { index: number; message: string }[] {
  const issues: { index: number; message: string }[] = [];
  const ids = new Set<string>();
  for (const [index, registration] of registrations.entries()) {
    if (ids.has(registration.id)) {
      issues.push({ index, message: `hook registration ${registration.id} is declared twice` });
    }
    ids.add(registration.id);
    // A timeout has exactly one home. Both at once would emit one value and key
    // on another, which is the field-level divergence the ownership key exists
    // to prevent.
    if (registration.timeout !== undefined && registration.nativeHook?.timeout !== undefined) {
      issues.push({
        index,
        message: `hook registration ${registration.id} records a timeout both as its own field and as a captured native field; it has one home`,
      });
    }
    const pinnedSha256 =
      registration.owner.kind === "third-party"
        ? registration.owner.pin.launcherSha256
        : registration.owner.kind === "unknown"
          ? registration.owner.launcherSha256
          : undefined;
    if (pinnedSha256 === undefined) continue;
    const actual = hookCommandDigest(registration.command);
    if (actual !== pinnedSha256) {
      issues.push({
        index,
        message:
          `hook registration ${registration.id} launcher hash ${actual} no longer matches its pin ` +
          `${pinnedSha256}; this is drift, not a silent update`,
      });
    }
  }
  return issues;
}

const GovernedPolicyGovernanceSchema = z
  .object({
    policyVersion: SafePolicyTextSchema,
    catalog: z
      .object({
        reviewed: z.array(PolicyCandidateSchema).default([]),
        custom: z.array(PolicyCandidateSchema).default([]),
      })
      .strict(),
    activations: z.array(PolicyActivationSchema).default([]),
    authority: z
      .object({
        /**
         * These are activation references, not authority. The independently
         * GitHub-attested authority receipt supplies issuers and revocations and
         * must contain byte-for-byte equivalent approval subjects.
         */
        approvals: z.array(PolicyApprovalSchema).default([]),
      })
      .strict()
      .default({ approvals: [] }),
    /** Report-only external framework curation; never feeds an installer or projector. */
    externalCuration: z.array(ExternalFrameworkCurationSchema).default([]),
    /**
     * Requested intent over externally-owned inventory, recorded before its
     * audit evidence exists. Recording is not enforcement and never feeds an
     * installer or projector.
     */
    externalSelections: z.array(ExternalFrameworkSelectionSchema).default([]),
    /**
     * Source-locked, declarative approval records for ECC external MCP options.
     * A later explicit Add flow must resolve these; this grammar has no runtime
     * side effect and deliberately creates no candidate or activation.
     */
    eccMcpApprovals: z.array(EccMcpApprovalSchema).default([]),
    /** ECC-owned runtime controls projected only through receipt-owned Claude env keys. */
    eccHookControls: EccHookControlsSchema.optional(),
    /**
     * Organization-sanctioned AI CLIs. This is a governance boundary, not the
     * projector target set: every value comes from AIH's supported CLI registry,
     * while materialization/projector support remains capability-specific.
     * At enterprise posture it is an explicit, non-empty allow-list; at vibe,
     * absence means unrestricted. A present list enforces at either posture.
     */
    supportedClis: SupportedCliListSchema.optional(),
    /**
     * Registrations the `hook-managed-settings` projector emits into the client
     * destination AIH owns. The command is a third party's own launcher carried
     * byte-for-byte; the policy engine never reads it, and adoption — never
     * hand-typing — is how a launcher gets here. Additive: absent means no
     * registrations, `schemaVersion` is 2.
     */
    hookRegistrations: z.array(HookRegistrationSchema).default([]),
  })
  .strict()
  .superRefine((governance, ctx) => {
    for (const [index, candidate] of governance.catalog.reviewed.entries()) {
      if (candidate.source.type !== "mcp" && candidate.source.type !== "hook") {
        ctx.addIssue({
          code: "custom",
          path: ["catalog", "reviewed", index, "source"],
          message:
            "reviewed catalog entries must reference an AIH-shipped MCP or AIH-owned hook; organization additions belong in catalog.custom",
        });
      }
    }
    for (const [index, candidate] of governance.catalog.custom.entries()) {
      if (
        candidate.kind === "mcp" &&
        candidate.source.type !== "stdio" &&
        candidate.source.type !== "remote"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["catalog", "custom", index, "source"],
          message:
            "custom MCP candidates must use a fully pinned stdio package or fenced remote endpoint identity; AIH-shipped MCPs belong in catalog.reviewed",
        });
      }
      if (candidate.kind === "hook") {
        ctx.addIssue({
          code: "custom",
          path: ["catalog", "custom", index],
          message:
            "custom hook candidates are unsupported; AIH-owned hooks must use their exact reviewed control",
        });
      }
    }
    const candidateIds = [
      ...governance.catalog.reviewed.map((candidate) => candidate.id),
      ...governance.catalog.custom.map((candidate) => candidate.id),
    ];
    const duplicate = candidateIds.find((id, index) => candidateIds.indexOf(id) !== index);
    if (duplicate !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `candidate id ${duplicate} is duplicated across reviewed/custom catalogs`,
      });
    }
    const activationIds = governance.activations.map((activation) => activation.candidate);
    const duplicateActivation = activationIds.find(
      (id, index) => activationIds.indexOf(id) !== index,
    );
    if (duplicateActivation !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `candidate ${duplicateActivation} has more than one activation decision`,
      });
    }
    for (const activation of governance.activations) {
      if (!candidateIds.includes(activation.candidate)) {
        ctx.addIssue({
          code: "custom",
          message: `activation references unknown candidate ${activation.candidate}`,
        });
        continue;
      }
      const candidate = [...governance.catalog.reviewed, ...governance.catalog.custom].find(
        (item) => item.id === activation.candidate,
      );
      if (
        candidate !== undefined &&
        activation.targets.some((target) => !candidate.targets.includes(target))
      ) {
        ctx.addIssue({
          code: "custom",
          message: `activation targets exceed candidate target support for ${activation.candidate}`,
        });
      }
    }
    const activeFrameworks = governance.activations.filter((activation) => {
      if (activation.state !== "active") return false;
      return [...governance.catalog.reviewed, ...governance.catalog.custom].some(
        (candidate) => candidate.id === activation.candidate && candidate.kind === "framework",
      );
    });
    if (activeFrameworks.length > 1) {
      ctx.addIssue({
        code: "custom",
        message: "only one framework intent may be active at a time",
      });
    }
    const approvalIds = governance.authority.approvals.map((approval) => approval.id);
    const duplicateApproval = approvalIds.find((id, index) => approvalIds.indexOf(id) !== index);
    if (duplicateApproval !== undefined) {
      ctx.addIssue({ code: "custom", message: `approval ${duplicateApproval} is duplicated` });
    }
    const frameworkCuration = governance.externalCuration.map((item) => item.framework);
    const duplicateCuration = frameworkCuration.find(
      (framework, index) => frameworkCuration.indexOf(framework) !== index,
    );
    if (duplicateCuration !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `external framework curation ${duplicateCuration} is duplicated`,
      });
    }
    const selectionFrameworks = governance.externalSelections.map((item) => item.framework);
    const duplicateSelection = selectionFrameworks.find(
      (framework, index) => selectionFrameworks.indexOf(framework) !== index,
    );
    if (duplicateSelection !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `external framework selection ${duplicateSelection} is duplicated`,
      });
    }
    const eccMcpApprovalIds = governance.eccMcpApprovals.map((approval) => approval.id);
    const duplicateEccMcpApproval = eccMcpApprovalIds.find(
      (id, index) => eccMcpApprovalIds.indexOf(id) !== index,
    );
    if (duplicateEccMcpApproval !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["eccMcpApprovals"],
        message: `ECC MCP approval ${duplicateEccMcpApproval} is duplicated`,
      });
    }
    // The same contradiction the activation rule above already forbids, one
    // level down: a policy that selects components from two pinned frameworks
    // at once has not chosen a framework.
    const distinctSelection = [...new Set(selectionFrameworks)].sort();
    if (distinctSelection.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["externalSelections"],
        message: `only one framework may be selected at a time; this policy selects from ${distinctSelection.join(" and ")}`,
      });
    }
    for (const issue of hookRegistrationSetIssues(governance.hookRegistrations)) {
      ctx.addIssue({
        code: "custom",
        path: ["hookRegistrations", issue.index],
        message: issue.message,
      });
    }
    // The exclusivity rule mirrored onto the registration surface: harness
    // hooks and harness selections must name one framework between them.
    // Owners that are not harnesses — aih, a repository's own hook — coexist,
    // so the measured multi-writer workstation state stays expressible.
    const harnessOwners = governance.hookRegistrations
      .map((registration) =>
        registration.owner.kind === "third-party" ? registration.owner.framework : undefined,
      )
      .filter(
        (framework): framework is "ecc" | "superpowers" =>
          framework === "ecc" || framework === "superpowers",
      );
    const namedHarnesses = [...new Set([...distinctSelection, ...harnessOwners])].sort();
    if (harnessOwners.length > 0 && namedHarnesses.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["hookRegistrations"],
        message: `only one framework may be selected at a time; this policy's selections and hook registrations name ${namedHarnesses.join(" and ")}`,
      });
    }
    // Selection and curation are two stages of one thing. A component sitting
    // in both is ambiguous about whether its evidence exists, so fail closed
    // rather than leave a surface to guess which record wins.
    for (const [index, selection] of governance.externalSelections.entries()) {
      const curated = new Set(
        governance.externalCuration
          .filter((curation) => curation.framework === selection.framework)
          .flatMap((curation) => curation.items.map((item) => item.id)),
      );
      for (const [itemIndex, item] of selection.items.entries()) {
        if (curated.has(item.id)) {
          ctx.addIssue({
            code: "custom",
            path: ["externalSelections", index, "items", itemIndex],
            message: `${item.id} is recorded as both a selection and a curation item; a curated component already carries its evidence`,
          });
        }
      }
    }
  });

/** An allow-list-only governance object sanctions CLI targets without taking over projection. */
const SupportedCliOnlyGovernanceSchema = z
  .object({ supportedClis: SupportedCliListSchema })
  .strict();

const PolicyGovernanceSchema = z.union([
  SupportedCliOnlyGovernanceSchema,
  GovernedPolicyGovernanceSchema,
]);

/** Stable flattened input leaves for mechanical consumer-completeness contracts. */
export function schemaLeafPaths(schema: unknown, path = ""): string[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return path.length > 0 ? [path] : [];
  }
  const value = schema as Record<string, unknown>;
  const properties = value.properties;
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    return Object.entries(properties as Record<string, unknown>).flatMap(([key, child]) =>
      schemaLeafPaths(child, path.length === 0 ? key : `${path}.${key}`),
    );
  }
  if (value.items !== undefined) return schemaLeafPaths(value.items, `${path}.*`);
  const variants = value.oneOf ?? value.anyOf;
  if (Array.isArray(variants)) return variants.flatMap((child) => schemaLeafPaths(child, path));
  return path.length > 0 ? [path] : [];
}

/** Exact authorable governance leaves used by the policy consumer-completeness gate. */
export function policyGovernanceLeafPaths(): string[] {
  const jsonSchema = z.toJSONSchema(PolicyGovernanceSchema, { io: "input" });
  return [...new Set(schemaLeafPaths(jsonSchema, "governance"))].sort((left, right) =>
    left.localeCompare(right),
  );
}

/** Exact authorable Strix leaves used by the policy consumer-completeness gate. */
export function policySecurityLeafPaths(): string[] {
  const jsonSchema = z.toJSONSchema(SecurityPolicySchema, { io: "input" });
  return [...new Set(schemaLeafPaths(jsonSchema, "security"))].sort((left, right) =>
    left.localeCompare(right),
  );
}

export const OrgPolicySchema = z
  .object({
    schemaVersion: z.literal(2),
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
    security: SecurityPolicySchema.optional(),
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
          .array(z.enum(["skillspector", "cisco", "mcp-scanner", "semgrep", "snyk-agent-scan"]))
          .optional(),
        /**
         * Named checks `aih skill approve` must see satisfied in the vet evidence
         * before it approves: "license", "pin", "no-exec", "no-mcp", or a detector
         * name that must appear in the evidence's analyzersRun (e.g. "skillspector").
         * Absent → approve adds no extra constraints beyond the evidence chain.
         */
        requiredChecks: z.array(z.string().min(1)).optional(),
        baselineOverrides: z.array(BaselineOverrideSchema).optional(),
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
    /**
     * Candidate inventory and headless activation decisions. This intentionally
     * does not replace the established MCP/trust controls above; it gives the
     * policy engine a strict, reportable contract for new Studio-authored
     * selections. When present, governance exclusively controls AIH-owned MCP
     * and hook selection; legacy MCP trust/network fields remain independent
     * only where their existing consumers still use them.
     */
    governance: PolicyGovernanceSchema.optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.minimumPosture !== "enterprise" || policy.governance?.supportedClis?.length) return;
    ctx.addIssue({
      code: "custom",
      path: ["governance", "supportedClis"],
      message:
        "enterprise posture requires a non-empty governance.supportedClis allow-list; current registry ids: " +
        SUPPORTED_CLIS.join(", ") +
        ". To sanction every supported CLI, paste every id; wildcard sentinels are not supported",
    });
  });

type ParsedOrgPolicy = z.infer<typeof OrgPolicySchema>;
export type OrgPolicy = Omit<ParsedOrgPolicy, "governance"> & {
  governance?: z.infer<typeof GovernedPolicyGovernanceSchema>;
};

type GovernedOrgPolicy = OrgPolicy & { governance: NonNullable<OrgPolicy["governance"]> };

/**
 * A supported-CLI allow-list is a sanction gate, not a request to take over
 * MCP or hook projection. Only a policy carrying governed inventory, decisions,
 * authority, curation, or registrar records owns those AIH surfaces.
 */
export function governanceOwnsAihSurfaces(
  policy: OrgPolicy | undefined,
): policy is GovernedOrgPolicy {
  const governance = policy?.governance;
  return governance !== undefined && "policyVersion" in governance;
}

export class OrgPolicyError extends AihError {
  constructor(message: string) {
    super(message, "AIH_ORG_POLICY");
  }
}

function zodIssueMessages(issues: z.ZodError["issues"]): string[] {
  return issues.flatMap((issue) =>
    issue.code === "invalid_union" ? issue.errors.flatMap(zodIssueMessages) : [issue.message],
  );
}

export function parseOrgPolicy(value: unknown): OrgPolicy {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1
  ) {
    throw new OrgPolicyError(
      "org-policy schemaVersion 1 is no longer supported; set schemaVersion to 2; replace team with vibe or enterprise (the administrator chooses)",
    );
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { minimumPosture?: unknown }).minimumPosture === "team"
  ) {
    throw new OrgPolicyError(
      "org-policy minimumPosture team was removed; replace team with vibe or enterprise (the administrator chooses)",
    );
  }
  try {
    return OrgPolicySchema.parse(value) as OrgPolicy;
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new OrgPolicyError(`org-policy is invalid: ${zodIssueMessages(err.issues).join("; ")}`);
    }
    throw err;
  }
}

/**
 * A governed inventory is the sole authority for AIH-owned MCP and hook
 * mutations. Generic commands must not union legacy selections into it.
 */
export function assertGovernanceOwnsSurface(ctx: PlanContext, surface: "mcp" | "usage"): void {
  const policy = readOrgPolicy(ctx.root, ctx.env);
  if (!governanceOwnsAihSurfaces(policy)) return;
  throw new OrgPolicyError(
    `governance exclusively owns AIH ${surface} projection; use \`aih policy project\` to evaluate and apply the verified policy`,
  );
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
