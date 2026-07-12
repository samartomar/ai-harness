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
import { defaultRunner, type Runner } from "./proc.js";
import {
  type IntentAcknowledgementArtifact,
  resolveIntentAcknowledgementComment,
  validateIntentAcknowledgementArtifact,
} from "./release-intent-artifact.js";
import {
  ISSUE_REF_RESOLUTION_EVIDENCE,
  resolveIssueRefToMergedPr,
} from "./release-issue-ref-resolution.js";

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

/** Audit record for a commit-subject `(#N)` ref that named an issue, not a PR, and
 * was substituted with the issue's unique closing merged PR via GitHub evidence. */
export interface ResolvedIssueRef {
  issue: number;
  pr: number;
  evidence: string;
}

export interface PreflightData {
  repository: string;
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
  /** Resolved public escalation acknowledgement, bound to the tracker and release inputs. */
  intentAcknowledgementArtifact?: IntentAcknowledgementArtifact;
  /** Diagnostic from live acknowledgement resolution; never trusted as evidence. */
  intentAcknowledgementFailure?: string;
  /** Commit-subject `(#N)` refs that named an issue, not a PR, resolved to their
   * unique closing merged PR via GitHub evidence. Recorded for auditability. */
  resolvedIssueRefs?: ResolvedIssueRef[];
  /** Diagnostics for commit-subject `(#N)` refs that resolved as neither a PR nor a
   * unique closing merged PR. Never trusted as evidence; always a named finding. */
  unresolvedPrRefFindings?: string[];
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
  /** Issue-ref → merged-PR substitutions made during gathering, e.g. a squash title
   * that cites the tracking issue instead of its own PR number (see #382, #424). */
  resolvedIssueRefs: ResolvedIssueRef[];
  declaredIntent: SemverClass | undefined;
  computedBump: SemverClass | undefined;
  intentEscalation: boolean;
  intentAcknowledged: boolean;
  intentAcknowledgementArtifact: IntentAcknowledgementArtifact | undefined;
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

function isReleaseTracker(item: MilestoneItem): boolean {
  return !item.isPr && item.state === "open" && /^release:/.test(item.title);
}

function computedBumpFrom(prs: readonly MergedPr[]): {
  cancelled: Set<number>;
  computedBump: SemverClass | undefined;
} {
  const cancelled = cancelledReverts(prs);
  const active = prs.filter((pr) => !cancelled.has(pr.number));
  const computedBump = active.reduce<SemverClass | undefined>((acc, pr) => {
    const bump = bumpOf(pr.semverLabels);
    if (bump === undefined) return acc;
    if (acc === undefined) return bump;
    return CLASSES.indexOf(bump) > CLASSES.indexOf(acc) ? bump : acc;
  }, undefined);
  return { cancelled, computedBump };
}

export function runPreflight(data: PreflightData): Manifest {
  const findings: Finding[] = [];

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
    if (item.state === "open" && !isReleaseTracker(item)) {
      findings.push({
        code: "open-blocker",
        detail: `${item.isPr ? "PR" : "issue"} #${item.number} is still open in the cut milestone`,
      });
    }
  }

  // 4. The tracker itself must exist.
  if (!data.milestoneItems.some(isReleaseTracker)) {
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

  // 5b. Commit refs that resolved to neither a PR nor a unique closing merged PR.
  // Gathering never guesses here (see release-issue-ref-resolution.ts) — it always
  // names the failure instead, so this can never be the thing that turns an
  // uncaught crash into a silently-empty manifest.
  for (const detail of data.unresolvedPrRefFindings ?? []) {
    findings.push({ code: "unresolved-pr-ref", detail });
  }

  // 6. Version-file coherence (the four-way check's local half).
  if (data.packageVersion !== data.versionConstant) {
    findings.push({
      code: "version-mismatch",
      detail: `package.json ${data.packageVersion} != src/version.ts ${data.versionConstant}`,
    });
  }

  const { cancelled, computedBump } = computedBumpFrom(data.mergedPrs);
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
  const tracker = data.milestoneItems.find(isReleaseTracker);
  let acceptedIntentAcknowledgementArtifact: IntentAcknowledgementArtifact | undefined;
  if (
    intentEscalation &&
    declaredIntent !== undefined &&
    computedBump !== undefined &&
    tracker !== undefined &&
    data.intentAcknowledgementArtifact !== undefined
  ) {
    try {
      acceptedIntentAcknowledgementArtifact = validateIntentAcknowledgementArtifact(
        {
          repository: data.repository,
          trackerIssueNumber: tracker.number,
          candidateSha: data.candidateSha,
          declaredIntent,
          computedBump,
        },
        data.intentAcknowledgementArtifact,
      );
    } catch {
      acceptedIntentAcknowledgementArtifact = undefined;
    }
  }
  const intentAcknowledged = acceptedIntentAcknowledgementArtifact !== undefined;
  if (data.intentAcknowledgementFailure !== undefined) {
    findings.push({
      code: "intent-acknowledgement",
      detail: data.intentAcknowledgementFailure,
    });
  }
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
    const acknowledgement = data.intentAcknowledgementArtifact
      ? "; acknowledgement comment artifact does not match the repository, tracker, authority, or release inputs"
      : `; post ${requiredIntentAcknowledgement} on the release tracker and pass its URL with --ack-intent-escalation-comment`;
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
    resolvedIssueRefs: data.resolvedIssueRefs ?? [],
    declaredIntent,
    computedBump,
    intentEscalation,
    intentAcknowledged,
    intentAcknowledgementArtifact: acceptedIntentAcknowledgementArtifact,
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

/** Unit-separator delimiter between sha and subject in the `git log` format below —
 * chosen because it cannot appear in a commit subject, unlike a space or `|`. */
const SHA_SUBJECT_SEPARATOR = "\x1f";

interface CommitRef {
  sha: string;
  number: string;
}

/**
 * Resolves one trailing `(#N)` commit-subject reference to `MergedPr` data. `N` is
 * almost always the ref's own PR number (`gh pr view` resolves it directly). When it
 * isn't — a hand-edited squash title that cites an issue instead, as in #424 — falls
 * back to the issue's unique closing merged PR via GitHub evidence and returns the
 * substitution alongside the data so the caller can record it in the manifest.
 *
 * Never throws: an unresolvable ref (not a PR, and not uniquely closed by one) comes
 * back as a `finding` string, not an exception — gatherLive must always finish and
 * hand runPreflight a manifest, per this module's exit-1-still-emits-a-manifest
 * contract (#382).
 */
async function resolveCommitRef(
  ref: CommitRef,
  run: Runner,
): Promise<
  | { kind: "pr"; pr: MergedPr }
  | { kind: "resolved"; pr: MergedPr; resolved: ResolvedIssueRef }
  | { kind: "unresolved"; finding: string }
> {
  try {
    const raw = JSON.parse(
      sh("gh", ["pr", "view", ref.number, "--json", "number,title,labels,milestone"]),
    ) as {
      number: number;
      title: string;
      labels: { name: string }[];
      milestone?: { title?: string };
    };
    return {
      kind: "pr",
      pr: {
        number: raw.number,
        title: raw.title,
        semverLabels: raw.labels.map((l) => l.name).filter((l) => l.startsWith("semver:")),
        milestone: raw.milestone?.title,
      },
    };
  } catch {
    // Not resolvable as a PR outright (e.g. #424 names the tracking issue, not its
    // own PR) — fall back to GitHub's own closing-reference evidence.
  }
  try {
    const pr = await resolveIssueRefToMergedPr(Number(ref.number), run);
    return {
      kind: "resolved",
      pr,
      resolved: {
        issue: Number(ref.number),
        pr: pr.number,
        evidence: ISSUE_REF_RESOLUTION_EVIDENCE,
      },
    };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: "unresolved",
      finding: `commit ${ref.sha} cites #${ref.number} which is not a pull request and ${reason}`,
    };
  }
}

async function gatherLive(
  cutMilestone: string,
  run: Runner = defaultRunner,
): Promise<PreflightData> {
  const repository = sh("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
  const previousTag = sh("git", ["describe", "--tags", "--abbrev=0"]);
  const candidateSha = sh("git", ["rev-parse", "HEAD"]);
  const commits = sh("git", [
    "log",
    `${previousTag}..HEAD`,
    `--format=%H${SHA_SUBJECT_SEPARATOR}%s`,
  ])
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const sep = line.indexOf(SHA_SUBJECT_SEPARATOR);
      return sep === -1
        ? { sha: line, subject: "" }
        : { sha: line.slice(0, sep), subject: line.slice(sep + 1) };
    });
  const subjects = commits.map((c) => c.subject);

  const refs: CommitRef[] = commits
    .map(({ sha, subject }) => ({ sha, number: /\(#(\d+)\)\s*$/.exec(subject)?.[1] }))
    .filter((r): r is CommitRef => r.number !== undefined);

  const mergedPrs: MergedPr[] = [];
  const resolvedIssueRefs: ResolvedIssueRef[] = [];
  const unresolvedPrRefFindings: string[] = [];
  for (const ref of refs) {
    const outcome = await resolveCommitRef(ref, run);
    if (outcome.kind === "unresolved") {
      unresolvedPrRefFindings.push(outcome.finding);
      continue;
    }
    mergedPrs.push(outcome.pr);
    if (outcome.kind === "resolved") resolvedIssueRefs.push(outcome.resolved);
  }

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
    repository,
    previousTag,
    candidateSha,
    commitSubjects: subjects,
    mergedPrs,
    cutMilestone,
    milestoneItems: items,
    packageVersion: pkg.version,
    versionConstant: constant ?? "",
    resolvedIssueRefs,
    unresolvedPrRefFindings,
  };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("release-preflight.ts");
async function main(): Promise<void> {
  const inputIdx = process.argv.indexOf("--input");
  const milestoneIdx = process.argv.indexOf("--milestone");
  const intentIdx = process.argv.indexOf("--intent");
  const acknowledgementIdx = process.argv.indexOf("--ack-intent-escalation-comment");
  const retiredAcknowledgementIdx = process.argv.indexOf("--ack-intent-escalation");
  if (retiredAcknowledgementIdx > -1) {
    throw new Error(
      "--ack-intent-escalation is retired; use --ack-intent-escalation-comment with a GitHub issue-comment URL",
    );
  }
  const rawIntent = intentIdx > -1 ? process.argv[intentIdx + 1] : undefined;
  if (rawIntent !== undefined && !CLASSES.includes(rawIntent as SemverClass)) {
    throw new Error(`--intent must be patch, minor, or major (received: ${rawIntent})`);
  }
  const baseData: PreflightData =
    inputIdx > -1
      ? (JSON.parse(readFileSync(process.argv[inputIdx + 1] ?? "", "utf8")) as PreflightData)
      : await gatherLive(
          milestoneIdx > -1 ? (process.argv[milestoneIdx + 1] ?? "next-release") : "next-release",
        );
  let data: PreflightData = {
    ...baseData,
    declaredIntent: (rawIntent as SemverClass | undefined) ?? baseData.declaredIntent,
  };
  if (inputIdx > -1 && acknowledgementIdx > -1) {
    throw new Error(
      "--input must carry a resolved intentAcknowledgementArtifact; comment resolution is live-mode only",
    );
  }
  if (inputIdx === -1 && acknowledgementIdx > -1) {
    const tracker = data.milestoneItems.find(isReleaseTracker);
    const { computedBump } = computedBumpFrom(data.mergedPrs);
    if (data.declaredIntent === undefined || computedBump === undefined || tracker === undefined) {
      data = {
        ...data,
        intentAcknowledgementArtifact: undefined,
        intentAcknowledgementFailure:
          "cannot resolve intent acknowledgement without declared intent, computed bump, and release tracker",
      };
    } else {
      const commentUrl = process.argv[acknowledgementIdx + 1];
      try {
        if (commentUrl === undefined) {
          throw new Error("--ack-intent-escalation-comment requires a GitHub issue-comment URL");
        }
        data = {
          ...data,
          intentAcknowledgementArtifact: await resolveIntentAcknowledgementComment(commentUrl, {
            repository: data.repository,
            trackerIssueNumber: tracker.number,
            candidateSha: data.candidateSha,
            declaredIntent: data.declaredIntent,
            computedBump,
          }),
        };
      } catch (error: unknown) {
        data = {
          ...data,
          intentAcknowledgementArtifact: undefined,
          intentAcknowledgementFailure: `intent acknowledgement rejected: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  }
  const manifest = runPreflight(data);
  console.log(JSON.stringify(manifest, null, 2));
  if (!manifest.ok) {
    console.error(`release-preflight: ${manifest.findings.length} finding(s):`);
    for (const f of manifest.findings) console.error(`  [${f.code}] ${f.detail}`);
    process.exitCode = 1;
    return;
  }
  console.error(
    `release-preflight: clean — ${manifest.mergedPrs.length} PR(s), intent=${manifest.declaredIntent ?? "missing"}, bump=${manifest.computedBump ?? "none"}, acknowledged=${manifest.intentAcknowledged}, next=${manifest.nextVersion ?? "n/a"}`,
  );
}

if (invokedDirectly) {
  void main().catch((error: unknown) => {
    console.error(`release-preflight: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
