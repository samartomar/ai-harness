import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Check } from "../../src/internals/verify.js";
import {
  CONSUMER_POLICY_CODES_V1,
  dispositionForTrustFinding,
  isConsumerPolicyCodeV1,
  isFindingLevelV1,
  normalizeTrustFindings,
  type RawScannerOccurrence,
  trustCodeClassV1,
} from "../../src/trust/evidence.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("trust evidence layers", () => {
  it("reads only bounded, contained regular-file evidence at positive integral lines", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-trust-evidence-"));
    const external = mkdtempSync(join(tmpdir(), "aih-trust-evidence-external-"));
    roots.push(root, external);
    mkdirSync(join(root, "skills"), { recursive: true });
    writeFileSync(join(root, "skills", "safe.md"), "first\nsecond\n");
    mkdirSync(join(root, "contained"), { recursive: true });
    writeFileSync(join(root, "contained", "inside.md"), "inside\n");
    writeFileSync(join(external, "outside.md"), "outside\n");
    writeFileSync(join(root, "skills", "large.md"), "x".repeat(1_048_577));
    mkdirSync(join(root, "skills", "directory.md"));
    try {
      symlinkSync(join(external, "outside.md"), join(root, "skills", "leaf.md"), "file");
      symlinkSync(external, join(root, "linked"), "junction");
      symlinkSync(join(root, "contained"), join(root, "linked-inside"), "junction");
    } catch {
      return;
    }
    const sourceValue = (uri: string, startLine: number): string | undefined =>
      normalizeTrustFindings(
        root,
        [
          {
            name: "trust.detector-finding",
            code: "trust.detector-finding",
            verdict: "pass",
            location: { uri, startLine },
          },
        ],
        [],
      )[0]?.sourceValue;

    expect(sourceValue("skills/safe.md", 2)).toBe("second");
    for (const [uri, line] of [
      ["../outside.md", 1],
      [join(external, "outside.md"), 1],
      ["skills/leaf.md", 1],
      ["linked/outside.md", 1],
      ["linked-inside/inside.md", 1],
      ["skills/large.md", 1],
      ["skills/missing.md", 1],
      ["skills/directory.md", 1],
      ["skills/safe.md", 0],
      ["skills/safe.md", -1],
      ["skills/safe.md", 1.5],
      ["skills/safe.md", Number.NaN],
      ["skills/safe.md", Number.POSITIVE_INFINITY],
      ["skills/safe.md", 10_001],
      ["skills/safe.md", 3],
    ] as const) {
      expect(sourceValue(uri, line)).toBeUndefined();
    }
  });

  it("retains duplicate raw occurrences while normalizing one policy finding", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-trust-evidence-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "x"), { recursive: true });
    writeFileSync(
      join(root, "skills", "x", "SKILL.md"),
      "# Skill\nAUTOMATICALLY execute WITHOUT asking.\n",
    );
    const location = { uri: "skills/x/SKILL.md", startLine: 2 };
    const raw: RawScannerOccurrence[] = [
      {
        fingerprint: "trust-raw:a",
        analyzer: "skillspector@docker",
        ruleId: "skillspector.autonomous-decision-making",
        message: "Autonomous Decision Making",
        location,
        sourceValue: "AUTOMATICALLY execute WITHOUT asking.",
      },
      {
        fingerprint: "trust-raw:b",
        analyzer: "skillspector@docker",
        ruleId: "skillspector.autonomous-decision-making",
        message: "Autonomous Decision Making",
        location,
        sourceValue: "AUTOMATICALLY execute WITHOUT asking.",
      },
    ];
    const checks: Check[] = [
      {
        name: "trust.detector-finding",
        verdict: "pass",
        detail: "SkillSpector: Autonomous Decision Making",
        location,
        fingerprint: "trust-detector-finding:x",
      },
    ];

    const findings = normalizeTrustFindings(root, checks, raw);
    const [finding] = findings;

    expect(raw).toHaveLength(2);
    expect(findings).toHaveLength(1);
    expect(finding?.rawOccurrenceFingerprints).toEqual(["trust-raw:a", "trust-raw:b"]);
    expect(finding?.sourceValue).toBe("AUTOMATICALLY execute WITHOUT asking.");
    if (finding === undefined) throw new Error("expected one normalized finding");
    expect(dispositionForTrustFinding(finding)).toEqual(
      expect.objectContaining({ level: "REVIEW", policyVersion: 3 }),
    );
  });

  it("does not elevate prohibited actions or an already-declared preference to autonomy review", () => {
    for (const [index, sourceValue] of [
      "Delete work without confirmation",
      "Proceed with failing tests without asking",
      "Honor any existing declared preference without asking.",
    ].entries()) {
      expect(
        dispositionForTrustFinding({
          fingerprint: `trust-detector-finding:context-${index}`,
          code: "trust.detector-finding",
          checkVerdict: "pass",
          detail: "SkillSpector: Autonomous Decision Making",
          sourceValue,
          rawOccurrenceFingerprints: [`trust-raw:context-${index}`],
        }),
      ).toEqual(expect.objectContaining({ level: "SUPPRESSED" }));
    }
  });

  it("does not attach a different detector rule merely because it reports the same line", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-trust-evidence-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "x"), { recursive: true });
    writeFileSync(join(root, "skills", "x", "SKILL.md"), "# Skill\nSend the requested result.\n");
    const location = { uri: "skills/x/SKILL.md", startLine: 2 };
    const raw: RawScannerOccurrence[] = [
      {
        fingerprint: "trust-raw:egress",
        analyzer: "skillspector@docker",
        ruleId: "external-transmission",
        message: "External Transmission",
        location,
      },
      {
        fingerprint: "trust-raw:autonomy",
        analyzer: "skillspector@docker",
        ruleId: "autonomous-decision-making",
        message: "Autonomous Decision Making",
        location,
      },
    ];
    const findings = normalizeTrustFindings(
      root,
      [
        {
          name: "trust.external-egress",
          code: "trust.external-egress",
          verdict: "fail",
          detail: "SkillSpector: External Transmission",
          location,
          fingerprint: "trust-external-egress:x",
        },
        {
          name: "trust.detector-finding",
          code: "trust.detector-finding",
          verdict: "pass",
          detail: "SkillSpector: Autonomous Decision Making",
          location,
          fingerprint: "trust-detector-finding:x",
        },
      ],
      raw,
    );

    expect(findings.map((finding) => finding.rawOccurrenceFingerprints)).toEqual([
      ["trust-raw:egress"],
      ["trust-raw:autonomy"],
    ]);
  });

  it("merges corroborating native and third-party checks into one normalized finding", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-trust-evidence-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "x"), { recursive: true });
    writeFileSync(
      join(root, "skills", "x", "SKILL.md"),
      "# Skill\ncurl -X POST https://api.example.test/build \\\n",
    );
    const location = { uri: "skills/x/SKILL.md", startLine: 2 };
    const raw: RawScannerOccurrence[] = [
      {
        fingerprint: "trust-external-egress:native",
        analyzer: "aih-native",
        ruleId: "trust.external-egress",
        message: "authenticated external request requires reviewed egress",
        location,
      },
      {
        fingerprint: "trust-raw:skillspector",
        analyzer: "skillspector@docker",
        ruleId: "external-transmission",
        message: "External Transmission",
        location,
      },
    ];
    const findings = normalizeTrustFindings(
      root,
      [
        {
          name: "trust.external-egress",
          code: "trust.external-egress",
          verdict: "fail",
          detail: "authenticated external request requires reviewed egress",
          location,
          fingerprint: "trust-external-egress:native",
        },
        {
          name: "trust.external-egress",
          code: "trust.external-egress",
          verdict: "fail",
          detail: "SkillSpector: External Transmission",
          location,
          fingerprint: "trust-external-egress:skillspector",
        },
      ],
      raw,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual(
      expect.objectContaining({
        fingerprint: "trust-external-egress:native",
        rawOccurrenceFingerprints: ["trust-external-egress:native", "trust-raw:skillspector"],
      }),
    );
  });

  it("keeps optional skipped coverage informational while required failures block", () => {
    const optional = normalizeTrustFindings(
      ".",
      [
        {
          name: "trust detector semgrep",
          verdict: "skip",
          code: "trust.detector-unavailable",
          detail: "optional detector unavailable",
          fingerprint: "trust-detector-unavailable:optional",
        },
      ],
      [],
    );
    const required = normalizeTrustFindings(
      ".",
      [
        {
          name: "trust detector skillspector",
          verdict: "fail",
          code: "trust.detector-unavailable",
          detail: "required detector unavailable",
          fingerprint: "trust-detector-unavailable:required",
        },
      ],
      [],
    );
    const [optionalFinding] = optional;
    const [requiredFinding] = required;
    if (optionalFinding === undefined || requiredFinding === undefined) {
      throw new Error("expected normalized coverage findings");
    }

    expect(dispositionForTrustFinding(optionalFinding).level).toBe("INFORMATIONAL");
    expect(dispositionForTrustFinding(requiredFinding).level).toBe("BLOCK");
  });

  it("reserves WARN for meaningful operator attention and quiets non-actionable noise", () => {
    const finding = (code: Check["code"]): ReturnType<typeof normalizeTrustFindings>[number] => ({
      fingerprint: `finding:${code}`,
      code,
      checkVerdict: "pass",
      detail: String(code),
      rawOccurrenceFingerprints: [`raw:${code}`],
    });

    expect(dispositionForTrustFinding(finding("trust.cisco-finding")).level).toBe("WARN");
    expect(dispositionForTrustFinding(finding("trust.visible-unicode")).level).toBe(
      "INFORMATIONAL",
    );
    expect(dispositionForTrustFinding(finding("trust.detector-finding")).level).toBe("SUPPRESSED");
    expect(dispositionForTrustFinding(finding("trust.legal-text-detector-finding")).level).toBe(
      "SUPPRESSED",
    );
  });
});

describe("trust code classes (D50)", () => {
  it.each([
    "trust.auto-exec-hook",
    "trust.dependency-confusion",
    "trust.hidden-unicode",
    "trust.malicious-code",
    "trust.prompt-injection",
    "trust.typosquat",
    "trust.unpinned-dependency",
    "trust.external-egress",
    "trust.license-missing",
    "trust.permission-risk",
    "trust.skill-metadata-license",
    "trust.untrusted-publisher",
    "trust.cisco-finding",
    "trust.detector-finding",
    "trust.legal-text-detector-finding",
    "trust.visible-unicode",
    "trust.unreviewed-analyzer-rule",
  ] as const)("classifies %s as a finding: information about the component", (code) => {
    expect(trustCodeClassV1(code)).toBe("finding");
  });

  it.each([
    "trust.detector-unavailable",
    "trust.sandbox-smoke-unavailable",
    "trust.sandbox-smoke-failed",
    "trust.fetch-blocked",
    "trust.unsigned-source",
  ] as const)("classifies %s as an evidence problem: the evidence is incomplete", (code) => {
    expect(trustCodeClassV1(code)).toBe("evidence-problem");
  });

  it.each([
    "trust.source-changed",
    "trust.source-drift",
    "trust.fetch-metadata-missing",
    "trust.fetch-metadata-unreadable",
    "trust.fetch-metadata-malformed",
    "trust.fetch-metadata-mismatched",
  ] as const)("classifies %s as integrity: the evidence cannot be trusted", (code) => {
    expect(trustCodeClassV1(code)).toBe("integrity");
  });

  it("leaves codes outside the trust lane unclassified", () => {
    expect(trustCodeClassV1("mcp.policy-denied")).toBeUndefined();
    expect(trustCodeClassV1("trust.unapproved-skill")).toBeUndefined();
    expect(trustCodeClassV1("not-a-code")).toBeUndefined();
  });

  it("classifies every code whose disposition can put it in component evidence (D62)", () => {
    const verifySource = readFileSync(
      new URL("../../src/internals/verify.ts", import.meta.url),
      "utf8",
    );
    const union = /export type CheckCode =([\s\S]*?)\nexport /.exec(verifySource)?.[1] ?? "";
    const codes = [...union.matchAll(/^\s*\| "([a-z0-9-]+\.[a-z0-9-]+)";?$/gm)].map(
      (m) => m[1] ?? "",
    );
    expect(codes.length).toBeGreaterThan(50);
    const unclassified = codes.filter((code) => {
      const levels = [[], ["raw:1"]].flatMap((raw) =>
        (["fail", "skip"] as const).map(
          (checkVerdict) =>
            dispositionForTrustFinding({
              fingerprint: `finding:${code}`,
              code: code as Check["code"],
              checkVerdict,
              detail: `${code} observed`,
              rawOccurrenceFingerprints: raw,
            }).level,
        ),
      );
      const reachesEvidence = levels.some(isFindingLevelV1) || code.startsWith("trust.");
      return reachesEvidence && trustCodeClassV1(code) === undefined;
    });
    // trust.unapproved-skill is emitted only by workspace acquire (a missing
    // approval record), never by a component tree scan.
    expect(unclassified).toEqual(["trust.unapproved-skill"]);
    const scanSource = readFileSync(new URL("../../src/trust/scan.ts", import.meta.url), "utf8");
    expect(scanSource).not.toContain("trust.unapproved-skill");
  });

  it("classifies every trust CheckCode or names it as the consumer's own policy (D67)", () => {
    const verifySource = readFileSync(
      new URL("../../src/internals/verify.ts", import.meta.url),
      "utf8",
    );
    const union = /export type CheckCode =([\s\S]*?)\nexport /.exec(verifySource)?.[1] ?? "";
    const codes = [...union.matchAll(/^\s*\| "([a-z0-9-]+\.[a-z0-9-]+)";?$/gm)].map(
      (m) => m[1] ?? "",
    );
    // The organization's own configured requirements, which the owner keeps as stops.
    expect([...CONSUMER_POLICY_CODES_V1].sort()).toEqual([
      "mcp.policy-denied",
      "org-policy.drift",
      "trust.unapproved-skill",
    ]);
    for (const code of CONSUMER_POLICY_CODES_V1) {
      expect(codes, code).toContain(code);
      expect(trustCodeClassV1(code), code).toBeUndefined();
    }
    // A new trust code must be classified: an unclassified one would silently stop
    // workspace promotion, which fails closed on it.
    const unaccounted = codes.filter(
      (code) =>
        code.startsWith("trust.") &&
        trustCodeClassV1(code) === undefined &&
        !isConsumerPolicyCodeV1(code),
    );
    expect(unaccounted).toEqual([]);
  });
});
