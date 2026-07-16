import type { QualificationResult } from "./qualify.js";

export interface QualificationReportInput {
  createdAt: string;
  source: { repository: string; resolvedCommit: string; treeSha256: string };
  compatibilityKey: string;
  hostContract: string;
  qualification: QualificationResult;
}

export interface QualificationReport extends QualificationReportInput {
  providerCodeExecuted: false;
}

const SECRET_LIKE =
  /\b(?:ghp_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{12,}|token|password|secret)\s*(?:=|:)/i;

function assertSafeReportInput(input: Record<string, unknown>): void {
  if ("providerSourceContent" in input)
    throw new Error("provider source content is not reportable");
  for (const value of Object.values(input)) {
    if (typeof value === "string" && SECRET_LIKE.test(value)) {
      throw new Error("unsafe secret-like report value");
    }
  }
}

export function createQualificationReport(
  input: QualificationReportInput & Record<string, unknown>,
): QualificationReport {
  assertSafeReportInput(input);
  return {
    createdAt: input.createdAt,
    source: { ...input.source },
    compatibilityKey: input.compatibilityKey,
    hostContract: input.hostContract,
    providerCodeExecuted: false,
    qualification: {
      ...input.qualification,
      findings: [...input.qualification.findings],
      providerCodeExecuted: false,
    },
  };
}
