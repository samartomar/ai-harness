import { describe, expect, it } from "vitest";
import { parseBaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";

function component(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "skill:verification-loop",
    paths: ["skills/verification-loop"],
    treeSha256: "a".repeat(64),
    verdict: "pass",
    analyzers: [{ name: "aih-native", version: "2.7.0" }],
    findings: [],
    ...over,
  };
}

function lock(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
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
      schemaVersion: 1,
      sources: [
        {
          id: "ecc",
          pinnedSha: "b".repeat(40),
          components: [{ id: "skill:verification-loop", verdict: "pass" }],
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

  it("requires blocked entries to retain the danger finding that caused the denial", () => {
    const blocked = lock({
      sources: [
        {
          id: "ecc",
          owner: "affaan-m",
          repo: "ECC",
          pinnedSha: "b".repeat(40),
          components: [component({ verdict: "blocked", findings: [] })],
        },
      ],
    });
    expect(() => parseBaselineEvidenceLock(blocked)).toThrow(/blocked/i);

    const withFinding = structuredClone(blocked);
    const sources = withFinding.sources as Array<Record<string, unknown>>;
    const components = sources[0]?.components as Array<Record<string, unknown>>;
    components[0] = component({
      verdict: "blocked",
      findings: [
        {
          code: "trust.hidden-unicode",
          detail: "instruction surface contains non-ASCII typography",
          fingerprint: "trust-hidden-unicode:skill:abc123",
        },
      ],
    });
    expect(parseBaselineEvidenceLock(withFinding).sources[0]?.components[0]?.verdict).toBe(
      "blocked",
    );
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
