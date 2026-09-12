import { posix, win32 } from "node:path";
import { z } from "zod";

const bounded = z.string().min(1).max(1024);
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
    name: z.string().min(1).max(128),
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
    invocation: z.object({ tool: z.string().min(1).max(128), argumentsSha256: sha256 }).strict(),
    observedAt: timestamp,
    expiresAt: timestamp,
    support: z
      .object({ nativeClientStarted: z.boolean(), configuredServerRecognized: z.boolean() })
      .strict(),
    discovery: z
      .object({
        serverConnected: z.boolean(),
        tool: z.string().min(1).max(128),
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
  })
  .strict();

export type McpRuntimeObservationV1 = z.infer<typeof observationSchema>;

/** Current material conditions supplied by the producer immediately before evaluation. */
export interface McpRuntimeBindings {
  client: McpRuntimeObservationV1["client"];
  target: McpRuntimeObservationV1["target"];
  policy: McpRuntimeObservationV1["policy"];
  server: McpRuntimeObservationV1["server"];
  invocation: McpRuntimeObservationV1["invocation"];
}

const bindingsSchema = z
  .object({
    client: clientSchema,
    target: targetSchema,
    policy: policySchema,
    server: serverSchema,
    invocation: observationSchema.shape.invocation,
  })
  .strict();

export interface McpRuntimeEvaluation {
  recordState: "invalid" | "stale" | "current";
  reasons: string[];
  supported: "verified" | "unverified";
  discovered: "verified" | "unverified";
  exercised: "verified" | "unverified";
  restart: "verified" | "unverified";
  enforcement: "verified" | "unverified";
}

const unverified = (
  recordState: McpRuntimeEvaluation["recordState"],
  reasons: string[],
): McpRuntimeEvaluation => ({
  recordState,
  reasons,
  supported: "unverified",
  discovered: "unverified",
  exercised: "unverified",
  restart: "unverified",
  enforcement: "unverified",
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
  if (nowMs >= expiresMs) mismatches.push("observation-expired");
  if (mismatches.length > 0) return unverified("stale", mismatches);

  const supported = record.support.nativeClientStarted && record.support.configuredServerRecognized;
  const discovered = supported && record.discovery.serverConnected && record.discovery.toolListed;
  const exercised =
    discovered &&
    record.operation.succeeded &&
    record.operation.actualCanary === record.operation.expectedCanary;
  const restart =
    exercised &&
    record.restart?.succeeded &&
    record.restart.actualCanary === record.operation.expectedCanary &&
    record.restart.sessionId !== record.operation.sessionId &&
    Date.parse(record.restart.observedAt) >= observedMs &&
    Date.parse(record.restart.observedAt) < expiresMs;
  const enforcement =
    discovered &&
    record.enforcement?.boundary === "mcp-subprocess" &&
    record.enforcement.denied &&
    record.enforcement.effectAbsent;

  return {
    recordState: "current",
    reasons: [],
    supported: supported ? "verified" : "unverified",
    discovered: discovered ? "verified" : "unverified",
    exercised: exercised ? "verified" : "unverified",
    restart: restart ? "verified" : "unverified",
    enforcement: enforcement ? "verified" : "unverified",
  };
}
