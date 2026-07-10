import { z } from "zod";

const SAFE_COMPONENT_ID = /^[a-z0-9][a-z0-9:._-]*$/;
const SAFE_SOURCE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_REPO_PART = /^[A-Za-z0-9_.-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.startsWith("./")) return false;
  if (value.includes("\\") || value.endsWith("/") || value.includes("//")) return false;
  if (value.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    return false;
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

export const BaselineComponentIdSchema = z.string().regex(SAFE_COMPONENT_ID);
export const BaselineComponentPathSchema = z.string().refine(isSafeRelativePath, {
  message: "component path must be a safe POSIX source-relative path",
});

export const BaselineAnalyzerReceiptSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    version: z.string().trim().min(1).max(200),
  })
  .strict();

export const BaselineEvidenceFindingSchema = z
  .object({
    code: z.string().trim().min(1).max(200),
    detail: z.string().trim().min(1).max(2_000),
    fingerprint: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const BaselineComponentEvidenceSchema = z
  .object({
    id: BaselineComponentIdSchema,
    paths: z.array(BaselineComponentPathSchema).min(1),
    treeSha256: z.string().regex(SHA256),
    verdict: z.enum(["pass", "blocked"]),
    analyzers: z.array(BaselineAnalyzerReceiptSchema).min(1),
    findings: z.array(BaselineEvidenceFindingSchema),
  })
  .strict()
  .superRefine((component, ctx) => {
    const paths = new Set<string>();
    for (const [index, path] of component.paths.entries()) {
      if (paths.has(path)) {
        ctx.addIssue({
          code: "custom",
          path: ["paths", index],
          message: `duplicate component path: ${path}`,
        });
      }
      paths.add(path);
    }
    if (component.verdict === "blocked" && component.findings.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["findings"],
        message: "blocked component evidence must retain at least one blocking finding",
      });
    }
  });

export const BaselineSourceEvidenceSchema = z
  .object({
    id: z.string().regex(SAFE_SOURCE_ID),
    owner: z.string().regex(SAFE_REPO_PART),
    repo: z.string().regex(SAFE_REPO_PART),
    pinnedSha: z.string().regex(GIT_SHA),
    components: z.array(BaselineComponentEvidenceSchema).min(1),
  })
  .strict()
  .superRefine((source, ctx) => {
    const ids = new Set<string>();
    for (const [index, component] of source.components.entries()) {
      if (ids.has(component.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["components", index, "id"],
          message: `duplicate component id: ${component.id}`,
        });
      }
      ids.add(component.id);
    }
  });

export const BaselineEvidenceLockSchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.array(BaselineSourceEvidenceSchema).min(1),
  })
  .strict()
  .superRefine((lock, ctx) => {
    const ids = new Set<string>();
    const origins = new Set<string>();
    for (const [index, source] of lock.sources.entries()) {
      if (ids.has(source.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", index, "id"],
          message: `duplicate source id: ${source.id}`,
        });
      }
      ids.add(source.id);
      const origin = `${source.owner.toLowerCase()}/${source.repo.toLowerCase()}@${source.pinnedSha}`;
      if (origins.has(origin)) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", index],
          message: `duplicate source origin: ${origin}`,
        });
      }
      origins.add(origin);
    }
  });

export type BaselineAnalyzerReceipt = z.infer<typeof BaselineAnalyzerReceiptSchema>;
export type BaselineEvidenceFinding = z.infer<typeof BaselineEvidenceFindingSchema>;
export type BaselineComponentEvidence = z.infer<typeof BaselineComponentEvidenceSchema>;
export type BaselineSourceEvidence = z.infer<typeof BaselineSourceEvidenceSchema>;
export type BaselineEvidenceLock = z.infer<typeof BaselineEvidenceLockSchema>;

export function parseBaselineEvidenceLock(value: unknown): BaselineEvidenceLock {
  return BaselineEvidenceLockSchema.parse(value);
}
