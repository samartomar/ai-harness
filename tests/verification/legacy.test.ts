import { describe, expect, it } from "vitest";
import {
  buildEvidenceGraph,
  mergeVerificationResults,
  structuredVerificationResultToCheck,
  structuredVerificationRunToCheck,
  structuredVerificationRunToReport,
  type VerificationPipelineRun,
  type VerificationResult,
} from "../../src/index.js";

function result(
  passName: string,
  overrides: Partial<Omit<VerificationResult, "passName">> = {},
): VerificationResult {
  return {
    passName,
    verdict: overrides.verdict ?? "pass",
    severity: overrides.severity ?? "info",
    confidence: overrides.confidence ?? "high",
    evidence: overrides.evidence ?? [],
    message: overrides.message ?? `${passName} complete`,
    category: overrides.category ?? "other",
  };
}

function run(results: VerificationResult[]): VerificationPipelineRun {
  return {
    results,
    summary: mergeVerificationResults(results),
    evidenceGraph: buildEvidenceGraph(results),
  };
}

describe("structured verification legacy compatibility", () => {
  it("maps structured results into legacy checks without warnings failing by default", () => {
    const report = structuredVerificationRunToReport(
      run([
        result("docs"),
        result("dependency", {
          verdict: "warn",
          severity: "low",
          category: "dependency",
          message: "unpinned dependency range",
        }),
        result("exec-locality", {
          verdict: "fail",
          severity: "high",
          category: "exec",
          message: "remote shell execution found",
        }),
      ]),
    );

    expect(report.toJSON()).toEqual({
      ok: false,
      counts: { pass: 2, fail: 1, skip: 0 },
      checks: [
        { name: "docs", verdict: "pass", detail: "docs complete" },
        { name: "dependency", verdict: "pass", detail: "unpinned dependency range" },
        { name: "exec-locality", verdict: "fail", detail: "remote shell execution found" },
      ],
    });
    expect(report.exitCode()).toBe(1);
  });

  it("supports explicit warning mapping for stricter legacy callers", () => {
    const report = structuredVerificationRunToReport(
      run([
        result("policy", {
          verdict: "warn",
          severity: "medium",
          category: "policy",
          message: "policy advisory",
        }),
      ]),
      { warnAs: "fail" },
    );

    expect(report.toJSON()).toMatchObject({
      ok: false,
      counts: { pass: 0, fail: 1, skip: 0 },
      checks: [{ name: "policy", verdict: "fail", detail: "policy advisory" }],
    });
  });

  it("preserves safe file evidence as legacy location and fingerprint metadata", () => {
    const check = structuredVerificationResultToCheck(
      result("exec-locality", {
        verdict: "fail",
        severity: "high",
        category: "exec",
        evidence: [
          {
            id: "exec-locality:script:setup",
            type: "file",
            source: "src/commands/run.ts#scripts.setup",
          },
        ],
        message: "remote shell execution found",
      }),
    );

    expect(check).toEqual({
      name: "exec-locality",
      verdict: "fail",
      detail: "remote shell execution found",
      location: { uri: "src/commands/run.ts" },
      fingerprint: "exec-locality:script:setup",
    });
  });

  it("drops unsafe legacy metadata from non-repo evidence", () => {
    const check = structuredVerificationResultToCheck(
      result("policy", {
        verdict: "fail",
        severity: "high",
        category: "policy",
        evidence: [
          {
            id: "policy finding with spaces",
            type: "file",
            source: "C:\\Users\\samar\\.env#secret",
          },
          {
            id: "policy:https",
            type: "file",
            source: "https://example.invalid/policy.json",
          },
        ],
        message: "policy evidence was not repo-relative",
      }),
    );

    expect(check).toEqual({
      name: "policy",
      verdict: "fail",
      detail: "policy evidence was not repo-relative",
    });
  });

  it("aggregates a structured run into one legacy probe check", () => {
    const check = structuredVerificationRunToCheck(
      run([
        result("session-input-bounds"),
        result("session-dangerous-action", {
          verdict: "fail",
          severity: "high",
          category: "exec",
          message: "1 dangerous session action requires review",
        }),
      ]),
      { name: "session guardrails", passDetail: "no session guardrail findings" },
    );

    expect(check).toEqual({
      name: "session guardrails",
      verdict: "fail",
      detail: "session-dangerous-action: 1 dangerous session action requires review",
    });
  });
});
