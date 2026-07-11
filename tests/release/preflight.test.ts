import { describe, expect, it } from "vitest";
import type {
  MergedPr,
  MilestoneItem,
  PreflightData,
} from "../../src/internals/release-preflight.js";
import {
  cancelledReverts,
  nextVersionFrom,
  runPreflight,
} from "../../src/internals/release-preflight.js";

type IntentData = PreflightData & {
  declaredIntent?: "patch" | "minor" | "major";
  intentAcknowledgementSha?: string;
};

function pr(number: number, title: string, labels: string[] = ["semver:patch"]): MergedPr {
  return { number, title, semverLabels: labels, milestone: "next-release" };
}

function tracker(number = 900): MilestoneItem {
  return {
    number,
    isPr: false,
    state: "open",
    merged: false,
    title: "release: vNEXT tracker",
    labels: ["release-blocker"],
  };
}

function mergedItem(p: MergedPr): MilestoneItem {
  return {
    number: p.number,
    isPr: true,
    state: "closed",
    merged: true,
    title: p.title,
    labels: [],
  };
}

/** A clean two-PR cut: everything labeled, aboard, tracked, and version-coherent. */
function cleanData(): IntentData {
  const prs = [pr(1, "fix: a"), pr(2, "feat: b", ["semver:minor"])];
  return {
    previousTag: "v2.5.1",
    candidateSha: "a".repeat(40),
    commitSubjects: ["fix: a (#1)", "feat: b (#2)"],
    mergedPrs: prs,
    cutMilestone: "next-release",
    milestoneItems: [...prs.map(mergedItem), tracker()],
    packageVersion: "2.5.1",
    versionConstant: "2.5.1",
    declaredIntent: "minor",
  };
}

describe("runPreflight — clean cut", () => {
  it("passes and computes the bump from the highest class aboard", () => {
    const m = runPreflight(cleanData());
    expect(m.ok).toBe(true);
    expect(m.findings).toEqual([]);
    expect(m.computedBump).toBe("minor");
    expect(m.nextVersion).toBe("2.6.0");
  });
});

describe("runPreflight — declared intent checkpoint", () => {
  it("missing-intent: blocks when the cut has no declared bump intent", () => {
    const d = cleanData();
    delete d.declaredIntent;

    const m = runPreflight(d);

    expect(m.ok).toBe(false);
    expect(m.findings.map((finding) => finding.code)).toContain("missing-intent");
  });

  it("intent-escalation: blocks when the computed bump exceeds declared intent", () => {
    const d = cleanData();
    d.declaredIntent = "patch";

    const m = runPreflight(d);

    expect(m.ok).toBe(false);
    expect(m.findings).toContainEqual(expect.objectContaining({ code: "intent-escalation" }));
    expect(m).toMatchObject({
      declaredIntent: "patch",
      computedBump: "minor",
      intentEscalation: true,
      intentAcknowledged: false,
    });
  });

  it.each([
    "minor",
    "major",
  ] as const)("passes without acknowledgement when declared intent is %s", (intent) => {
    const d = cleanData();
    d.declaredIntent = intent;

    expect(runPreflight(d)).toMatchObject({
      ok: true,
      declaredIntent: intent,
      intentEscalation: false,
      intentAcknowledged: false,
    });
  });

  it("accepts an upward escalation only when acknowledgement binds the candidate SHA", () => {
    const d = cleanData();
    d.declaredIntent = "patch";
    d.intentAcknowledgementSha = d.candidateSha;

    expect(runPreflight(d)).toMatchObject({
      ok: true,
      declaredIntent: "patch",
      computedBump: "minor",
      intentEscalation: true,
      intentAcknowledged: true,
    });
  });

  it("intent-escalation: rejects an acknowledgement bound to another candidate", () => {
    const d = cleanData();
    d.declaredIntent = "patch";
    d.intentAcknowledgementSha = "b".repeat(40);

    const m = runPreflight(d);

    expect(m.ok).toBe(false);
    expect(m.findings).toContainEqual(expect.objectContaining({ code: "intent-escalation" }));
    expect(m).toMatchObject({ intentEscalation: true, intentAcknowledged: false });
  });
});

describe("runPreflight — each failure mode exits with a named finding", () => {
  it("unlabeled-pr: a merged PR with zero semver labels", () => {
    const d = cleanData();
    const target = d.mergedPrs[0];
    if (target) target.semverLabels = [];
    const m = runPreflight(d);
    expect(m.ok).toBe(false);
    expect(m.findings.map((f) => f.code)).toContain("unlabeled-pr");
  });

  it("multi-label-pr: two semver labels on one PR", () => {
    const d = cleanData();
    const target = d.mergedPrs[0];
    if (target) target.semverLabels = ["semver:patch", "semver:minor"];
    expect(runPreflight(d).findings.map((f) => f.code)).toContain("multi-label-pr");
  });

  it("unknown-label: a semver:* value outside patch|minor|major", () => {
    const d = cleanData();
    const target = d.mergedPrs[0];
    if (target) target.semverLabels = ["semver:huge"];
    expect(runPreflight(d).findings.map((f) => f.code)).toContain("unknown-label");
  });

  it("milestone-drift-missing: merged PR not in the cut milestone", () => {
    const d = cleanData();
    const target = d.mergedPrs[0];
    if (target) target.milestone = undefined;
    expect(runPreflight(d).findings.map((f) => f.code)).toContain("milestone-drift-missing");
  });

  it("milestone-drift-foreign: closed-unmerged PR sitting in the milestone", () => {
    const d = cleanData();
    d.milestoneItems.push({
      number: 77,
      isPr: true,
      state: "closed",
      merged: false,
      title: "chore: abandoned",
      labels: [],
    });
    expect(runPreflight(d).findings.map((f) => f.code)).toContain("milestone-drift-foreign");
  });

  it("open-blocker: an open non-tracker issue aboard the cut milestone", () => {
    const d = cleanData();
    d.milestoneItems.push({
      number: 88,
      isPr: false,
      state: "open",
      merged: false,
      title: "feat: unfinished work",
      labels: [],
    });
    expect(runPreflight(d).findings.map((f) => f.code)).toContain("open-blocker");
  });

  it("missing-tracker: no open release tracker in the milestone", () => {
    const d = cleanData();
    d.milestoneItems = d.milestoneItems.filter((i) => !/^release:/.test(i.title));
    expect(runPreflight(d).findings.map((f) => f.code)).toContain("missing-tracker");
  });

  it("no-pr-commit: a commit that bypassed the PR label gate", () => {
    const d = cleanData();
    d.commitSubjects.push("hotfix: pushed straight to main");
    expect(runPreflight(d).findings.map((f) => f.code)).toContain("no-pr-commit");
  });

  it("version-mismatch: package.json disagrees with src/version.ts", () => {
    const d = cleanData();
    d.versionConstant = "9.9.9";
    expect(runPreflight(d).findings.map((f) => f.code)).toContain("version-mismatch");
  });
});

describe("revert pairs", () => {
  it("a merged revert cancels its target out of the bump computation", () => {
    const minor = pr(3, "feat: risky thing", ["semver:minor"]);
    const revert = pr(4, 'Revert "feat: risky thing"', ["semver:minor"]);
    const d = cleanData();
    d.mergedPrs = [pr(1, "fix: a"), minor, revert];
    d.commitSubjects = ["fix: a (#1)", "feat: risky thing (#3)", 'Revert "feat: risky thing" (#4)'];
    d.milestoneItems = [...d.mergedPrs.map(mergedItem), tracker()];
    const m = runPreflight(d);
    expect(m.cancelledPrs).toEqual([3, 4]);
    // The surviving PR is a patch — the cancelled minor must not inflate the bump.
    expect(m.computedBump).toBe("patch");
    expect(m.nextVersion).toBe("2.5.2");
    expect(m.ok).toBe(true);
  });

  it("cancelledReverts pairs at most once per target", () => {
    const prs = [
      pr(1, "feat: x", ["semver:minor"]),
      pr(2, 'Revert "feat: x"'),
      pr(3, 'Revert "feat: x"'),
    ];
    const cancelled = cancelledReverts(prs);
    // One revert pairs with the target; the second revert has nothing left to cancel.
    expect(cancelled.has(1)).toBe(true);
    expect(cancelled.has(2)).toBe(true);
    expect(cancelled.has(3)).toBe(false);
  });
});

describe("nextVersionFrom", () => {
  it("applies each class to a v-prefixed tag", () => {
    expect(nextVersionFrom("v2.5.1", "patch")).toBe("2.5.2");
    expect(nextVersionFrom("v2.5.1", "minor")).toBe("2.6.0");
    expect(nextVersionFrom("v2.5.1", "major")).toBe("3.0.0");
  });

  it("returns undefined for a malformed tag", () => {
    expect(nextVersionFrom("nightly-2026", "patch")).toBeUndefined();
  });
});
