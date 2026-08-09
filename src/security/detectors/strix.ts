import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  type StrixFinding,
  type StrixFindingLocation,
  StrixFindingSchema,
  StrixRelativePosixPathSchema,
  type StrixResult,
  StrixResultSchema,
} from "./types.js";

export const STRIX_SOURCE_REPOSITORY = "usestrix/strix";
export const STRIX_RELEASE_VERSION = "1.5.2";
export const STRIX_SOURCE_REVISION = "597aae67159636ee794a02a3cc1694138d619c44";
export const MAX_STRIX_VULNERABILITIES_BYTES = 4 * 1024 * 1024;
export const MAX_STRIX_FINDINGS = 256;

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const safeAtom = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !CONTROL.test(value), "control characters are not allowed");

function hasUnsafeProseControl(value: string): boolean {
  for (const character of value) {
    if (CONTROL.test(character) && character !== "\t" && character !== "\n" && character !== "\r") {
      return true;
    }
  }
  return false;
}

const safeProse = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !hasUnsafeProseControl(value), "unsafe control characters are not allowed");

const UpstreamLocationSchema = z
  .object({
    file: StrixRelativePosixPathSchema,
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    label: safeAtom(160).optional(),
    snippet: safeProse(32_768).optional(),
    fix_before: safeProse(32_768).optional(),
    fix_after: safeProse(32_768).optional(),
  })
  .strict()
  .superRefine((location, ctx) => {
    if (
      location.start_line !== undefined &&
      location.end_line !== undefined &&
      location.end_line < location.start_line
    ) {
      ctx.addIssue({ code: "custom", path: ["end_line"], message: "end_line precedes start_line" });
    }
  });

const boundedStringRecord = z
  .record(safeAtom(64), safeProse(4_096))
  .refine((value) => Object.keys(value).length <= 32, "record has too many entries");

const UpstreamVulnerabilitySchema = z
  .object({
    id: z.string().regex(/^vuln-[0-9]{4,12}$/),
    title: safeAtom(240),
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    timestamp: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} UTC$/),
    description: safeProse(16_384).optional(),
    impact: safeProse(16_384).optional(),
    target: safeProse(4_096).optional(),
    technical_analysis: safeProse(32_768).optional(),
    poc_description: safeProse(32_768).optional(),
    poc_script_code: safeProse(131_072).optional(),
    remediation_steps: safeProse(16_384).optional(),
    evidence: safeProse(32_768).optional(),
    assumptions: safeProse(16_384).optional(),
    fix_effort: safeAtom(80).optional(),
    cvss: z.number().finite().min(0).max(10).optional(),
    cvss_breakdown: boundedStringRecord.optional(),
    endpoint: safeProse(4_096).optional(),
    method: safeAtom(32).optional(),
    cve: z
      .string()
      .regex(/^CVE-[0-9]{4}-[0-9]{4,}$/)
      .optional(),
    cwe: z
      .string()
      .regex(/^CWE-[0-9]{1,6}$/)
      .optional(),
    code_locations: z.array(UpstreamLocationSchema).max(64).optional(),
    fix_pr_body: safeProse(32_768).optional(),
    finding_class: z.enum(["dynamic", "dependency_cve"]),
    dependency_metadata: boundedStringRecord.optional(),
    agent_id: safeAtom(200).optional(),
    agent_name: safeAtom(200).optional(),
  })
  .strict();

const UpstreamVulnerabilitiesSchema = z.array(UpstreamVulnerabilitySchema).max(MAX_STRIX_FINDINGS);
type UpstreamVulnerability = z.infer<typeof UpstreamVulnerabilitySchema>;

export class StrixContractError extends Error {
  override readonly name = "StrixContractError";
}

function codeUnitCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parseUpstreamVulnerabilities(sourceBytes: Uint8Array): UpstreamVulnerability[] {
  if (sourceBytes.byteLength > MAX_STRIX_VULNERABILITIES_BYTES) {
    throw new StrixContractError(
      `Strix vulnerabilities document exceeds ${MAX_STRIX_VULNERABILITIES_BYTES} bytes`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(sourceBytes));
  } catch {
    throw new StrixContractError("Strix vulnerabilities document must be valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StrixContractError("Strix vulnerabilities document must be valid JSON");
  }
  const parsed = UpstreamVulnerabilitiesSchema.safeParse(value);
  if (!parsed.success) {
    throw new StrixContractError("invalid Strix v1.5.2 vulnerabilities document");
  }
  return parsed.data;
}

function normalizeLocations(
  locations: readonly z.infer<typeof UpstreamLocationSchema>[] = [],
): StrixFindingLocation[] {
  return locations
    .map((location) => {
      const normalized: StrixFindingLocation = { path: location.file };
      if (location.start_line !== undefined) normalized.startLine = location.start_line;
      if (location.end_line !== undefined) normalized.endLine = location.end_line;
      if (location.label !== undefined) normalized.label = location.label.trim();
      return normalized;
    })
    .sort((left, right) => {
      const path = codeUnitCompare(left.path, right.path);
      if (path !== 0) return path;
      const start = (left.startLine ?? 0) - (right.startLine ?? 0);
      if (start !== 0) return start;
      const end = (left.endLine ?? 0) - (right.endLine ?? 0);
      if (end !== 0) return end;
      return codeUnitCompare(left.label ?? "", right.label ?? "");
    });
}

function updateFingerprintField(hash: ReturnType<typeof createHash>, value: string | null): void {
  if (value === null) {
    hash.update("-1:", "utf8");
    return;
  }
  const bytes = Buffer.from(value, "utf8");
  hash.update(String(bytes.byteLength), "utf8");
  hash.update(":", "utf8");
  hash.update(bytes);
}

function findingFingerprint(
  report: UpstreamVulnerability,
  locations: readonly StrixFindingLocation[],
): string {
  const hash = createHash("sha256");
  updateFingerprintField(hash, "aih-strix-finding-v1");
  updateFingerprintField(hash, report.title.trim());
  updateFingerprintField(hash, report.severity);
  updateFingerprintField(hash, report.finding_class);
  updateFingerprintField(hash, report.cvss === undefined ? null : String(report.cvss));
  updateFingerprintField(hash, report.cve ?? null);
  updateFingerprintField(hash, report.cwe ?? null);
  updateFingerprintField(hash, String(locations.length));
  for (const location of locations) {
    updateFingerprintField(hash, location.path);
    updateFingerprintField(
      hash,
      location.startLine === undefined ? null : String(location.startLine),
    );
    updateFingerprintField(hash, location.endLine === undefined ? null : String(location.endLine));
    updateFingerprintField(hash, location.label ?? null);
  }
  return hash.digest("hex");
}

function normalizeFinding(report: UpstreamVulnerability): StrixFinding {
  const locations = normalizeLocations(report.code_locations);
  const identity = {
    title: report.title.trim(),
    severity: report.severity,
    findingClass: report.finding_class,
    cvss: report.cvss ?? null,
    cve: report.cve ?? null,
    cwe: report.cwe ?? null,
    locations,
  };
  const finding: StrixFinding = {
    fingerprint: findingFingerprint(report, locations),
    upstreamId: report.id,
    title: identity.title,
    severity: report.severity,
    findingClass: report.finding_class,
    locations,
    pocRedacted:
      report.poc_description !== undefined ||
      report.poc_script_code !== undefined ||
      report.evidence !== undefined,
  };
  if (report.cvss !== undefined) finding.cvss = report.cvss;
  if (report.cve !== undefined) finding.cve = report.cve;
  if (report.cwe !== undefined) finding.cwe = report.cwe;
  return StrixFindingSchema.parse(finding);
}

export function normalizeStrixVulnerabilities(
  sourceBytes: Uint8Array,
  exitCode: 0 | 1 | 2 | null,
): StrixResult {
  if (exitCode !== 0 && exitCode !== 1 && exitCode !== 2 && exitCode !== null) {
    throw new StrixContractError("unsupported Strix exit code");
  }
  const reports = parseUpstreamVulnerabilities(sourceBytes);
  if (exitCode === 0 && reports.length !== 0) {
    throw new StrixContractError("Strix exit 0 requires an empty vulnerabilities document");
  }
  if (exitCode === 2 && reports.length === 0) {
    throw new StrixContractError("Strix exit 2 requires at least one vulnerability");
  }
  if (exitCode === 1 || exitCode === null) {
    return StrixResultSchema.parse({ exitCode, verdict: "indeterminate", findings: [] });
  }
  if (exitCode === 0) {
    return StrixResultSchema.parse({ exitCode: 0, verdict: "no-findings", findings: [] });
  }

  const findings = reports.map(normalizeFinding).sort((left, right) => {
    const fingerprint = codeUnitCompare(left.fingerprint, right.fingerprint);
    return fingerprint !== 0 ? fingerprint : codeUnitCompare(left.upstreamId, right.upstreamId);
  });
  for (let index = 1; index < findings.length; index += 1) {
    if (findings[index - 1]?.fingerprint === findings[index]?.fingerprint) {
      throw new StrixContractError("duplicate normalized finding fingerprint");
    }
  }
  return StrixResultSchema.parse({ exitCode: 2, verdict: "findings", findings });
}
