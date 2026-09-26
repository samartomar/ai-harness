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
  matchCorrectedComponentAcceptance,
  readAcceptanceDecisions,
} from "../../src/baseline-evidence/acceptance.js";
import artifactJson from "../../src/baseline-evidence/acceptance-decisions.json";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { hashComponentTree, hashSourceTree } from "../../src/baseline-evidence/hash.js";
import { parseBaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";
import { verifyBaselineComponents } from "../../src/baseline-evidence/verify.js";
import { TRUST_POLICY_VERSION } from "../../src/trust/evidence.js";

// D50: an organization's accepted-with-conditions decision is a record shown next to
// the findings it names. Raw vet verdicts are never rewritten, nothing is held for
// findings, and a decision is attached only when every bound field matches exactly,
// so a decision about other bytes is never shown as being about these.

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
    schemaVersion: 2,
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
            verdict: "has-findings",
            analyzers: [{ name: "aih-native", version: "2.7.0" }],
            findings: CODES.map((code) => ({
              code,
              detail: `${code} present`,
              fingerprint: `finding:${code}`,
              fingerprints: [`finding:${code}`],
            })),
            evidenceProblems: [],
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

/** A corrected (policy v2) decision bound to the exact occurrences in `blockedLock`. */
function correctedDecision(
  over: Partial<AcceptanceDecision> = {},
  codes: readonly string[] = CODES,
): AcceptanceDecision {
  return signedDecision({
    policyVersion: CORRECTED_ACCEPTANCE_POLICY_VERSION,
    treeDigest: hashSourceTree(root).treeSha256,
    components: [
      {
        evidenceComponentId: "skill:risky",
        treeSha256: subtreeHash(),
        acceptedFindingCodes: [...codes],
        acceptedOccurrenceFingerprints: codes.map((code) => `finding:${code}`),
        analyzerVersions: ["aih-native@2.7.0"],
      },
    ],
    ...over,
  });
}

function expectNotAttached(result: ReturnType<typeof verify>): void {
  expect(result.authorizations).toHaveLength(1);
  expect(result.authorizations[0]?.acceptance).toBeUndefined();
  expect(result.held).toHaveLength(0);
  expect(result.checks[0]?.detail).not.toContain("organization decision");
}

describe("organization decisions attached to baseline evidence (D50)", () => {
  it("keeps a signed vet pass installable with no acceptance involved", () => {
    const lock = parseBaselineEvidenceLock({
      schemaVersion: 2,
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
              verdict: "no-findings",
              analyzers: [{ name: "aih-native", version: "2.7.0" }],
              findings: [],
              evidenceProblems: [],
            },
          ],
        },
      ],
    });
    const result = verify([], lock);
    expect(result.authorizations).toHaveLength(1);
    expect(result.authorizations[0]?.acceptance).toBeUndefined();
    expect(result.held).toHaveLength(0);
  });

  it("authorizes a component with findings and labels them when no decision is shipped", () => {
    const result = verify([]);
    expect(result.authorizations).toHaveLength(1);
    expect(result.authorizations[0]?.acceptance).toBeUndefined();
    expect(result.held).toHaveLength(0);
    expect(result.labels[0]).toMatchObject({
      verdict: "has-findings",
      findings: CODES.map((code) => ({ code, count: 1 })),
    });
  });

  it("attaches an exact corrected decision as the organization's record next to the findings", () => {
    const result = verify([correctedDecision()]);
    expect(result.authorizations).toHaveLength(1);
    expect(result.authorizations[0]?.acceptance).toMatchObject({
      decisionId: "test-decision-1",
      acceptedFindingCodes: CODES,
    });
    const check = result.checks.find((entry) => entry.name.includes("skill:risky"));
    expect(check).toMatchObject({ verdict: "pass" });
    expect(check?.detail).toContain(
      "carries 2 findings: trust.external-egress, trust.permission-risk",
    );
    expect(check?.detail).toContain("organization decision test-decision-1 records acceptance");
  });

  it("does not attach a legacy code-only decision to corrected-policy evidence", () => {
    const result = verify([signedDecision()]);
    expect(result.authorizations).toHaveLength(1);
    expect(result.authorizations[0]?.acceptance).toBeUndefined();
    expect(result.held).toHaveLength(0);
    const check = result.checks.find((entry) => entry.name.includes("skill:risky"));
    expect(check?.verdict).toBe("pass");
    expect(check?.detail).not.toContain("organization decision");
  });

  it("does not attach a decision on a commit/pin mismatch", () => {
    expectNotAttached(verify([correctedDecision({ commitSha: "f".repeat(40) })]));
  });

  it("does not attach a decision on a repository mismatch", () => {
    expectNotAttached(verify([correctedDecision({ repository: "someone-else/ECC" })]));
  });

  it("does not attach a decision on a component tree-digest mismatch (content-pinned)", () => {
    const decision = correctedDecision();
    const [component] = decision.components;
    if (component === undefined) throw new Error("expected an acceptance component");
    const tampered = {
      ...decision,
      components: [{ ...component, treeSha256: "d".repeat(64) }],
    };
    expectNotAttached(verify([{ ...tampered, recordSha256: acceptanceRecordSha256(tampered) }]));
  });

  it("does not attach a decision that does not name the component", () => {
    const decision = correctedDecision();
    const [component] = decision.components;
    if (component === undefined) throw new Error("expected an acceptance component");
    const other = {
      ...decision,
      components: [{ ...component, evidenceComponentId: "skill:other" }],
    };
    expectNotAttached(verify([{ ...other, recordSha256: acceptanceRecordSha256(other) }]));
  });

  it("does not attach a decision that does not list every finding code the evidence carries", () => {
    const decision = correctedDecision();
    const [component] = decision.components;
    if (component === undefined) throw new Error("expected an acceptance component");
    const narrower = {
      ...decision,
      components: [{ ...component, acceptedFindingCodes: ["trust.hidden-unicode"] }],
    };
    expectNotAttached(verify([{ ...narrower, recordSha256: acceptanceRecordSha256(narrower) }]));
  });

  it("ignores an unsigned decision (record digest mismatch)", () => {
    expectNotAttached(verify([{ ...correctedDecision(), recordSha256: "9".repeat(64) }]));
  });

  it("does not attach an expired decision", () => {
    expectNotAttached(verify([correctedDecision({ expiresAt: "2020-01-01T00:00:00.000Z" })]));
  });

  it.each([
    "trust.auto-exec-hook",
    "trust.malicious-code",
    "trust.prompt-injection",
    "trust.hidden-unicode",
    "trust.unpinned-dependency",
  ])("attaches a decision that records acceptance of finding code %s", (code) => {
    const lock = blockedLock();
    const component = lock.sources[0]?.components[0];
    if (component === undefined) throw new Error("expected a component");
    component.findings.push({
      code,
      detail: `${code} present`,
      fingerprint: `finding:${code}`,
      fingerprints: [`finding:${code}`],
    });
    const decision = correctedDecision({}, [...CODES, code]);
    const result = verify([decision], lock);
    expect(result.authorizations[0]?.acceptance?.acceptedFindingCodes).toEqual([...CODES, code]);
  });

  it("never attaches a decision for another profile to this tuple", () => {
    expectNotAttached(verify([correctedDecision({ profile: "ecc-full-v1" })]));
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
