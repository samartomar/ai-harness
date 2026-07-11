/**
 * Release-train preflight (#382). Validates the pending cut against RELEASING.md's
 * sweep rules and emits a machine-readable manifest suitable for the release tracker.
 *
 * Read-only: shells out to local `git` and the `gh` CLI for GitHub READS only —
 * never mutates local or remote state (see "the one hard rule" in CONTRIBUTING.md).
 *
 * Exit 0: cut is clean; manifest on stdout. Exit 1: named findings; manifest still
 * emitted so the failure is machine-consumable.
 *
 * Fixture mode for tests: `runPreflight(data)` is pure — the live gatherer only
 * builds the same `PreflightData` shape from git/gh.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type SemverClass = "patch" | "minor" | "major";

export interface MergedPr {
  number: number;
  title: string;
  semverLabels: string[];
  milestone: string | undefined;
}

export interface MilestoneItem {
  number: number;
  isPr: boolean;
  state: "open" | "closed";
  merged: boolean;
  title: string;
  labels: string[];
}

export interface PreflightData {
  previousTag: string;
  candidateSha: string;
  /** Squash-merge subjects since previousTag, e.g. `fix: thing (#123)`. */
  commitSubjects: string[];
  mergedPrs: MergedPr[];
  cutMilestone: string;
  milestoneItems: MilestoneItem[];
  packageVersion: string;
  versionConstant: string;
  /** Maintainer-declared scope for this cut; required before a release PR opens. */
  declaredIntent?: SemverClass;
  /** Explicit escalation acknowledgement, bound to candidate SHA + intent + computed bump. */
  intentAcknowledgement?: string;
}

export interface Finding {
  code: string;
  detail: string;
}

export interface Manifest {
  previousTag: string;
  candidateSha: string;
  cutMilestone: string;
  mergedPrs: MergedPr[];
  cancelledPrs: number[];
  declaredIntent: SemverClass | undefined;
  computedBump: SemverClass | undefined;
  intentEscalation: boolean;
  intentAcknowledged: boolean;
  intentAcknowledgement: string | undefined;
  requiredIntentAcknowledgement: string | undefined;
  nextVersion: string | undefined;
  findings: Finding[];
  ok: boolean;
}

const CLASSES: readonly SemverClass[] = ["patch", "minor", "major"];

function bumpOf(labels: string[]): SemverClass | undefined {
  const cls = labels[0]?.replace("semver:", "");
  return CLASSES.includes(cls as SemverClass) ? (cls as SemverClass) : undefined;
}

export function nextVersionFrom(tag: string, bump: SemverClass): string | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!m) return undefined;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function intentAcknowledgementToken(
  candidateSha: string,
  declaredIntent: SemverClass,
  computedBump: SemverClass,
): string {
  return `${candidateSha}:${declaredIntent}:${computedBump}`;
}

/** `Revert "..."` pairs cancel: neither the revert nor its target counts toward the bump. */
export function cancelledReverts(prs: readonly MergedPr[]): Set<number> {
  const cancelled = new Set<number>();
  for (const pr of prs) {
    const m = /^Revert "(.+)"$/.exec(pr.title);
    if (!m) continue;
    const target = prs.find((p) => !cancelled.has(p.number) && p.title === m[1]);
    if (target) {
      cancelled.add(pr.number);
      cancelled.add(target.number);
    }
  }
  return cancelled;
}

export function runPreflight(data: PreflightData): Manifest {
  const findings: Finding[] = [];
  const isTracker = (i: MilestoneItem): boolean =>
    !i.isPr && i.state === "open" && /^release:/.test(i.title);

  // 1. Every merged PR carries exactly one valid semver:* label.
  for (const pr of data.mergedPrs) {
    if (pr.semverLabels.length === 0) {
      findings.push({ code: "unlabeled-pr", detail: `#${pr.number} has no semver:* label` });
    } else if (pr.semverLabels.length > 1) {
      findings.push({
        code: "multi-label-pr",
        detail: `#${pr.number} carries ${pr.semverLabels.join(", ")} — exactly one is authoritative`,
      });
    } else if (bumpOf(pr.semverLabels) === undefined) {
      findings.push({
        code: "unknown-label",
        detail: `#${pr.number} carries unknown class ${pr.semverLabels[0]}`,
      });
    }
  }

  // 2. Milestone vs git truth, both directions.
  for (const pr of data.mergedPrs) {
    if (pr.milestone !== data.cutMilestone) {
      findings.push({
        code: "milestone-drift-missing",
        detail: `merged #${pr.number} is not in milestone "${data.cutMilestone}" (has: ${pr.milestone ?? "none"})`,
      });
    }
  }
  const mergedNumbers = new Set(data.mergedPrs.map((p) => p.number));
  for (const item of data.milestoneItems) {
    if (item.isPr && item.state === "closed" && !item.merged) {
      findings.push({
        code: "milestone-drift-foreign",
        detail: `milestone contains closed-unmerged PR #${item.number} — remove or it reads as shipped`,
      });
    }
    if (item.isPr && item.state === "closed" && item.merged && !mergedNumbers.has(item.number)) {
      findings.push({
        code: "milestone-drift-foreign",
        detail: `milestone contains merged PR #${item.number} not reachable from the candidate SHA`,
      });
    }
  }

  // 3. Open blockers aboard (anything open except the release tracker).
  for (const item of data.milestoneItems) {
    if (item.state === "open" && !isTracker(item)) {
      findings.push({
        code: "open-blocker",
        detail: `${item.isPr ? "PR" : "issue"} #${item.number} is still open in the cut milestone`,
      });
    }
  }

  // 4. The tracker itself must exist.
  if (!data.milestoneItems.some(isTracker)) {
    findings.push({
      code: "missing-tracker",
      detail: `no open "release: ..." tracker issue in milestone "${data.cutMilestone}"`,
    });
  }

  // 5. Commits that bypassed the PR label gate entirely.
  for (const subject of data.commitSubjects) {
    if (!/\(#\d+\)\s*$/.test(subject)) {
      findings.push({
        code: "no-pr-commit",
        detail: `commit "${subject}" carries no PR reference — it bypassed the semver-label gate`,
      });
    }
  }

  // 6. Version-file coherence (the four-way check's local half).
  if (data.packageVersion !== data.versionConstant) {
    findings.push({
      code: "version-mismatch",
      detail: `package.json ${data.packageVersion} != src/version.ts ${data.versionConstant}`,
    });
  }

  const cancelled = cancelledReverts(data.mergedPrs);
  const active = data.mergedPrs.filter((p) => !cancelled.has(p.number));
  const computedBump = active.reduce<SemverClass | undefined>((acc, pr) => {
    const b = bumpOf(pr.semverLabels);
    if (b === undefined) return acc;
    if (acc === undefined) return b;
    return CLASSES.indexOf(b) > CLASSES.indexOf(acc) ? b : acc;
  }, undefined);
  const rawIntent = data.declaredIntent as string | undefined;
  const declaredIntent = CLASSES.includes(rawIntent as SemverClass)
    ? (rawIntent as SemverClass)
    : undefined;
  const intentEscalation =
    declaredIntent !== undefined &&
    computedBump !== undefined &&
    CLASSES.indexOf(computedBump) > CLASSES.indexOf(declaredIntent);
  const requiredIntentAcknowledgement = intentEscalation
    ? intentAcknowledgementToken(data.candidateSha, declaredIntent, computedBump)
    : undefined;
  const intentAcknowledged =
    intentEscalation && data.intentAcknowledgement === requiredIntentAcknowledgement;
  if (rawIntent === undefined) {
    findings.push({
      code: "missing-intent",
      detail: "the cut has no declared --intent patch|minor|major checkpoint",
    });
  } else if (declaredIntent === undefined) {
    findings.push({
      code: "invalid-intent",
      detail: `declared intent must be patch, minor, or major (received: ${rawIntent})`,
    });
  } else if (intentEscalation && !intentAcknowledged) {
    const acknowledgement = data.intentAcknowledgement
      ? `; acknowledgement ${data.intentAcknowledgement} does not match ${requiredIntentAcknowledgement}`
      : `; acknowledge explicitly with --ack-intent-escalation ${requiredIntentAcknowledgement}`;
    findings.push({
      code: "intent-escalation",
      detail: `computed ${computedBump} exceeds declared ${declaredIntent}${acknowledgement}`,
    });
  }

  return {
    previousTag: data.previousTag,
    candidateSha: data.candidateSha,
    cutMilestone: data.cutMilestone,
    mergedPrs: data.mergedPrs,
    cancelledPrs: [...cancelled].sort((a, b) => a - b),
    declaredIntent,
    computedBump,
    intentEscalation,
    intentAcknowledged,
    intentAcknowledgement: data.intentAcknowledgement,
    requiredIntentAcknowledgement,
    nextVersion: computedBump ? nextVersionFrom(data.previousTag, computedBump) : undefined,
    findings,
    ok: findings.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Live gathering (not covered by unit tests — kept minimal; logic stays above).

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

function gatherLive(cutMilestone: string): PreflightData {
  const previousTag = sh("git", ["describe", "--tags", "--abbrev=0"]);
  const candidateSha = sh("git", ["rev-parse", "HEAD"]);
  const subjects = sh("git", ["log", `${previousTag}..HEAD`, "--format=%s"])
    .split("\n")
    .filter((s) => s.length > 0);

  const prNumbers = subjects
    .map((s) => /\(#(\d+)\)\s*$/.exec(s)?.[1])
    .filter((n): n is string => n !== undefined);
  const mergedPrs: MergedPr[] = prNumbers.map((n) => {
    const raw = JSON.parse(
      sh("gh", ["pr", "view", n, "--json", "number,title,labels,milestone"]),
    ) as {
      number: number;
      title: string;
      labels: { name: string }[];
      milestone?: { title?: string };
    };
    return {
      number: raw.number,
      title: raw.title,
      semverLabels: raw.labels.map((l) => l.name).filter((l) => l.startsWith("semver:")),
      milestone: raw.milestone?.title,
    };
  });

  const milestones = JSON.parse(
    sh("gh", ["api", "repos/{owner}/{repo}/milestones?state=all&per_page=100"]),
  ) as { number: number; title: string }[];
  const ms = milestones.find((m) => m.title === cutMilestone);
  const items: MilestoneItem[] = ms
    ? (
        JSON.parse(
          sh("gh", [
            "api",
            `repos/{owner}/{repo}/issues?milestone=${ms.number}&state=all&per_page=100`,
          ]),
        ) as {
          number: number;
          state: string;
          title: string;
          labels: { name: string }[];
          pull_request?: { merged_at?: string | null };
        }[]
      ).map((i) => ({
        number: i.number,
        isPr: i.pull_request !== undefined,
        state: i.state === "open" ? "open" : "closed",
        merged: Boolean(i.pull_request?.merged_at),
        title: i.title,
        labels: i.labels.map((l) => l.name),
      }))
    : [];

  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    version: string;
  };
  const constant = /VERSION = "([^"]+)"/.exec(
    readFileSync(join(process.cwd(), "src", "version.ts"), "utf8"),
  )?.[1];

  return {
    previousTag,
    candidateSha,
    commitSubjects: subjects,
    mergedPrs,
    cutMilestone,
    milestoneItems: items,
    packageVersion: pkg.version,
    versionConstant: constant ?? "",
  };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("release-preflight.ts");
if (invokedDirectly) {
  const inputIdx = process.argv.indexOf("--input");
  const milestoneIdx = process.argv.indexOf("--milestone");
  const intentIdx = process.argv.indexOf("--intent");
  const acknowledgementIdx = process.argv.indexOf("--ack-intent-escalation");
  const rawIntent = intentIdx > -1 ? process.argv[intentIdx + 1] : undefined;
  if (rawIntent !== undefined && !CLASSES.includes(rawIntent as SemverClass)) {
    throw new Error(`--intent must be patch, minor, or major (received: ${rawIntent})`);
  }
  const baseData: PreflightData =
    inputIdx > -1
      ? (JSON.parse(readFileSync(process.argv[inputIdx + 1] ?? "", "utf8")) as PreflightData)
      : gatherLive(
          milestoneIdx > -1 ? (process.argv[milestoneIdx + 1] ?? "next-release") : "next-release",
        );
  const data: PreflightData = {
    ...baseData,
    declaredIntent: (rawIntent as SemverClass | undefined) ?? baseData.declaredIntent,
    intentAcknowledgement:
      (acknowledgementIdx > -1 ? process.argv[acknowledgementIdx + 1] : undefined) ??
      baseData.intentAcknowledgement,
  };
  const manifest = runPreflight(data);
  console.log(JSON.stringify(manifest, null, 2));
  if (!manifest.ok) {
    console.error(`release-preflight: ${manifest.findings.length} finding(s):`);
    for (const f of manifest.findings) console.error(`  [${f.code}] ${f.detail}`);
    process.exit(1);
  }
  console.error(
    `release-preflight: clean — ${manifest.mergedPrs.length} PR(s), intent=${manifest.declaredIntent ?? "missing"}, bump=${manifest.computedBump ?? "none"}, acknowledged=${manifest.intentAcknowledged}, next=${manifest.nextVersion ?? "n/a"}`,
  );
}
