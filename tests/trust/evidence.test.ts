import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Check } from "../../src/internals/verify.js";
import {
  dispositionForTrustFinding,
  normalizeTrustFindings,
  type RawScannerOccurrence,
} from "../../src/trust/evidence.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("trust evidence layers", () => {
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
