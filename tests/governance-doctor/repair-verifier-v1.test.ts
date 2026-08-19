import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGovernanceDoctorRepairClaimV1,
  governanceDoctorRepairClaimScopeSha256V1,
  markGovernanceDoctorRepairClaimSpentV1,
} from "../../src/governance-doctor/repair-claim-v1.js";
import {
  createGovernanceDoctorRepairContentV1,
  governanceDoctorRepairMarkerBeginLineV1,
  governanceDoctorRepairMarkerEndLineV1,
  recordGovernanceDoctorRepairAttemptEvidenceV1,
} from "../../src/governance-doctor/repair-content-v1.js";
import { createGovernanceDoctorRepairCustodyV1 } from "../../src/governance-doctor/repair-custody-v1.js";
import { executeGovernanceDoctorRepairV1 } from "../../src/governance-doctor/repair-executor-v1.js";
import {
  canonicalGovernanceDoctorRepairReceiptV1Bytes,
  createGovernanceDoctorRepairReceiptV1,
  type GovernanceDoctorRepairReceiptV1,
  resolveGovernanceDoctorRepairStateV1,
} from "../../src/governance-doctor/repair-outcome-v1.js";
import type { GovernanceDoctorRepairPlanV1 } from "../../src/governance-doctor/repair-plan-v1.js";
import { verifyGovernanceDoctorRepairV1 } from "../../src/governance-doctor/repair-verifier-v1.js";
import {
  REPAIR_FIXTURE_ATTEMPTED_AT,
  REPAIR_FIXTURE_CONTEXT_DIR,
  REPAIR_FIXTURE_VERIFIED_AT,
  type RepairFixtureEffect,
  type RepairFixtureHome,
  repairFixtureConsent,
  repairFixtureExecutionContext,
  repairFixtureIsolatedHome,
  repairFixturePlan,
  repairFixtureSha256,
  repairFixtureVerificationContext,
} from "./repair-execution-fixture-v1.js";

/**
 * The claim store resolves its own location from the OS account, never from
 * `HOME` or `USERPROFILE`, and exposes no caller input and no test setter for it.
 * The only seam a suite may use is therefore the platform module itself.
 */
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { repairFixtureOsModuleV1 } = await import("./repair-account-home-v1.js");
  return repairFixtureOsModuleV1(actual);
});

let root: string;
let outside: string;
let home: RepairFixtureHome;

const BEGIN = governanceDoctorRepairMarkerBeginLineV1("canon-block");
const END = governanceDoctorRepairMarkerEndLineV1("canon-block");

const ROUTER_BODY = "router body\n";
const BLOCK_BODY = "generated block";
const ROUTER_SHA256 = repairFixtureSha256(ROUTER_BODY);
const BLOCK_SHA256 = repairFixtureSha256(BLOCK_BODY);

const SCOPE = ["block.md", "canon", "canon/router.md", "crlf.md"] as const;

const EFFECTS: readonly RepairFixtureEffect[] = [
  { arguments: { path: "canon" }, effectId: "ensure-canon", templateId: "ensure-canon-directory" },
  {
    arguments: { path: "crlf.md" },
    effectId: "normalize-crlf",
    templateId: "normalize-canon-endings",
  },
  {
    arguments: { contentSha256: ROUTER_SHA256, path: "canon/router.md" },
    effectId: "restore-router",
    templateId: "restore-canon-file",
  },
  {
    arguments: { blockId: "canon-block", contentSha256: BLOCK_SHA256, path: "block.md" },
    effectId: "rewrite-block",
    templateId: "rewrite-canon-block",
  },
];

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_ATTEMPTED_AT);
  // Applying a Repair now takes a durable claim; keep it out of the real home.
  home = repairFixtureIsolatedHome();
  root = mkdtempSync(join(tmpdir(), "aih-repair-verifier-"));
  outside = mkdtempSync(join(tmpdir(), "aih-repair-outside-"));
  writeFileSync(join(root, "crlf.md"), "a\r\nb\r\n");
  writeFileSync(join(root, "block.md"), `preamble\n${BEGIN}\nold\n${END}\ntrailer\n`);
});

afterEach(() => {
  vi.restoreAllMocks();
  home.release();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** A stable digest over every path, kind, and byte under the fixture root. */
function treeDigest(directory: string): string {
  const hash = createHash("sha256");
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const absolute = join(current, entry.name);
      hash.update(relative(root, absolute).split("\\").join("/"));
      if (entry.isDirectory()) {
        hash.update("d");
        walk(absolute);
      } else if (entry.isSymbolicLink()) {
        hash.update("l");
      } else {
        // One read supplies both the length and the bytes, so there is no
        // stat-then-read window for the digest to observe two states through.
        const bytes = readFileSync(absolute);
        hash.update("f");
        hash.update(String(bytes.length));
        hash.update(bytes);
      }
    }
  };
  walk(directory);
  return hash.digest("hex");
}

function trustedContent(...bodies: readonly string[]) {
  return createGovernanceDoctorRepairContentV1({
    entries: bodies.map((body) => {
      const bytes = Buffer.from(body, "utf8");
      return { bytes, contentSha256: repairFixtureSha256(bytes) };
    }),
  });
}

function custody(built: GovernanceDoctorRepairPlanV1) {
  return createGovernanceDoctorRepairCustodyV1({
    contextDir: REPAIR_FIXTURE_CONTEXT_DIR,
    plan: built,
    root,
  });
}

async function applied(effects: readonly RepairFixtureEffect[] = EFFECTS, planNonce?: string) {
  const built = await repairFixturePlan({
    effects,
    ...(planNonce === undefined ? {} : { planNonce }),
    root,
    scopePaths: SCOPE,
  });
  const receipt = executeGovernanceDoctorRepairV1({
    consent: repairFixtureConsent(built),
    content: trustedContent(ROUTER_BODY, BLOCK_BODY),
    context: repairFixtureExecutionContext(built),
    custody: custody(built),
    plan: built,
  });
  return { built, receipt };
}

function verify(
  built: GovernanceDoctorRepairPlanV1,
  receipt: GovernanceDoctorRepairReceiptV1,
  overrides: Record<string, unknown> = {},
) {
  return verifyGovernanceDoctorRepairV1({
    content: trustedContent(ROUTER_BODY, BLOCK_BODY),
    context: repairFixtureVerificationContext(built),
    custody: custody(built),
    plan: built,
    receipt,
    ...overrides,
  });
}

/** The refusal message a closed failure produced, or an empty string if none did. */
function refusalMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

const outcomes = (verification: { checks: readonly { outcome: string }[] }) =>
  verification.checks.map((check) => check.outcome);

describe("verifyGovernanceDoctorRepairV1", () => {
  it("re-reads the live state and covers every planned effect", async () => {
    const { built, receipt } = await applied();
    const verification = verify(built, receipt);

    expect(outcomes(verification)).toEqual(["verified", "verified", "verified", "verified"]);
    expect(verification.outcome).toBe("verified");
    expect(verification.planSha256).toBe(built.planSha256);
    expect(verification.receiptSha256).toBe(receipt.receiptSha256);
    expect(verification.checks.map((check) => check.effectSha256)).toEqual(
      built.effects.map((effect) => effect.effectSha256),
    );
  });

  it("mutates nothing: the fixture tree is byte-identical afterwards", async () => {
    const { built, receipt } = await applied();
    const before = treeDigest(root);
    verify(built, receipt);
    expect(treeDigest(root)).toBe(before);
  });

  it("is independent of the executor: a state undone after the attempt reads as failed", async () => {
    const { built, receipt } = await applied();
    writeFileSync(join(root, "canon", "router.md"), "tampered\n");
    writeFileSync(join(root, "crlf.md"), "a\r\nb\r\n");

    const verification = verify(built, receipt);
    expect(outcomes(verification)).toEqual(["verified", "failed", "failed", "verified"]);
    expect(verification.outcome).toBe("failed");
  });

  it("does not treat an unrelated LF-only or same-body marker file as proof of this attempt", async () => {
    const { built, receipt } = await applied();
    writeFileSync(join(root, "crlf.md"), "foreign\na\nb\n");
    writeFileSync(
      join(root, "block.md"),
      `foreign preamble\n${BEGIN}\n${BLOCK_BODY}\n${END}\nforeign trailer\n`,
    );

    const verification = verify(built, receipt);
    expect(outcomes(verification)).toEqual(["verified", "failed", "verified", "failed"]);
    expect(verification.outcome).toBe("failed");
  });

  it("resolves a covering verification through the existing V1 state contract", async () => {
    const { built, receipt } = await applied();
    const resolution = resolveGovernanceDoctorRepairStateV1({
      consent: repairFixtureConsent(built),
      consumedPlanSha256: [],
      evaluatedAtEpochMs: REPAIR_FIXTURE_VERIFIED_AT + 1_000,
      plan: built,
      receipt,
      verification: verify(built, receipt),
    });

    expect(resolution.state).toBe("verified");
    expect(resolution.applied).toBe(true);
    expect(resolution.reason).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "preserves applied-unverified truth when a check cannot complete",
    async () => {
      const { built, receipt } = await applied();
      rmSync(join(root, "crlf.md"));
      writeFileSync(join(outside, "target.md"), "a\nb\n");
      symlinkSync(join(outside, "target.md"), join(root, "crlf.md"));

      const verification = verify(built, receipt);
      expect(outcomes(verification)).toEqual(["verified", "unavailable", "verified", "verified"]);
      expect(verification.outcome).toBe("unavailable");

      const resolution = resolveGovernanceDoctorRepairStateV1({
        consent: repairFixtureConsent(built),
        consumedPlanSha256: [],
        evaluatedAtEpochMs: REPAIR_FIXTURE_VERIFIED_AT + 1_000,
        plan: built,
        receipt,
        verification,
      });
      expect(resolution.state).toBe("applied-unverified");
      expect(resolution.applied).toBe(true);
      expect(resolution.reason).toBeNull();
    },
  );

  it("reports unavailable for a transported receipt that carries no local evidence", async () => {
    const { built, receipt } = await applied();

    // A receipt that travelled is re-minted from its own facts rather than being
    // the object this process recorded against. Its content is identical -- so
    // every effect still reads as applied -- but the local post-state evidence is
    // deliberately not part of what travels.
    const transported = createGovernanceDoctorRepairReceiptV1({
      attemptedAtEpochMs: receipt.attemptedAtEpochMs,
      consent: repairFixtureConsent(built),
      context: repairFixtureExecutionContext(built),
      effects: receipt.effects.map((effect) => ({
        effectId: effect.effectId,
        result: effect.result,
      })),
      plan: built,
    });
    expect(canonicalGovernanceDoctorRepairReceiptV1Bytes(transported)).toEqual(
      canonicalGovernanceDoctorRepairReceiptV1Bytes(receipt),
    );
    expect(transported.effects.every((effect) => effect.result === "applied")).toBe(true);

    // The tree still holds every goal state, and the receipt still says applied.
    // Attribution is what is missing, so no check may claim verified.
    expect(outcomes(verify(built, receipt))).toEqual([
      "verified",
      "verified",
      "verified",
      "verified",
    ]);
    expect(outcomes(verify(built, transported))).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    expect(verify(built, transported).outcome).toBe("unavailable");
  });

  /**
   * An effect the attempt did not apply is a *failed* check, never an unreadable
   * one.
   *
   * Attempt evidence is recorded only for effects a Receipt records as applied,
   * so a failed or skipped effect always resolves its goal state to
   * "unavailable" -- and reporting that verbatim said "nobody could read this"
   * about the one outcome this verifier knows exactly. It also left the
   * not-applied-but-state-holds branch unreachable for any executor-produced
   * Receipt: a branch that cannot be tested because it cannot happen.
   */
  it("reports exactly failed for every effect the receipt did not apply", async () => {
    rmSync(join(root, "block.md"));
    const { built, receipt } = await applied();

    expect(receipt.state).toBe("failed");
    const notApplied = receipt.effects
      .map((effect, index) => ({ index, result: effect.result }))
      .filter((entry) => entry.result !== "applied");
    expect(notApplied.length).toBeGreaterThan(0);

    const verification = verify(built, receipt);
    expect(notApplied.map((entry) => verification.checks[entry.index]?.outcome)).toEqual(
      notApplied.map(() => "failed"),
    );
  });

  it("never claims an effect the receipt did not apply", async () => {
    rmSync(join(root, "block.md"));
    const { built, receipt } = await applied();

    expect(receipt.state).toBe("failed");
    const verification = verify(built, receipt);
    expect(
      verification.checks
        .filter((_check, index) => receipt.effects[index]?.result !== "applied")
        .every((check) => check.outcome !== "verified"),
    ).toBe(true);
  });

  /**
   * The independence half of the contract: locally recorded evidence attributes a
   * live state to an attempt, but it must never be able to *manufacture* one. A
   * receipt minted without executing anything, carrying evidence that merely
   * echoes the unrepaired tree, satisfies provenance by construction -- so the
   * verdict must also require the plan's own goal for each effect to hold.
   */
  it("never verifies fabricated evidence that echoes an unrepaired tree", async () => {
    mkdirSync(join(root, "canon"));
    writeFileSync(join(root, "canon", "router.md"), "unrepaired\n");
    const built = await repairFixturePlan({ effects: EFFECTS, root, scopePaths: SCOPE });
    const fabricated = createGovernanceDoctorRepairReceiptV1({
      attemptedAtEpochMs: REPAIR_FIXTURE_ATTEMPTED_AT,
      consent: repairFixtureConsent(built),
      context: repairFixtureExecutionContext(built),
      effects: built.effects.map((effect) => ({ effectId: effect.effectId, result: "applied" })),
      plan: built,
    });
    recordGovernanceDoctorRepairAttemptEvidenceV1(
      fabricated,
      built.effects.map((effect) =>
        effect.effectKind === "create-managed-directory"
          ? { effectSha256: effect.effectSha256, state: "directory" }
          : {
              bytes: readFileSync(join(root, effect.arguments.path ?? "")),
              effectSha256: effect.effectSha256,
              state: "file",
            },
      ),
      markGovernanceDoctorRepairClaimSpentV1(
        createGovernanceDoctorRepairClaimV1({
          claimedAtEpochMs: REPAIR_FIXTURE_ATTEMPTED_AT,
          consentSha256: fabricated.consentSha256,
          planSha256: fabricated.planSha256,
          scopeSha256: governanceDoctorRepairClaimScopeSha256V1({ realPath: root }),
          state: "claimed",
        }),
      ),
      root,
    );

    // The directory genuinely exists, so its goal holds; every file effect's goal
    // does not, and echoed evidence must not stand in for it.
    const verification = verify(built, fabricated);
    expect(outcomes(verification)).toEqual(["verified", "failed", "failed", "failed"]);
    expect(verification.outcome).toBe("failed");
  });

  it("refuses a foreign receipt, foreign custody, an unclosed content input, and extra fields", async () => {
    const { built, receipt } = await applied();
    const other = await applied(EFFECTS, "1a".repeat(32));

    expect(() => verify(built, other.receipt)).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(() => verify(built, receipt, { custody: custody(other.built) })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(() => verify(built, receipt, { content: trustedContent(ROUTER_BODY) })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(() => verify(built, receipt, { extra: 1 })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(() => verify(built, { ...receipt })).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
  });

  it("never echoes a managed path or file content in a refusal", async () => {
    const { built, receipt } = await applied();
    const message = refusalMessage(() =>
      verify(built, receipt, { content: trustedContent(ROUTER_BODY) }),
    );

    expect(message).toMatch(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(message).not.toContain(root);
    expect(message).not.toContain("router.md");
    expect(message).not.toContain(ROUTER_BODY.trim());
  });
});
