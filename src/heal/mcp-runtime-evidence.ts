import { posix, win32 } from "node:path";
import { z } from "zod";

const bounded = z.string().min(1).max(1024);
const displayedIdentifier = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      }),
    "identifier contains control characters",
  );
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePath = bounded
  .refine(
    (value) =>
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      }),
    "path contains control characters",
  )
  .refine(
    (value) =>
      posix.isAbsolute(value) || (win32.isAbsolute(value) && !/^[\\/](?![\\/])/.test(value)),
    "expected an absolute path",
  );
const timestamp = z.iso.datetime({ offset: true });
const identitySha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const materialRoleSchema = z.enum([
  "sandbox-profile",
  "organization-policy",
  "bubblewrap",
  "seccomp",
  "provider-plugin",
  "mcp-runtime",
  "mcp-fixture",
  "mcp-fixture-config",
  "managed-mcp-manifest",
  "managed-mcp-entry",
]);
const materialSchema = z.object({ role: materialRoleSchema, path: absolutePath, sha256 }).strict();
const restrictionIds = [
  "protected-read",
  "protected-write",
  "sandbox-profile-write",
  "native-config-write",
  "control-directory-rename",
  "tcp-connect",
  "unix-connect",
] as const;
const restrictionIdSchema = z.enum(restrictionIds);
const restrictionSchema = z
  .object({
    id: restrictionIdSchema,
    boundary: z.enum(["client-shell", "mcp-subprocess"]),
    denied: z.boolean(),
    effectAbsent: z.boolean(),
  })
  .strict();

const clientSchema = z
  .object({
    targetCli: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    executable: absolutePath,
    version: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !/^(?:unknown|unavailable)$/i.test(value)),
    sha256,
  })
  .strict();

const targetSchema = z
  .object({ canonicalRoot: absolutePath, configPath: absolutePath, configSha256: sha256 })
  .strict();

const policySchema = z
  .object({
    approvalPolicy: z.string().min(1).max(64),
    sandbox: z.string().min(1).max(64),
    networkAccess: z.boolean(),
  })
  .strict();

const serverSchema = z
  .object({
    name: displayedIdentifier,
    fixtureIdentity: identitySha256,
    runtimeIdentity: identitySha256,
    cacheIdentity: identitySha256.optional(),
  })
  .strict();

const observationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("aih-mcp-runtime-observation"),
    client: clientSchema,
    target: targetSchema,
    policy: policySchema,
    server: serverSchema,
    invocation: z.object({ tool: displayedIdentifier, argumentsSha256: sha256 }).strict(),
    materials: z
      .array(materialSchema)
      .min(1)
      .max(16)
      .superRefine((materials, ctx) => {
        const roles = new Set<string>();
        for (const material of materials) {
          if (roles.has(material.role)) {
            ctx.addIssue({ code: "custom", message: "duplicate material role" });
          }
          roles.add(material.role);
        }
      })
      .optional(),
    observedAt: timestamp,
    expiresAt: timestamp,
    support: z
      .object({ nativeClientStarted: z.boolean(), configuredServerRecognized: z.boolean() })
      .strict(),
    discovery: z
      .object({
        serverConnected: z.boolean(),
        tool: displayedIdentifier,
        toolListed: z.boolean(),
      })
      .strict(),
    operation: z
      .object({
        expectedCanary: bounded,
        actualCanary: bounded,
        succeeded: z.boolean(),
        sessionId: z.string().min(1).max(256),
      })
      .strict(),
    restart: z
      .object({
        actualCanary: bounded,
        succeeded: z.boolean(),
        sessionId: z.string().min(1).max(256),
        observedAt: timestamp,
      })
      .strict()
      .optional(),
    enforcement: z
      .object({
        boundary: z.enum(["client-shell", "mcp-subprocess"]),
        operation: z.string().min(1).max(512),
        denied: z.boolean(),
        effectAbsent: z.boolean(),
      })
      .strict()
      .optional(),
    restrictions: z
      .array(restrictionSchema)
      .min(1)
      .max(32)
      .superRefine((restrictions, ctx) => {
        const keys = new Set<string>();
        for (const restriction of restrictions) {
          const key = `${restriction.boundary}\u0000${restriction.id}`;
          if (keys.has(key)) {
            ctx.addIssue({ code: "custom", message: "duplicate restriction" });
          }
          keys.add(key);
        }
      })
      .optional(),
  })
  .strict();

export type McpRuntimeObservationV1 = z.infer<typeof observationSchema>;
export type McpRuntimeMaterialRole = z.infer<typeof materialRoleSchema>;
export type McpRuntimeRestrictionId = z.infer<typeof restrictionIdSchema>;
export type McpRuntimeRestriction = z.infer<typeof restrictionSchema>;

/** Parse one strict V1 observation without accepting unknown or future fields. */
export function parseMcpRuntimeObservation(input: unknown): McpRuntimeObservationV1 | undefined {
  const parsed = observationSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

/** Current material conditions supplied by the producer immediately before evaluation. */
export interface McpRuntimeBindings {
  client: McpRuntimeObservationV1["client"];
  target: McpRuntimeObservationV1["target"];
  policy: McpRuntimeObservationV1["policy"];
  server: McpRuntimeObservationV1["server"];
  invocation: McpRuntimeObservationV1["invocation"];
  materials?: McpRuntimeObservationV1["materials"];
  operation?: Pick<McpRuntimeObservationV1["operation"], "expectedCanary">;
}

const bindingsSchema = z
  .object({
    client: clientSchema,
    target: targetSchema,
    policy: policySchema,
    server: serverSchema,
    invocation: observationSchema.shape.invocation,
    materials: observationSchema.shape.materials,
    operation: z.object({ expectedCanary: bounded }).strict().optional(),
  })
  .strict();

export interface McpRuntimeRestrictionEvaluation {
  id: McpRuntimeRestrictionId;
  boundary: McpRuntimeRestriction["boundary"];
  status: "verified" | "unverified";
}

export interface McpRuntimeEvaluation {
  recordState: "invalid" | "stale" | "current";
  reasons: string[];
  supported: "verified" | "unverified";
  discovered: "verified" | "unverified";
  exercised: "verified" | "unverified";
  restart: "verified" | "unverified";
  enforcement: "verified" | "unverified";
  restrictions: McpRuntimeRestrictionEvaluation[];
}

const unverified = (
  recordState: McpRuntimeEvaluation["recordState"],
  reasons: string[],
  restrictions: McpRuntimeRestrictionEvaluation[] = [],
): McpRuntimeEvaluation => ({
  recordState,
  reasons,
  supported: "unverified",
  discovered: "unverified",
  exercised: "unverified",
  restart: "unverified",
  enforcement: "unverified",
  restrictions,
});

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Strictly validates and evaluates one local runtime observation. This is an
 * observation, not signed authority, and this function does not import it into readiness.
 */
export function evaluateMcpRuntimeObservation(
  input: unknown,
  expected: McpRuntimeBindings,
  now: string,
): McpRuntimeEvaluation {
  const parsed = observationSchema.safeParse(input);
  const current = bindingsSchema.safeParse(expected);
  const nowMs = Date.parse(now);
  if (!parsed.success) return unverified("invalid", ["malformed-observation"]);
  if (!current.success) return unverified("invalid", ["malformed-current-bindings"]);
  if (!Number.isFinite(nowMs)) return unverified("invalid", ["invalid-evaluation-time"]);

  const record = parsed.data;
  if (record.discovery.tool !== record.invocation.tool)
    return unverified("invalid", ["inconsistent-tool-binding"]);
  const observedMs = Date.parse(record.observedAt);
  const expiresMs = Date.parse(record.expiresAt);
  if (observedMs > nowMs || expiresMs <= observedMs)
    return unverified("invalid", ["invalid-observation-time"]);
  if (record.restart && Date.parse(record.restart.observedAt) > nowMs)
    return unverified("invalid", ["invalid-restart-time"]);

  const mismatches: string[] = [];
  if (!same(record.client, current.data.client)) mismatches.push("client-binding-changed");
  if (!same(record.target, current.data.target)) mismatches.push("target-binding-changed");
  if (!same(record.policy, current.data.policy)) mismatches.push("policy-binding-changed");
  if (!same(record.server, current.data.server)) mismatches.push("server-binding-changed");
  if (!same(record.invocation, current.data.invocation))
    mismatches.push("invocation-binding-changed");
  if (current.data.materials && !same(record.materials, current.data.materials))
    mismatches.push("material-binding-changed");
  if (
    current.data.operation &&
    record.operation.expectedCanary !== current.data.operation.expectedCanary
  )
    mismatches.push("operation-binding-changed");
  if (nowMs >= expiresMs) mismatches.push("observation-expired");
  if (mismatches.length > 0)
    return unverified(
      "stale",
      mismatches,
      (record.restrictions ?? []).map(({ id, boundary }) => ({
        id,
        boundary,
        status: "unverified",
      })),
    );

  const reasons: string[] = [];
  const supported = record.support.nativeClientStarted && record.support.configuredServerRecognized;
  if (!record.support.nativeClientStarted) reasons.push("native-client-not-started");
  if (!record.support.configuredServerRecognized) reasons.push("configured-server-not-recognized");
  const discovered = supported && record.discovery.serverConnected && record.discovery.toolListed;
  if (!record.discovery.serverConnected) reasons.push("server-not-connected");
  if (!record.discovery.toolListed) reasons.push("tool-not-listed");
  const exercised =
    discovered &&
    record.operation.succeeded &&
    record.operation.actualCanary === record.operation.expectedCanary;
  if (!record.operation.succeeded) reasons.push("operation-failed");
  if (record.operation.actualCanary !== record.operation.expectedCanary)
    reasons.push("operation-canary-mismatch");
  const restart =
    exercised &&
    record.restart?.succeeded &&
    record.restart.actualCanary === record.operation.expectedCanary &&
    record.restart.sessionId !== record.operation.sessionId &&
    Date.parse(record.restart.observedAt) >= observedMs &&
    Date.parse(record.restart.observedAt) < expiresMs;
  if (!record.restart) reasons.push("restart-not-observed");
  else {
    if (!record.restart.succeeded) reasons.push("restart-operation-failed");
    if (record.restart.actualCanary !== record.operation.expectedCanary)
      reasons.push("restart-canary-mismatch");
    if (record.restart.sessionId === record.operation.sessionId)
      reasons.push("restart-session-not-distinct");
  }
  const restrictions: McpRuntimeRestrictionEvaluation[] = (record.restrictions ?? []).map(
    (restriction) => ({
      id: restriction.id,
      boundary: restriction.boundary,
      status:
        restriction.denied &&
        restriction.effectAbsent &&
        (restriction.boundary === "mcp-subprocess" ? discovered : supported)
          ? "verified"
          : "unverified",
    }),
  );
  for (const restriction of restrictions) {
    if (restriction.status === "unverified") {
      reasons.push(`restriction-unverified:${restriction.boundary}:${restriction.id}`);
    }
  }
  const restrictionSetComplete =
    restrictions.length === restrictionIds.length * 2 &&
    restrictionIds.every((id) =>
      (["client-shell", "mcp-subprocess"] as const).every((boundary) =>
        restrictions.some(
          (restriction) => restriction.id === id && restriction.boundary === boundary,
        ),
      ),
    );
  if (restrictions.length > 0 && !restrictionSetComplete)
    reasons.push("restriction-set-incomplete");
  const restrictionsEnforced =
    restrictionSetComplete &&
    restrictions.every((restriction) => restriction.status === "verified") &&
    discovered;
  const legacyEnforcement =
    discovered &&
    record.enforcement?.boundary === "mcp-subprocess" &&
    record.enforcement.denied &&
    record.enforcement.effectAbsent;
  const enforcement = restrictions.length > 0 ? restrictionsEnforced : legacyEnforcement;
  if (!enforcement && record.enforcement === undefined && restrictions.length === 0)
    reasons.push("mcp-enforcement-not-observed");

  return {
    recordState: "current",
    reasons,
    supported: supported ? "verified" : "unverified",
    discovered: discovered ? "verified" : "unverified",
    exercised: exercised ? "verified" : "unverified",
    restart: restart ? "verified" : "unverified",
    enforcement: enforcement ? "verified" : "unverified",
    restrictions,
  };
}
