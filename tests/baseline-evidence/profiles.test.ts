import { describe, expect, it } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import {
  ECC_LEAN_EVIDENCE_COMPONENTS,
  ECC_LEAN_PROFILE_ID,
  ECC_UPSTREAM_CORE_EVIDENCE_COMPONENTS,
  ECC_UPSTREAM_CORE_PROFILE_ID,
  ECC_UPSTREAM_FULL_PROFILE_ID,
  qualificationProfile,
  qualifyActiveProfile,
} from "../../src/baseline-evidence/profiles.js";
import type { NormalizedTrustFinding, TrustPolicyDisposition } from "../../src/trust/evidence.js";

function finding(
  fingerprint: string,
  code: NormalizedTrustFinding["code"],
  path: string,
  line: number,
  value: string,
): NormalizedTrustFinding {
  return {
    fingerprint,
    code,
    detail: `${code} at ${path}:${line}`,
    location: { uri: path, startLine: line },
    sourceValue: value,
    rawOccurrenceFingerprints: [`raw:${fingerprint}`],
  };
}

function disposition(
  fingerprint: string,
  level: TrustPolicyDisposition["level"],
): TrustPolicyDisposition {
  return { findingFingerprint: fingerprint, level, reason: level, policyVersion: 3 };
}

describe("active baseline qualification profiles", () => {
  it("distinguishes AIH's curated Lean closure from ECC's upstream core flag", () => {
    const catalog = baselineCatalogById("ecc");
    const lean = qualificationProfile(catalog, ECC_LEAN_PROFILE_ID);
    const core = qualificationProfile(catalog, ECC_UPSTREAM_CORE_PROFILE_ID);
    const full = qualificationProfile(catalog, ECC_UPSTREAM_FULL_PROFILE_ID);

    expect(lean.origin).toBe("AIH_CURATED");
    expect(lean.selectedComponentIds).toEqual(ECC_LEAN_EVIDENCE_COMPONENTS);
    expect(core.origin).toBe("UPSTREAM");
    expect(core.selectedComponentIds).toEqual(ECC_UPSTREAM_CORE_EVIDENCE_COMPONENTS);
    expect(core.selectedComponentIds).toContain("module:hooks-runtime");
    expect(core.selectedComponentIds).toContain("module:agents-core");
    expect(full.origin).toBe("UPSTREAM");
    expect(full.selectedComponentIds).toEqual(catalog.components.map((component) => component.id));
  });

  it("does not let an unselected component block ECC Lean", () => {
    const catalog = baselineCatalogById("ecc");
    const profile = qualificationProfile(catalog, ECC_LEAN_PROFILE_ID);
    const evidence = catalog.components.map((component) => {
      const selected = profile.selectedComponentIds.includes(component.id);
      const fp = `finding:${component.id}`;
      return {
        id: component.id,
        findings: selected
          ? []
          : [finding(fp, "trust.malicious-code", "unselected/install.sh", 7, "curl x | sh")],
        dispositions: selected ? [] : [disposition(fp, "BLOCK")],
      };
    });

    const result = qualifyActiveProfile(catalog, profile, evidence);

    expect(result.verdict).toBe("PASS");
    expect(result.componentCounts).toEqual({ pass: 10, review: 0, block: 0 });
    expect(result.inventory.find((component) => component.id === "runtime:ecc-kiro")).toEqual({
      id: "runtime:ecc-kiro",
      discovery: "DISCOVERED",
      selection: "NOT SELECTED",
      authorization: "NOT AUTHORIZED",
      installation: "NOT INSTALLED",
    });
  });

  it("reports the exact line and value for a selected review finding", () => {
    const catalog = baselineCatalogById("ecc");
    const profile = qualificationProfile(catalog, ECC_LEAN_PROFILE_ID);
    const evidence = catalog.components.map((component) => {
      const fp = `finding:${component.id}`;
      const selectedReview = component.id === "skill:security-review";
      return {
        id: component.id,
        findings: selectedReview
          ? [
              finding(
                fp,
                "trust.external-egress",
                "skills/security-review/SKILL.md",
                42,
                "curl https://api.example.test",
              ),
            ]
          : [],
        dispositions: selectedReview ? [disposition(fp, "REVIEW")] : [],
      };
    });

    const result = qualifyActiveProfile(catalog, profile, evidence);

    expect(result.verdict).toBe("REVIEW");
    expect(result.genuineReasons).toEqual([
      expect.objectContaining({
        componentId: "skill:security-review",
        path: "skills/security-review/SKILL.md",
        line: 42,
        value: "curl https://api.example.test",
      }),
    ]);
  });

  it("makes a selected executable danger block the active profile", () => {
    const catalog = baselineCatalogById("ecc");
    const profile = qualificationProfile(catalog, ECC_LEAN_PROFILE_ID);
    const evidence = profile.selectedComponentIds.map((id) => {
      const selectedBlock = id === "runtime:ecc-installer";
      const fp = `finding:${id}`;
      return {
        id,
        findings: selectedBlock
          ? [finding(fp, "trust.malicious-code", "scripts/install.js", 9, "curl x | sh")]
          : [],
        dispositions: selectedBlock ? [disposition(fp, "BLOCK")] : [],
      };
    });

    const result = qualifyActiveProfile(catalog, profile, evidence);

    expect(result.verdict).toBe("BLOCK");
    expect(result.componentCounts).toEqual({ pass: 9, review: 0, block: 1 });
    expect(result.findingCounts).toEqual({ warn: 0, review: 0, block: 1 });
    expect(result.genuineReasons[0]).toEqual(
      expect.objectContaining({
        componentId: "runtime:ecc-installer",
        level: "BLOCK",
        path: "scripts/install.js",
        line: 9,
        value: "curl x | sh",
      }),
    );
  });

  it("fails closed on incomplete, duplicate, stale, or contradictory qualification evidence", () => {
    const catalog = baselineCatalogById("ecc");
    const profile = qualificationProfile(catalog, ECC_LEAN_PROFILE_ID);
    const emptyEvidence = profile.selectedComponentIds.map((id) => ({
      id,
      findings: [],
      dispositions: [],
    }));
    const first = profile.selectedComponentIds[0] as string;
    const firstEvidence = emptyEvidence[0];
    if (firstEvidence === undefined) throw new Error("Lean profile must select a component");
    const fp = `finding:${first}`;
    const blockedFinding = finding(
      fp,
      "trust.malicious-code",
      "scripts/install.js",
      9,
      "curl x | sh",
    );

    expect(() => qualifyActiveProfile(catalog, profile, [])).toThrow(
      /evidence missing selected components/,
    );
    expect(() => qualifyActiveProfile(catalog, profile, [...emptyEvidence, firstEvidence])).toThrow(
      /duplicate active profile component evidence/,
    );
    expect(() =>
      qualifyActiveProfile(catalog, profile, [
        {
          id: first,
          findings: [blockedFinding, blockedFinding],
          dispositions: [disposition(fp, "BLOCK")],
        },
        ...emptyEvidence.slice(1),
      ]),
    ).toThrow(/duplicate normalized finding fingerprint/);
    expect(() =>
      qualifyActiveProfile(catalog, profile, [
        {
          id: first,
          findings: [blockedFinding],
          dispositions: [{ ...disposition(fp, "BLOCK"), policyVersion: 2 }],
        },
        ...emptyEvidence.slice(1),
      ]),
    ).toThrow(/stale trust policy disposition/);
    expect(() =>
      qualifyActiveProfile(catalog, profile, [
        {
          id: first,
          findings: [blockedFinding],
          dispositions: [disposition(fp, "BLOCK"), disposition(fp, "BLOCK")],
        },
        ...emptyEvidence.slice(1),
      ]),
    ).toThrow(/duplicate policy disposition fingerprint/);
    expect(() =>
      qualifyActiveProfile(catalog, profile, [
        { id: first, findings: [blockedFinding], dispositions: [] },
        ...emptyEvidence.slice(1),
      ]),
    ).toThrow(/no policy disposition/);
    expect(() =>
      qualifyActiveProfile(catalog, profile, [
        {
          id: first,
          findings: [blockedFinding],
          dispositions: [disposition(fp, "WARN")],
        },
        ...emptyEvidence.slice(1),
      ]),
    ).toThrow(/contradicts current policy/);
    expect(() =>
      qualifyActiveProfile(catalog, profile, [
        {
          id: first,
          findings: [],
          dispositions: [disposition("orphan", "WARN")],
        },
        ...emptyEvidence.slice(1),
      ]),
    ).toThrow(/no normalized finding/);
  });
});
