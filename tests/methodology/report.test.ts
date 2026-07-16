import { describe, expect, it } from "vitest";
import { createQualificationReport } from "../../src/methodology/report.js";

const input = {
  createdAt: "2026-07-15T00:00:00.000Z",
  source: { repository: "garrytan/gstack", resolvedCommit: "a".repeat(40), treeSha256: "b".repeat(64) },
  compatibilityKey: "exact-tuple-digest",
  hostContract: "codex-0.144.1-windows-x64-v1",
  qualification: {
    classification: "QUALIFICATION_BLOCKED" as const,
    supportLevel: "plannable" as const,
    findings: ["ADAPTER_COMPATIBILITY_UNKNOWN"],
    providerCodeExecuted: false as const,
  },
};

describe("qualification reports", () => {
  it("is deterministic for fixed input and never claims installation or activation", () => {
    const report = createQualificationReport(input);
    expect(createQualificationReport(input)).toEqual(report);
    expect(report.providerCodeExecuted).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/install|activate|switch/i);
  });

  it("rejects secret-like and provider-content fields", () => {
    expect(() => createQualificationReport({ ...input, note: "token=ghp_abcdefghijklmnop" })).toThrow(
      /secret|unsafe/i,
    );
    expect(() => createQualificationReport({ ...input, providerSourceContent: "echo do-not-report" })).toThrow(
      /source content/i,
    );
  });
});
