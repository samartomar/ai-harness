import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IntentAcknowledgementArtifact } from "../../src/internals/release-intent-artifact.js";
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
function cleanData(): PreflightData {
  const prs = [pr(1, "fix: a"), pr(2, "feat: b", ["semver:minor"])];
  return {
    repository: "samartomar/ai-harness",
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

function acknowledgementArtifact(
  data: PreflightData,
  overrides: Partial<IntentAcknowledgementArtifact> = {},
): IntentAcknowledgementArtifact {
  return {
    repository: data.repository,
    issueNumber: 900,
    commentId: 123456,
    commentUrl: "https://github.com/samartomar/ai-harness/issues/900#issuecomment-123456",
    author: "samartomar",
    authorAssociation: "OWNER",
    createdAt: "2026-07-10T23:00:00Z",
    token: `${data.candidateSha}:patch:minor`,
    ...overrides,
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

  it("invalid-intent: rejects a serialized intent outside patch|minor|major", () => {
    const d = cleanData();
    (d as unknown as { declaredIntent?: string }).declaredIntent = "huge";

    const m = runPreflight(d);

    expect(m.ok).toBe(false);
    expect(m.findings.map((finding) => finding.code)).toContain("invalid-intent");
    expect(m).toMatchObject({ intentEscalation: false, intentAcknowledged: false });
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

  it("rejects a raw token without a resolved acknowledgement artifact", () => {
    const d = cleanData();
    d.declaredIntent = "patch";
    (d as unknown as { intentAcknowledgement: string }).intentAcknowledgement =
      `${d.candidateSha}:patch:minor`;

    expect(runPreflight(d)).toMatchObject({
      ok: false,
      declaredIntent: "patch",
      computedBump: "minor",
      intentEscalation: true,
      intentAcknowledged: false,
      requiredIntentAcknowledgement: `${d.candidateSha}:patch:minor`,
    });
  });

  it("accepts escalation only with an attributable artifact bound to the tracker and inputs", () => {
    const d = cleanData();
    d.declaredIntent = "patch";
    d.intentAcknowledgementArtifact = acknowledgementArtifact(d);

    expect(runPreflight(d)).toMatchObject({
      ok: true,
      declaredIntent: "patch",
      computedBump: "minor",
      intentEscalation: true,
      intentAcknowledged: true,
      intentAcknowledgementArtifact: {
        repository: "samartomar/ai-harness",
        issueNumber: 900,
        commentId: 123456,
        commentUrl: "https://github.com/samartomar/ai-harness/issues/900#issuecomment-123456",
        author: "samartomar",
        authorAssociation: "OWNER",
        createdAt: "2026-07-10T23:00:00Z",
        token: `${d.candidateSha}:patch:minor`,
      },
      requiredIntentAcknowledgement: `${d.candidateSha}:patch:minor`,
    });
  });

  it.each([
    ["repository", { repository: "other/repo" }],
    ["tracker issue", { issueNumber: 901 }],
    ["token", { token: `${"b".repeat(40)}:patch:minor` }],
    ["authority", { authorAssociation: "CONTRIBUTOR" as "OWNER" }],
  ])("rejects an artifact with the wrong %s", (_name, overrides) => {
    const d = cleanData();
    d.declaredIntent = "patch";
    d.intentAcknowledgementArtifact = acknowledgementArtifact(d, overrides);

    expect(runPreflight(d)).toMatchObject({
      ok: false,
      intentEscalation: true,
      intentAcknowledged: false,
      intentAcknowledgementArtifact: undefined,
      requiredIntentAcknowledgement: `${d.candidateSha}:patch:minor`,
    });
    expect(JSON.parse(JSON.stringify(runPreflight(d)))).not.toHaveProperty(
      "intentAcknowledgementArtifact",
    );
  });

  it("omits an irrelevant acknowledgement artifact when escalation is not required", () => {
    const d = cleanData();
    d.intentAcknowledgementArtifact = acknowledgementArtifact(d);

    const manifest = runPreflight(d);

    expect(manifest).toMatchObject({
      ok: true,
      intentEscalation: false,
      intentAcknowledged: false,
      intentAcknowledgementArtifact: undefined,
    });
    expect(JSON.parse(JSON.stringify(manifest))).not.toHaveProperty(
      "intentAcknowledgementArtifact",
    );
  });
});

describe("release:preflight CLI intent checkpoint", () => {
  it("emits blocked evidence and accepts a resolved fixture artifact without a network call", () => {
    const dir = mkdtempSync(join(tmpdir(), "aih-release-intent-"));
    try {
      const fixture = cleanData();
      delete fixture.declaredIntent;
      const input = join(dir, "preflight.json");
      writeFileSync(input, JSON.stringify(fixture), "utf8");
      const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
      const script = join(process.cwd(), "src", "internals", "release-preflight.ts");
      const run = (...args: string[]) =>
        spawnSync(process.execPath, [tsx, script, "--input", input, ...args], {
          cwd: process.cwd(),
          encoding: "utf8",
        });

      const blocked = run("--intent", "patch");
      expect(blocked.status).toBe(1);
      expect(JSON.parse(blocked.stdout)).toMatchObject({
        ok: false,
        declaredIntent: "patch",
        computedBump: "minor",
        intentEscalation: true,
        intentAcknowledged: false,
        findings: [expect.objectContaining({ code: "intent-escalation" })],
      });

      const rawToken = run(
        "--intent",
        "patch",
        "--ack-intent-escalation",
        `${fixture.candidateSha}:patch:minor`,
      );
      expect(rawToken.status).toBe(1);
      expect(rawToken.stderr).toMatch(
        /--ack-intent-escalation is retired; use --ack-intent-escalation-comment/i,
      );

      fixture.intentAcknowledgementArtifact = acknowledgementArtifact({
        ...fixture,
        declaredIntent: "patch",
      });
      writeFileSync(input, JSON.stringify(fixture), "utf8");
      const acknowledged = run("--intent", "patch");
      expect(acknowledged.status, acknowledged.stderr).toBe(0);
      expect(JSON.parse(acknowledged.stdout)).toMatchObject({
        ok: true,
        intentEscalation: true,
        intentAcknowledged: true,
        intentAcknowledgementArtifact: {
          repository: "samartomar/ai-harness",
          issueNumber: 900,
          commentId: 123456,
          commentUrl: "https://github.com/samartomar/ai-harness/issues/900#issuecomment-123456",
          author: "samartomar",
          authorAssociation: "OWNER",
          createdAt: "2026-07-10T23:00:00Z",
          token: `${fixture.candidateSha}:patch:minor`,
        },
        requiredIntentAcknowledgement: `${fixture.candidateSha}:patch:minor`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits a blocked manifest when live acknowledgement URL validation fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "aih-release-live-intent-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const candidateSha = "a".repeat(40);
      const git = join(bin, "git");
      writeFileSync(
        git,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "describe") console.log("v2.8.0");
else if (args[0] === "rev-parse") console.log("${candidateSha}");
else if (args[0] === "log") console.log("feat: b (#2)");
else process.exit(2);
`,
        "utf8",
      );
      chmodSync(git, 0o755);

      const gh = join(bin, "gh");
      writeFileSync(
        gh,
        `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args.startsWith("repo view ")) {
  console.log("samartomar/ai-harness");
} else if (args.startsWith("pr view 2 ")) {
  console.log(JSON.stringify({
    number: 2,
    title: "feat: b",
    labels: [{ name: "semver:minor" }],
    milestone: { title: "next-release" },
  }));
} else if (args === "api repos/{owner}/{repo}/milestones?state=all&per_page=100") {
  console.log(JSON.stringify([{ number: 1, title: "next-release" }]));
} else if (args === "api repos/{owner}/{repo}/issues?milestone=1&state=all&per_page=100") {
  console.log(JSON.stringify([
    {
      number: 2,
      state: "closed",
      title: "feat: b",
      labels: [],
      pull_request: { merged_at: "2026-07-10T22:00:00Z" },
    },
    {
      number: 900,
      state: "open",
      title: "release: vNEXT tracker",
      labels: [{ name: "release-blocker" }],
    },
  ]));
} else {
  console.error("unexpected gh invocation: " + args);
  process.exit(2);
}
`,
        "utf8",
      );
      chmodSync(gh, 0o755);

      const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
      const script = join(process.cwd(), "src", "internals", "release-preflight.ts");
      const result = spawnSync(
        process.execPath,
        [
          tsx,
          script,
          "--intent",
          "patch",
          "--ack-intent-escalation-comment",
          "https://evil.example/comment/123456",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
        },
      );

      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        intentEscalation: true,
        intentAcknowledged: false,
        findings: expect.arrayContaining([
          expect.objectContaining({ code: "intent-acknowledgement" }),
        ]),
      });
      expect(JSON.parse(result.stdout)).not.toHaveProperty("intentAcknowledgementArtifact");
      expect(result.stderr).toContain("[intent-acknowledgement]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
