import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AcceptanceDecision,
  acceptanceRecordSha256,
  acceptanceResolutionMismatches,
  CORRECTED_ACCEPTANCE_POLICY_VERSION,
  matchComponentAcceptance,
  matchCorrectedComponentAcceptance,
  readAcceptanceDecisions,
} from "../../src/baseline-evidence/acceptance.js";
import artifactJson from "../../src/baseline-evidence/acceptance-decisions.json";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import { parseBaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";
import { verifyBaselineComponents } from "../../src/baseline-evidence/verify.js";
import { TRUST_POLICY_VERSION } from "../../src/trust/evidence.js";

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
const CODES = ["trust.external-egress", "trust.permission-risk"];

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
            findings: CODES.map((code) => ({
              code,
              detail: `${code} present`,
              fingerprint: `finding:${code}`,
              fingerprints: [`finding:${code}`],
            })),
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
  if (base.policyVersion === CORRECTED_ACCEPTANCE_POLICY_VERSION) {
    base.trustPolicyVersion = TRUST_POLICY_VERSION;
  }
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
    acceptanceTuple: {
      framework: "ecc",
      profile: "ecc-lean-v1",
      host: "claude",
      adapter: "ecc-lean",
    },
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

  it("does not let a legacy code-only acceptance authorize corrected-policy evidence", () => {
    const result = verify([signedDecision()]);
    expect(result.authorizations).toHaveLength(0);
    expect(result.held.map((entry) => entry.componentId)).toEqual(["skill:risky"]);
    const check = result.checks.find((entry) => entry.name.includes("skill:risky"));
    expect(check?.verdict).toBe("fail");
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
    const [component] = decision.components;
    if (component === undefined) throw new Error("expected an acceptance component");
    const tampered = {
      ...decision,
      components: [{ ...component, treeSha256: "d".repeat(64) }],
    };
    const result = verify([{ ...tampered, recordSha256: acceptanceRecordSha256(tampered) }]);
    expect(result.authorizations).toHaveLength(0);
  });

  it("holds when the component is missing from the acceptance", () => {
    const decision = signedDecision();
    const [component] = decision.components;
    if (component === undefined) throw new Error("expected an acceptance component");
    const other = {
      ...decision,
      components: [{ ...component, evidenceComponentId: "skill:other" }],
    };
    const result = verify([{ ...other, recordSha256: acceptanceRecordSha256(other) }]);
    expect(result.authorizations).toHaveLength(0);
  });

  it("holds when the evidence carries a finding code the acceptance does not list", () => {
    const decision = signedDecision();
    const [component] = decision.components;
    if (component === undefined) throw new Error("expected an acceptance component");
    const narrower = {
      ...decision,
      components: [{ ...component, acceptedFindingCodes: ["trust.hidden-unicode"] }],
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

  it.each([
    "trust.auto-exec-hook",
    "trust.unpinned-dependency",
    "trust.source-drift",
    "trust.unsigned-source",
    "trust.detector-unavailable",
    "trust.sandbox-smoke-unavailable",
    "trust.sandbox-smoke-failed",
  ])("never admits unwaivable finding code %s, even when listed", (unwaivableCode) => {
    const match = matchComponentAcceptance(
      [
        (() => {
          const decision = signedDecision();
          const [component] = decision.components;
          if (component === undefined) throw new Error("expected an acceptance component");
          const widened = {
            ...decision,
            components: [
              {
                ...component,
                acceptedFindingCodes: [...CODES, unwaivableCode],
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
        findingCodes: [...CODES, unwaivableCode],
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

describe("corrected occurrence-bound acceptance", () => {
  it("requires exact profile, analyzer versions, and occurrence fingerprints", () => {
    const occurrences = ["trust-raw:a", "trust-raw:b"];
    const analyzers = ["aih-native@3.1.0", "skillspector@0.9.3"];
    const decision = signedDecision({
      policyVersion: CORRECTED_ACCEPTANCE_POLICY_VERSION,
      components: [
        {
          evidenceComponentId: "skill:risky",
          treeSha256: subtreeHash(),
          acceptedFindingCodes: [...CODES],
          acceptedOccurrenceFingerprints: occurrences,
          analyzerVersions: analyzers,
        },
      ],
    });
    const candidate = {
      framework: "ecc",
      repository: "affaan-m/ECC",
      commitSha: PIN,
      componentId: "skill:risky",
      componentTreeSha256: subtreeHash(),
      findingCodes: CODES,
      profile: "ecc-lean-v1",
      host: "claude",
      adapter: "ecc-lean",
      sourceTreeDigest: "b".repeat(64),
      occurrenceFingerprints: occurrences,
      analyzerVersions: analyzers,
      policyVersion: CORRECTED_ACCEPTANCE_POLICY_VERSION,
      trustPolicyVersion: TRUST_POLICY_VERSION,
    } as const;

    expect(matchCorrectedComponentAcceptance([decision], candidate)).toBeDefined();
    expect(
      matchCorrectedComponentAcceptance([decision], {
        ...candidate,
        occurrenceFingerprints: ["trust-raw:a", "trust-raw:drift"],
      }),
    ).toBeUndefined();
    expect(
      matchCorrectedComponentAcceptance([decision], {
        ...candidate,
        analyzerVersions: ["aih-native@3.1.1", "skillspector@0.9.3"],
      }),
    ).toBeUndefined();
  });

  it("does not reuse legacy code-only acceptance in the corrected policy", () => {
    const legacy = signedDecision();
    expect(
      matchCorrectedComponentAcceptance([legacy], {
        framework: "ecc",
        repository: "affaan-m/ECC",
        commitSha: PIN,
        componentId: "skill:risky",
        componentTreeSha256: subtreeHash(),
        findingCodes: CODES,
        profile: "ecc-lean-v1",
        host: "claude",
        adapter: "ecc-lean",
        sourceTreeDigest: "b".repeat(64),
        occurrenceFingerprints: ["trust-raw:a"],
        analyzerVersions: ["aih-native@3.1.0"],
        policyVersion: CORRECTED_ACCEPTANCE_POLICY_VERSION,
        trustPolicyVersion: TRUST_POLICY_VERSION,
      }),
    ).toBeUndefined();
  });

  it("does not admit a corrected decision through the legacy code-only join", () => {
    const decision = signedDecision({
      policyVersion: CORRECTED_ACCEPTANCE_POLICY_VERSION,
      components: [
        {
          evidenceComponentId: "skill:risky",
          treeSha256: subtreeHash(),
          acceptedFindingCodes: [...CODES],
          acceptedOccurrenceFingerprints: ["trust-raw:a"],
          analyzerVersions: ["aih-native@3.1.0"],
        },
      ],
    });

    expect(
      matchComponentAcceptance(
        [decision],
        {
          framework: "ecc",
          repository: "affaan-m/ECC",
          commitSha: PIN,
          componentId: "skill:risky",
          componentTreeSha256: subtreeHash(),
          findingCodes: CODES,
        },
        new Date(),
        {
          framework: "ecc",
          profile: "ecc-lean-v1",
          host: "claude",
          adapter: "ecc-lean",
        },
      ),
    ).toBeUndefined();
  });
});

describe("shipped acceptance artifact", () => {
  it("contains no stale exact-pin decisions after the ECC fork bridge is retired", () => {
    const raw = artifactJson as {
      decisions: Array<AcceptanceDecision>;
    };
    expect(raw.decisions).toEqual([]);
    expect(readAcceptanceDecisions()).toEqual([]);
    expect(createHash("sha256")).toBeDefined();
  });
});
