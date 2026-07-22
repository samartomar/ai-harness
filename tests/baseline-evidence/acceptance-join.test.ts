import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AcceptanceDecision,
  acceptanceRecordSha256,
  acceptanceResolutionMismatches,
  matchComponentAcceptance,
  readAcceptanceDecisions,
  UNWAIVABLE_FINDING_CODES,
} from "../../src/baseline-evidence/acceptance.js";
import artifactJson from "../../src/baseline-evidence/acceptance-decisions.json";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import { parseBaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";
import { verifyBaselineComponents } from "../../src/baseline-evidence/verify.js";

// W4 maintainer ruling (e): the accepted-with-conditions policy join. Raw vet
// verdicts are never rewritten; a blocked component is admitted only through
// an exact signed acceptance; everything else stays held.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-acceptance-join-"));
  mkdirSync(join(root, "skills", "risky"), { recursive: true });
  writeFileSync(join(root, "skills", "risky", "SKILL.md"), "# Risky but reviewed\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const PIN = "a".repeat(40);
const CODES = ["trust.hidden-unicode", "trust.prompt-injection"];

function subtreeHash(): string {
  return hashComponentTree(root, ["skills/risky"]).treeSha256;
}

function catalog() {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: PIN,
    components: [{ id: "skill:risky", paths: ["skills/risky"] }],
  });
}

function blockedLock(hash = subtreeHash()) {
  return parseBaselineEvidenceLock({
    schemaVersion: 1,
    sources: [
      {
        id: "ecc",
        owner: "affaan-m",
        repo: "ECC",
        pinnedSha: PIN,
        components: [
          {
            id: "skill:risky",
            paths: ["skills/risky"],
            treeSha256: hash,
            verdict: "blocked",
            analyzers: [{ name: "aih-native", version: "2.7.0" }],
            findings: CODES.map((code) => ({ code, detail: `${code} present` })),
          },
        ],
      },
    ],
  });
}

function signedDecision(over: Partial<AcceptanceDecision> = {}): AcceptanceDecision {
  const base: AcceptanceDecision = {
    decisionId: "test-decision-1",
    decision: "accepted-with-conditions",
    owner: "maintainer:test",
    policyVersion: 1,
    framework: "ecc",
    profile: "ecc-lean-v1",
    host: "claude",
    adapter: "ecc-lean",
    repository: "affaan-m/ECC",
    commitSha: PIN,
    treeDigest: "b".repeat(64),
    residualRisk: "reviewed content findings on the pinned tuple",
    components: [
      {
        evidenceComponentId: "skill:risky",
        treeSha256: subtreeHash(),
        acceptedFindingCodes: [...CODES],
      },
    ],
    recordSha256: "0".repeat(64),
    ...over,
  };
  return { ...base, recordSha256: acceptanceRecordSha256(base) };
}

function verify(decisions: AcceptanceDecision[], lock = blockedLock()) {
  return verifyBaselineComponents({
    sourceRoot: root,
    catalog: catalog(),
    componentIds: ["skill:risky"],
    posture: "vibe",
    vendorLock: lock,
    vendorLockSha256: "c".repeat(64),
    acceptanceDecisions: decisions,
  });
}

describe("accepted-with-conditions policy join (W4 ruling (e))", () => {
  it("keeps a signed vet pass installable with no acceptance involved", () => {
    const lock = parseBaselineEvidenceLock({
      schemaVersion: 1,
      sources: [
        {
          id: "ecc",
          owner: "affaan-m",
          repo: "ECC",
          pinnedSha: PIN,
          components: [
            {
              id: "skill:risky",
              paths: ["skills/risky"],
              treeSha256: subtreeHash(),
              verdict: "pass",
              analyzers: [{ name: "aih-native", version: "2.7.0" }],
              findings: [],
            },
          ],
        },
      ],
    });
    const result = verify([], lock);
    expect(result.authorizations).toHaveLength(1);
    expect(result.authorizations[0]?.effective).toBeUndefined();
    expect(result.held).toHaveLength(0);
  });

  it("holds a blocked component when no acceptance is shipped", () => {
    const result = verify([]);
    expect(result.authorizations).toHaveLength(0);
    expect(result.held.map((entry) => entry.componentId)).toEqual(["skill:risky"]);
  });

  it("admits a blocked component through an exact signed acceptance, preserving both facts", () => {
    const result = verify([signedDecision()]);
    expect(result.held).toHaveLength(0);
    const authorization = result.authorizations[0];
    expect(authorization?.effective).toBe("accepted-with-conditions");
    expect(authorization?.acceptance?.decisionId).toBe("test-decision-1");
    const check = result.checks.find((entry) => entry.name.includes("skill:risky"));
    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("BLOCKED");
    expect(check?.detail).toContain("accepted-with-conditions");
    expect(check?.detail).not.toMatch(/vet pass\b/i);
  });

  it("holds on a commit/pin mismatch", () => {
    const result = verify([signedDecision({ commitSha: "f".repeat(40) })]);
    expect(result.authorizations).toHaveLength(0);
  });

  it("holds on a repository mismatch", () => {
    const result = verify([signedDecision({ repository: "someone-else/ECC" })]);
    expect(result.authorizations).toHaveLength(0);
  });

  it("holds on a component tree-digest mismatch (content-pinned)", () => {
    const decision = signedDecision();
    const tampered = {
      ...decision,
      components: [{ ...decision.components[0]!, treeSha256: "d".repeat(64) }],
    };
    const result = verify([{ ...tampered, recordSha256: acceptanceRecordSha256(tampered) }]);
    expect(result.authorizations).toHaveLength(0);
  });

  it("holds when the component is missing from the acceptance", () => {
    const decision = signedDecision();
    const other = {
      ...decision,
      components: [{ ...decision.components[0]!, evidenceComponentId: "skill:other" }],
    };
    const result = verify([{ ...other, recordSha256: acceptanceRecordSha256(other) }]);
    expect(result.authorizations).toHaveLength(0);
  });

  it("holds when the evidence carries a finding code the acceptance does not list", () => {
    const decision = signedDecision();
    const narrower = {
      ...decision,
      components: [{ ...decision.components[0]!, acceptedFindingCodes: ["trust.hidden-unicode"] }],
    };
    const result = verify([{ ...narrower, recordSha256: acceptanceRecordSha256(narrower) }]);
    expect(result.authorizations).toHaveLength(0);
  });

  it("ignores an unsigned decision (record digest mismatch)", () => {
    const unsigned = { ...signedDecision(), recordSha256: "9".repeat(64) };
    const result = verify([unsigned]);
    expect(result.authorizations).toHaveLength(0);
  });

  it("holds when the decision is expired", () => {
    const decision = signedDecision({ expiresAt: "2020-01-01T00:00:00.000Z" });
    const result = verify([decision]);
    expect(result.authorizations).toHaveLength(0);
  });

  it("never admits an unwaivable finding code, even when the decision lists it", () => {
    const match = matchComponentAcceptance(
      [
        (() => {
          const decision = signedDecision();
          const widened = {
            ...decision,
            components: [
              {
                ...decision.components[0]!,
                acceptedFindingCodes: [...CODES, "trust.auto-exec-hook"],
              },
            ],
          };
          return { ...widened, recordSha256: acceptanceRecordSha256(widened) };
        })(),
      ],
      {
        framework: "ecc",
        repository: "affaan-m/ECC",
        commitSha: PIN,
        componentId: "skill:risky",
        componentTreeSha256: subtreeHash(),
        findingCodes: [...CODES, "trust.auto-exec-hook"],
      },
    );
    expect(match).toBeUndefined();
  });

  it("never lets a decision for another profile authorize this tuple", () => {
    const fullProfile = signedDecision({ profile: "ecc-full-v1" });
    const match = matchComponentAcceptance(
      [fullProfile],
      {
        framework: "ecc",
        repository: "affaan-m/ECC",
        commitSha: PIN,
        componentId: "skill:risky",
        componentTreeSha256: subtreeHash(),
        findingCodes: CODES,
      },
      new Date(),
      { framework: "ecc", profile: "ecc-lean-v1", host: "claude", adapter: "ecc-lean" },
    );
    expect(match).toBeUndefined();
  });
});

describe("acceptanceResolutionMismatches (live-composition binding)", () => {
  it("is empty only on an exact repository/commit/treeDigest match", () => {
    const decision = signedDecision();
    expect(
      acceptanceResolutionMismatches(decision, {
        repository: "affaan-m/ECC",
        commitSha: PIN,
        treeDigest: "b".repeat(64),
      }),
    ).toEqual([]);
  });

  it("names a wrong whole-tree digest (blocks the live composition)", () => {
    const decision = signedDecision();
    const mismatches = acceptanceResolutionMismatches(decision, {
      repository: "affaan-m/ECC",
      commitSha: PIN,
      treeDigest: "e".repeat(64),
    });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain("treeDigest");
  });

  it("names a wrong source commit", () => {
    const decision = signedDecision();
    const mismatches = acceptanceResolutionMismatches(decision, {
      repository: "affaan-m/ECC",
      commitSha: "f".repeat(40),
      treeDigest: "b".repeat(64),
    });
    expect(mismatches.some((entry) => entry.includes("commitSha"))).toBe(true);
  });
});

describe("shipped acceptance artifact", () => {
  it("is schema-valid, signed, and lists no unwaivable code", () => {
    // Assert against the RAW artifact so an unsigned shipped decision fails
    // loudly here (readAcceptanceDecisions would silently exclude it).
    const raw = artifactJson as {
      decisions: Array<AcceptanceDecision>;
    };
    expect(raw.decisions.length).toBeGreaterThan(0);
    for (const decision of raw.decisions) {
      expect(decision.recordSha256).toBe(acceptanceRecordSha256(decision));
      for (const component of decision.components) {
        for (const code of component.acceptedFindingCodes) {
          expect(UNWAIVABLE_FINDING_CODES.has(code)).toBe(false);
        }
      }
    }
    expect(readAcceptanceDecisions().length).toBe(raw.decisions.length);
  });

  it("pins the ECC Lean tuple exactly", () => {
    const lean = readAcceptanceDecisions().find((d) => d.profile === "ecc-lean-v1");
    expect(lean?.framework).toBe("ecc");
    expect(lean?.host).toBe("claude");
    expect(lean?.adapter).toBe("ecc-lean");
    expect(lean?.repository).toBe("samartomar/ECC");
    expect(lean?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(createHash("sha256")).toBeDefined();
  });
});
