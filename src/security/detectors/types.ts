import { z } from "zod";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;
const WINDOWS_DRIVE = /^[A-Za-z]:/;

export const STRIX_INVOCATION_LIMITS = Object.freeze({
  maxBudgetCents: 1_000,
  maxTurns: 20,
  timeoutMs: 300_000,
} as const);

export function isSafeStrixRelativePosixPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("//") ||
    WINDOWS_DRIVE.test(value) ||
    !SAFE_TEXT.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export const StrixRelativePosixPathSchema = z
  .string()
  .max(1_024)
  .refine(isSafeStrixRelativePosixPath, {
    message: "path must be a canonical relative POSIX path",
  });

export const StrixSeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export const StrixFindingClassSchema = z.enum(["dynamic", "dependency_cve"]);
export const StrixSandboxPlatformSchema = z.enum(["linux/amd64", "linux/arm64"]);

export const StrixFindingLocationSchema = z
  .object({
    path: StrixRelativePosixPathSchema,
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    label: z.string().min(1).max(160).regex(SAFE_TEXT).optional(),
  })
  .strict()
  .superRefine((location, ctx) => {
    if (
      location.startLine !== undefined &&
      location.endLine !== undefined &&
      location.endLine < location.startLine
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["endLine"],
        message: "endLine must not precede startLine",
      });
    }
  });

export const StrixFindingSchema = z
  .object({
    fingerprint: z.string().regex(SHA256_HEX),
    upstreamId: z.string().regex(/^vuln-[0-9]{4,12}$/),
    title: z.string().min(1).max(240).regex(SAFE_TEXT),
    severity: StrixSeveritySchema,
    findingClass: StrixFindingClassSchema,
    cvss: z.number().min(0).max(10).optional(),
    cve: z
      .string()
      .regex(/^CVE-[0-9]{4}-[0-9]{4,}$/)
      .optional(),
    cwe: z
      .string()
      .regex(/^CWE-[0-9]{1,6}$/)
      .optional(),
    locations: z.array(StrixFindingLocationSchema).max(64),
    pocRedacted: z.boolean(),
  })
  .strict();

const NoFindingsResultSchema = z
  .object({
    exitCode: z.literal(0),
    verdict: z.literal("no-findings"),
    findings: z.array(StrixFindingSchema).length(0),
  })
  .strict();

const FindingsResultSchema = z
  .object({
    exitCode: z.literal(2),
    verdict: z.literal("findings"),
    findings: z.array(StrixFindingSchema).min(1).max(256),
  })
  .strict();

const IndeterminateResultSchema = z
  .object({
    exitCode: z.union([z.literal(1), z.null()]),
    verdict: z.literal("indeterminate"),
    findings: z.array(StrixFindingSchema).length(0),
  })
  .strict();

export const StrixResultSchema = z.discriminatedUnion("verdict", [
  NoFindingsResultSchema,
  FindingsResultSchema,
  IndeterminateResultSchema,
]);

export const StrixEvidenceSchema = z
  .object({
    format: z.literal("aih-strix-detector-evidence"),
    schemaVersion: z.literal(1),
    detector: z
      .object({
        name: z.literal("strix"),
        repository: z.literal("usestrix/strix"),
        version: z.literal("1.5.2"),
        sourceRevision: z.literal("597aae67159636ee794a02a3cc1694138d619c44"),
      })
      .strict(),
    image: z
      .object({
        repository: z.literal("ghcr.io/usestrix/strix-sandbox"),
        tag: z.literal("1.3.0"),
        indexDigest: z.literal(
          "sha256:f6906c3114e504fd1a218fcf028d7a0e46851118403a438b63956de6ea7c4331",
        ),
        platform: StrixSandboxPlatformSchema,
        manifestDigest: z.string().regex(SHA256),
      })
      .strict()
      .superRefine((image, ctx) => {
        const expected =
          image.platform === "linux/amd64"
            ? "sha256:e5e5d9927f15ca95ad49804ef7d22439771cd27378f400da6edd47556799baff"
            : "sha256:38f9eea087079763312877eaf59047c3bd61ece67ab3479c1da63dc48fe50587";
        if (image.manifestDigest !== expected) {
          ctx.addIssue({
            code: "custom",
            path: ["manifestDigest"],
            message: "manifest digest does not match the declared runnable platform",
          });
        }
      }),
    subject: z
      .object({
        kind: z.literal("local-fixture"),
        treeSha256: z.string().regex(SHA256_HEX),
      })
      .strict(),
    invocation: z
      .object({
        mode: z.enum(["quick", "standard", "deep"]),
        maxBudgetCents: z.number().int().positive().max(STRIX_INVOCATION_LIMITS.maxBudgetCents),
        maxTurns: z.number().int().positive().max(STRIX_INVOCATION_LIMITS.maxTurns),
        timeoutMs: z.number().int().positive().max(STRIX_INVOCATION_LIMITS.timeoutMs),
        telemetry: z.literal("off"),
      })
      .strict(),
    result: StrixResultSchema,
  })
  .strict();

export type StrixSeverity = z.infer<typeof StrixSeveritySchema>;
export type StrixFindingClass = z.infer<typeof StrixFindingClassSchema>;
export type StrixSandboxPlatform = z.infer<typeof StrixSandboxPlatformSchema>;
export type StrixFindingLocation = z.infer<typeof StrixFindingLocationSchema>;
export type StrixFinding = z.infer<typeof StrixFindingSchema>;
export type StrixResult = z.infer<typeof StrixResultSchema>;
export type StrixEvidence = z.infer<typeof StrixEvidenceSchema>;
