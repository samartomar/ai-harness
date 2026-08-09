import { describe, expect, it } from "vitest";
import {
  MAX_STRIX_VULNERABILITIES_BYTES,
  normalizeStrixVulnerabilities,
} from "../../../src/security/detectors/strix.js";
import {
  STRIX_INVOCATION_LIMITS,
  StrixEvidenceSchema,
  StrixFindingLocationSchema,
  StrixFindingSchema,
  StrixResultSchema,
} from "../../../src/security/detectors/types.js";

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "vuln-0001",
    title: "Path traversal",
    severity: "high",
    timestamp: "2026-08-09 12:00:00 UTC",
    description: "Free-form detail is not retained.",
    impact: "Free-form impact is not retained.",
    target: "https://private.example.test",
    technical_analysis: "Free-form analysis is not retained.",
    poc_description: "POC_DESCRIPTION_MARKER",
    poc_script_code: "POC_SCRIPT_MARKER",
    remediation_steps: "Free-form remediation is not retained.",
    evidence: "POC_EVIDENCE_MARKER",
    assumptions: "Free-form assumptions are not retained.",
    fix_effort: "medium",
    cvss: 8.1,
    cvss_breakdown: { attack_vector: "network" },
    endpoint: "/private",
    method: "POST",
    cve: "CVE-2026-1234",
    cwe: "CWE-22",
    code_locations: [
      {
        file: "src/server.ts",
        start_line: 20,
        end_line: 22,
        label: "handler",
        snippet: "SNIPPET_MARKER",
        fix_before: "FIX_BEFORE_MARKER",
        fix_after: "FIX_AFTER_MARKER",
      },
    ],
    fix_pr_body: "Free-form PR body is not retained.",
    finding_class: "dynamic",
    dependency_metadata: { package_name: "example" },
    agent_id: "agent-1",
    agent_name: "worker",
    ...overrides,
  };
}

function bytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

describe("Strix v1.5.2 vulnerabilities contract", () => {
  it("normalizes strict findings deterministically and redacts PoC and private payloads", () => {
    const first = report();
    const second = report({
      id: "vuln-0002",
      title: "Low risk finding",
      severity: "low",
      timestamp: "2026-08-09 12:01:00 UTC",
      poc_description: undefined,
      poc_script_code: undefined,
      evidence: undefined,
      cve: undefined,
      cwe: undefined,
      cvss: undefined,
      code_locations: [{ file: "src/a.ts", start_line: 1 }],
    });

    const forward = normalizeStrixVulnerabilities(bytes([first, second]), 2);
    const reversed = normalizeStrixVulnerabilities(bytes([second, first]), 2);

    expect(forward).toEqual(reversed);
    expect(forward.verdict).toBe("findings");
    expect(forward.exitCode).toBe(2);
    expect(forward.findings).toHaveLength(2);
    expect(forward.findings.every((finding) => /^[0-9a-f]{64}$/.test(finding.fingerprint))).toBe(
      true,
    );

    const pathTraversal = forward.findings.find((finding) => finding.upstreamId === "vuln-0001");
    expect(pathTraversal).toEqual(
      expect.objectContaining({
        upstreamId: "vuln-0001",
        title: "Path traversal",
        severity: "high",
        findingClass: "dynamic",
        cvss: 8.1,
        cve: "CVE-2026-1234",
        cwe: "CWE-22",
        pocRedacted: true,
        locations: [{ path: "src/server.ts", startLine: 20, endLine: 22, label: "handler" }],
      }),
    );

    const serialized = JSON.stringify(forward);
    expect(serialized).not.toContain("POC_DESCRIPTION_MARKER");
    expect(serialized).not.toContain("POC_SCRIPT_MARKER");
    expect(serialized).not.toContain("POC_EVIDENCE_MARKER");
    expect(serialized).not.toContain("SNIPPET_MARKER");
    expect(serialized).not.toContain("FIX_BEFORE_MARKER");
    expect(serialized).not.toContain("FIX_AFTER_MARKER");
    expect(serialized).not.toContain("private.example.test");
    expect(serialized).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(StrixResultSchema.parse(forward)).toEqual(forward);
    for (const finding of forward.findings)
      expect(StrixFindingSchema.parse(finding)).toEqual(finding);
  });

  it("maps source exit semantics and enforces cross-field consistency", () => {
    expect(normalizeStrixVulnerabilities(bytes([]), 0)).toEqual({
      exitCode: 0,
      verdict: "no-findings",
      findings: [],
    });
    expect(normalizeStrixVulnerabilities(bytes([report()]), 1)).toEqual({
      exitCode: 1,
      verdict: "indeterminate",
      findings: [],
    });
    expect(normalizeStrixVulnerabilities(bytes([report()]), null)).toEqual({
      exitCode: null,
      verdict: "indeterminate",
      findings: [],
    });
    expect(() => normalizeStrixVulnerabilities(bytes([report()]), 0)).toThrow(
      /exit 0 requires an empty vulnerabilities document/,
    );
    expect(() => normalizeStrixVulnerabilities(bytes([]), 2)).toThrow(
      /exit 2 requires at least one vulnerability/,
    );
    expect(() => normalizeStrixVulnerabilities(bytes([]), 3 as never)).toThrow(
      /unsupported Strix exit code/,
    );
  });

  it("fails the whole document closed for malformed encoding, JSON, shape, and fields", () => {
    expect(() =>
      normalizeStrixVulnerabilities(
        Buffer.concat([Buffer.from('[{"id":"vuln-0001","title":"bad'), Buffer.from([0xff])]),
        2,
      ),
    ).toThrow(/valid UTF-8/);
    expect(() => normalizeStrixVulnerabilities(Buffer.from("{", "utf8"), 2)).toThrow(/valid JSON/);
    expect(() =>
      normalizeStrixVulnerabilities(bytes([{ ...report(), unexpected: true }]), 2),
    ).toThrow(/valid Strix v1.5.2 vulnerabilities document/);
    expect(() =>
      normalizeStrixVulnerabilities(bytes([report({ title: "unsafe\u0000title" })]), 2),
    ).toThrow(/valid Strix v1.5.2 vulnerabilities document/);
    expect(() => normalizeStrixVulnerabilities(bytes([report({ severity: "urgent" })]), 2)).toThrow(
      /valid Strix v1.5.2 vulnerabilities document/,
    );
  });

  it("rejects Unicode format and line-separator controls while allowing prose line breaks", () => {
    expect(() =>
      normalizeStrixVulnerabilities(
        bytes([report({ description: "line one\nline two\r\nline three\tvalue" })]),
        2,
      ),
    ).not.toThrow();

    for (const unsafe of ["\u200b", "\u202e", "\ufeff", "\u0085", "\u2028", "\u2029"]) {
      let thrown: unknown;
      try {
        normalizeStrixVulnerabilities(bytes([report({ title: `unsafe${unsafe}title` })]), 2);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(() =>
        normalizeStrixVulnerabilities(
          bytes([report({ code_locations: [{ file: `src/${unsafe}file.ts` }] })]),
          2,
        ),
      ).toThrow(/valid Strix v1.5.2 vulnerabilities document/);
    }
  });

  it("does not execute inherited toJSON while computing finding fingerprints", () => {
    const source = bytes([report()]);
    let calls = 0;
    const hostile = () => {
      calls += 1;
      throw new Error("inherited toJSON executed");
    };
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value: hostile,
    });
    Object.defineProperty(Array.prototype, "toJSON", {
      configurable: true,
      value: hostile,
    });
    try {
      expect(() => normalizeStrixVulnerabilities(source, 2)).not.toThrow();
      expect(calls).toBe(0);
    } finally {
      Reflect.deleteProperty(Object.prototype, "toJSON");
      Reflect.deleteProperty(Array.prototype, "toJSON");
    }
  });

  it.each([
    "../secret",
    "/etc/passwd",
    "C:/Users/operator/secret",
    "src\\server.ts",
    "./src/server.ts",
    "src//server.ts",
    "src/server.ts/",
  ])("rejects unsafe paths at the public finding-location schema %s", (path) => {
    expect(StrixFindingLocationSchema.safeParse({ path }).success).toBe(false);
  });

  it("accepts a canonical nested path at the public finding-location schema", () => {
    expect(StrixFindingLocationSchema.parse({ path: "src/security/detectors/strix.ts" })).toEqual({
      path: "src/security/detectors/strix.ts",
    });
  });

  it.each([
    "/etc/passwd",
    "../secret",
    "src/../secret",
    "./src/server.ts",
    "C:/Users/operator/secret",
    "src\\server.ts",
    "src//server.ts",
    "src/server.ts/",
  ])("rejects unsafe or non-canonical code location %s", (path) => {
    expect(() =>
      normalizeStrixVulnerabilities(
        bytes([report({ code_locations: [{ file: path, start_line: 1 }] })]),
        2,
      ),
    ).toThrow(/valid Strix v1.5.2 vulnerabilities document/);
  });

  it("bounds source bytes, findings, nested records, and free-form fields", () => {
    expect(() =>
      normalizeStrixVulnerabilities(Buffer.alloc(MAX_STRIX_VULNERABILITIES_BYTES + 1, 0x20), 0),
    ).toThrow(/exceeds/);
    expect(() =>
      normalizeStrixVulnerabilities(
        bytes(Array.from({ length: 257 }, (_, index) => report({ id: `vuln-${index}` }))),
        2,
      ),
    ).toThrow(/valid Strix v1.5.2 vulnerabilities document/);
    expect(() =>
      normalizeStrixVulnerabilities(bytes([report({ title: "x".repeat(241) })]), 2),
    ).toThrow(/valid Strix v1.5.2 vulnerabilities document/);
    expect(() =>
      normalizeStrixVulnerabilities(
        bytes([
          report({
            cvss_breakdown: Object.fromEntries(
              Array.from({ length: 33 }, (_, index) => [`metric${index}`, "value"]),
            ),
          }),
        ]),
        2,
      ),
    ).toThrow(/valid Strix v1.5.2 vulnerabilities document/);
  });

  it("rejects duplicate normalized identities instead of silently collapsing findings", () => {
    expect(() =>
      normalizeStrixVulnerabilities(
        bytes([report({ id: "vuln-0001" }), report({ id: "vuln-0002" })]),
        2,
      ),
    ).toThrow(/duplicate normalized finding fingerprint/);
  });

  it("keeps typed evidence strict and cross-field safe", () => {
    expect(STRIX_INVOCATION_LIMITS).toEqual({
      maxBudgetCents: 1_000,
      maxTurns: 20,
      timeoutMs: 300_000,
    });
    expect(Object.isFrozen(STRIX_INVOCATION_LIMITS)).toBe(true);
    const finding = normalizeStrixVulnerabilities(bytes([report()]), 2).findings[0];
    expect(finding).toBeDefined();
    const evidence = {
      format: "aih-strix-detector-evidence",
      schemaVersion: 1,
      detector: {
        name: "strix",
        repository: "usestrix/strix",
        version: "1.5.2",
        sourceRevision: "597aae67159636ee794a02a3cc1694138d619c44",
      },
      image: {
        repository: "ghcr.io/usestrix/strix-sandbox",
        tag: "1.3.0",
        indexDigest: "sha256:f6906c3114e504fd1a218fcf028d7a0e46851118403a438b63956de6ea7c4331",
        platform: "linux/amd64",
        manifestDigest: "sha256:e5e5d9927f15ca95ad49804ef7d22439771cd27378f400da6edd47556799baff",
      },
      subject: { kind: "local-fixture", treeSha256: "a".repeat(64) },
      invocation: {
        mode: "quick",
        maxBudgetCents: 500,
        maxTurns: 20,
        timeoutMs: 300_000,
        telemetry: "off",
      },
      result: { exitCode: 2, verdict: "findings", findings: [finding] },
    };

    expect(StrixEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(() => StrixEvidenceSchema.parse({ ...evidence, extra: true })).toThrow();
    expect(() =>
      StrixEvidenceSchema.parse({
        ...evidence,
        invocation: { ...evidence.invocation, telemetry: "on" },
      }),
    ).toThrow();
    for (const unsafePath of [
      "../secret",
      "/secret",
      "C:/secret",
      "src\\secret",
      "./src",
      "src//file",
      "src/",
    ]) {
      expect(() =>
        StrixEvidenceSchema.parse({
          ...evidence,
          result: {
            ...evidence.result,
            findings: [{ ...finding, locations: [{ path: unsafePath }] }],
          },
        }),
      ).toThrow();
    }
    expect(() =>
      StrixEvidenceSchema.parse({
        ...evidence,
        result: { exitCode: 0, verdict: "no-findings", findings: [finding] },
      }),
    ).toThrow();
    expect(() =>
      StrixEvidenceSchema.parse({
        ...evidence,
        image: { ...evidence.image, platform: "unknown/unknown" },
      }),
    ).toThrow();
  });
});
