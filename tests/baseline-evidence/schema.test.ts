import { describe, expect, it } from "vitest";
import { parseBaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";

function component(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "skill:verification-loop",
    paths: ["skills/verification-loop"],
    treeSha256: "a".repeat(64),
    verdict: "no-findings",
    analyzers: [{ name: "aih-native", version: "2.7.0" }],
    findings: [],
    evidenceProblems: [],
    ...over,
  };
}

function lock(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    sources: [
      {
        id: "ecc",
        owner: "affaan-m",
        repo: "ECC",
        pinnedSha: "b".repeat(40),
        components: [component()],
      },
    ],
    ...over,
  };
}

describe("baseline evidence lock schema", () => {
  it("parses exact source pins and strict component receipts", () => {
    expect(parseBaselineEvidenceLock(lock())).toMatchObject({
      schemaVersion: 2,
      sources: [
        {
          id: "ecc",
          pinnedSha: "b".repeat(40),
          components: [
            { id: "skill:verification-loop", verdict: "no-findings", evidenceProblems: [] },
          ],
        },
      ],
    });
  });

  it.each([
    ["short source pin", { pinnedSha: "deadbeef" }],
    ["unsafe component id", { components: [component({ id: "../../escape" })] }],
    ["absolute component path", { components: [component({ paths: ["/tmp/escape"] })] }],
    ["parent component path", { components: [component({ paths: ["skills/../escape"] })] }],
    ["backslash component path", { components: [component({ paths: ["skills\\escape"] })] }],
    ["unknown component key", { components: [component({ surprise: true })] }],
  ])("rejects %s", (_label, sourceOverride) => {
    const value = lock({
      sources: [
        {
          id: "ecc",
          owner: "affaan-m",
          repo: "ECC",
          pinnedSha: "b".repeat(40),
          components: [component()],
          ...sourceOverride,
        },
      ],
    });
    expect(() => parseBaselineEvidenceLock(value)).toThrow();
  });

  function withComponent(over: Record<string, unknown>): Record<string, unknown> {
    return lock({
      sources: [
        {
          id: "ecc",
          owner: "affaan-m",
          repo: "ECC",
          pinnedSha: "b".repeat(40),
          components: [component(over)],
        },
      ],
    });
  }

  const egress = {
    code: "trust.external-egress",
    detail: "REVIEW: SKILL.md:3 — curl https://api.example.test",
    fingerprint: "trust-raw:egress",
  };

  it("labels a component that carries findings as has-findings and keeps every finding", () => {
    const parsed = parseBaselineEvidenceLock(
      withComponent({ verdict: "has-findings", findings: [egress] }),
    );
    expect(parsed.sources[0]?.components[0]).toMatchObject({
      verdict: "has-findings",
      findings: [egress],
      evidenceProblems: [],
    });
  });

  it("refuses contradictory evidence: the verdict must match the findings it carries", () => {
    expect(() =>
      parseBaselineEvidenceLock(withComponent({ verdict: "has-findings", findings: [] })),
    ).toThrow(/has-findings/);
    expect(() =>
      parseBaselineEvidenceLock(withComponent({ verdict: "no-findings", findings: [egress] })),
    ).toThrow(/no-findings/);
  });

  it("keeps evidence problems in their own label, separate from findings", () => {
    const unavailable = {
      code: "trust.detector-unavailable",
      detail: "required detector skillspector unavailable",
    };
    const parsed = parseBaselineEvidenceLock(withComponent({ evidenceProblems: [unavailable] }));
    expect(parsed.sources[0]?.components[0]).toMatchObject({
      verdict: "no-findings",
      findings: [],
      evidenceProblems: [unavailable],
    });
    expect(() =>
      parseBaselineEvidenceLock(
        withComponent({ verdict: "has-findings", findings: [unavailable] }),
      ),
    ).toThrow(/evidence problem/);
    expect(() => parseBaselineEvidenceLock(withComponent({ evidenceProblems: [egress] }))).toThrow(
      /evidence problem/,
    );
  });

  it("never stores an integrity failure as a finding or an evidence problem", () => {
    const drift = { code: "trust.source-drift", detail: "ref moved" };
    expect(() =>
      parseBaselineEvidenceLock(withComponent({ verdict: "has-findings", findings: [drift] })),
    ).toThrow(/integrity/);
    expect(() => parseBaselineEvidenceLock(withComponent({ evidenceProblems: [drift] }))).toThrow(
      /integrity|evidence problem/,
    );
  });

  it.each([
    ["the retired pass verdict", { verdict: "pass" }],
    ["the retired blocked verdict", { verdict: "blocked", findings: [egress] }],
    ["a component without its evidence-problem label", { evidenceProblems: undefined }],
  ])("rejects %s", (_label, over) => {
    expect(() => parseBaselineEvidenceLock(withComponent(over))).toThrow();
  });

  it("has no reader for schema version 1", () => {
    expect(() => parseBaselineEvidenceLock(lock({ schemaVersion: 1 }))).toThrow();
  });

  it("rejects duplicate source and component identities", () => {
    const source = (lock().sources as unknown[])[0];
    expect(() => parseBaselineEvidenceLock(lock({ sources: [source, source] }))).toThrow(
      /duplicate/i,
    );

    const duplicateComponent = lock({
      sources: [
        {
          id: "ecc",
          owner: "affaan-m",
          repo: "ECC",
          pinnedSha: "b".repeat(40),
          components: [component(), component()],
        },
      ],
    });
    expect(() => parseBaselineEvidenceLock(duplicateComponent)).toThrow(/duplicate/i);
  });
});
