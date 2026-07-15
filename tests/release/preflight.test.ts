import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  parseGitLog,
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

function removeTempDir(dir: string): void {
  rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 5 : 0,
    retryDelay: 100,
  });
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
      removeTempDir(dir);
    }
  });

  it("emits a blocked manifest when live acknowledgement URL validation fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "aih-release-live-intent-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const candidateSha = "a".repeat(40);
      const gitStub = `
const { writeSync } = require("node:fs");
const out = (value) => writeSync(1, String(value) + "\\n");
const args = process.argv.slice(2);
if (args[0] === "describe") out("v2.8.0");
else if (args[0] === "rev-parse") out("${candidateSha}");
else if (args[0] === "log") out("${"b".repeat(40)}\\x1ffeat: b (#2)");
else process.exit(2);
`;

      const ghStub = `
const { writeSync } = require("node:fs");
const out = (value) => writeSync(1, String(value) + "\\n");
const args = process.argv.slice(2).join(" ");
if (args.startsWith("repo view ")) {
  out("samartomar/ai-harness");
} else if (args.startsWith("pr view 2 ")) {
  out(JSON.stringify({
    number: 2,
    title: "feat: b",
    labels: [{ name: "semver:minor" }],
    milestone: { title: "next-release" },
  }));
} else if (args === "api repos/{owner}/{repo}/milestones?state=all&per_page=100") {
  out(JSON.stringify([{ number: 1, title: "next-release" }]));
} else if (args === "api repos/{owner}/{repo}/issues?milestone=1&state=all&per_page=100") {
  out(JSON.stringify([
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
  writeSync(2, "unexpected gh invocation: " + args + "\\n");
  process.exit(2);
}
`;

      let nodeOptions = process.env.NODE_OPTIONS;
      if (process.platform === "win32") {
        const gitModule = join(bin, "git-stub.cjs");
        const ghModule = join(bin, "gh-stub.cjs");
        const preload = join(bin, "command-preload.cjs");
        writeFileSync(gitModule, gitStub, "utf8");
        writeFileSync(ghModule, ghStub, "utf8");
        writeFileSync(
          preload,
          `const { basename } = require("node:path");
const command = basename(process.execPath).toLowerCase();
if (command === "git.exe") {
  process.argv[1] = basename(process.argv[1] || "");
  process.argv.splice(1, 0, "git-stub.cjs");
  require("./git-stub.cjs");
  process.exit(0);
} else if (command === "gh.exe") {
  process.argv[1] = basename(process.argv[1] || "");
  process.argv.splice(1, 0, "gh-stub.cjs");
  require("./gh-stub.cjs");
  process.exit(0);
}
`,
          "utf8",
        );
        copyFileSync(process.execPath, join(bin, "git.exe"));
        copyFileSync(process.execPath, join(bin, "gh.exe"));
        nodeOptions = [process.env.NODE_OPTIONS, `--require=${JSON.stringify(preload)}`]
          .filter(Boolean)
          .join(" ");
      } else {
        const git = join(bin, "git");
        const gh = join(bin, "gh");
        writeFileSync(git, `#!/usr/bin/env node${gitStub}`, "utf8");
        writeFileSync(gh, `#!/usr/bin/env node${ghStub}`, "utf8");
        chmodSync(git, 0o755);
        chmodSync(gh, 0o755);
      }

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
          env: {
            ...process.env,
            NODE_OPTIONS: nodeOptions,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout, result.stderr).not.toBe("");
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
      removeTempDir(dir);
    }
  });
});

describe("release:preflight CLI — issue-ref resolution (#424-class commit subjects)", () => {
  /**
   * Spawns the real CLI against stubbed `git`/`gh` binaries on PATH, mirroring the
   * live gatherer's full call sequence: repo view, describe, rev-parse, log, then
   * per-ref pr-view (with a graphql closing-PR fallback), milestones, and milestone
   * issues. Same cross-platform approach as the intent-acknowledgement CLI test above
   * (POSIX shebang scripts vs. a Windows node.exe + preload dispatch trick).
   */
  function runPreflightCliWithStubs(
    dir: string,
    gitStub: string,
    ghStub: string,
    args: string[],
  ): { status: number | null; stdout: string; stderr: string } {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    let nodeOptions = process.env.NODE_OPTIONS;
    if (process.platform === "win32") {
      const gitModule = join(bin, "git-stub.cjs");
      const ghModule = join(bin, "gh-stub.cjs");
      const preload = join(bin, "command-preload.cjs");
      writeFileSync(gitModule, gitStub, "utf8");
      writeFileSync(ghModule, ghStub, "utf8");
      writeFileSync(
        preload,
        `const { basename } = require("node:path");
const command = basename(process.execPath).toLowerCase();
if (command === "git.exe") {
  process.argv[1] = basename(process.argv[1] || "");
  process.argv.splice(1, 0, "git-stub.cjs");
  require("./git-stub.cjs");
  process.exit(0);
} else if (command === "gh.exe") {
  process.argv[1] = basename(process.argv[1] || "");
  process.argv.splice(1, 0, "gh-stub.cjs");
  require("./gh-stub.cjs");
  process.exit(0);
}
`,
        "utf8",
      );
      copyFileSync(process.execPath, join(bin, "git.exe"));
      copyFileSync(process.execPath, join(bin, "gh.exe"));
      nodeOptions = [process.env.NODE_OPTIONS, `--require=${JSON.stringify(preload)}`]
        .filter(Boolean)
        .join(" ");
    } else {
      const git = join(bin, "git");
      const gh = join(bin, "gh");
      writeFileSync(git, `#!/usr/bin/env node${gitStub}`, "utf8");
      writeFileSync(gh, `#!/usr/bin/env node${ghStub}`, "utf8");
      chmodSync(git, 0o755);
      chmodSync(gh, 0o755);
    }

    const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const script = join(process.cwd(), "src", "internals", "release-preflight.ts");
    return spawnSync(process.execPath, [tsx, script, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
  }

  const REAL_PR_SHA = "4".repeat(40);
  const ISSUE_REF_SHA = "5".repeat(40);

  /** git stub shared by all three scenarios: only `log`'s payload differs. */
  function gitStub(logLines: string[]): string {
    const body = logLines.map((line) => `  out(${JSON.stringify(line)});`).join("\n");
    return `
const { writeSync } = require("node:fs");
const out = (value) => writeSync(1, String(value) + "\\n");
const args = process.argv.slice(2);
if (args[0] === "describe") out("v2.8.0");
else if (args[0] === "rev-parse") out("${"d".repeat(40)}");
else if (args[0] === "log") {
${body}
}
else process.exit(2);
`;
  }

  const TRACKER_ITEM = `{
      number: 900,
      state: "open",
      title: "release: vNEXT tracker",
      labels: [{ name: "release-blocker" }],
    }`;

  it("(a)+(d) resolves an issue ref to its closing merged PR while a real PR ref resolves unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "aih-release-issue-ref-ok-"));
    try {
      const gLog = [
        `${REAL_PR_SHA}\x1ffeat: real pr thing (#2)`,
        `${ISSUE_REF_SHA}\x1ffeat: bind release escalation to GitHub evidence (#424)`,
      ];
      const gh = `
const { writeSync } = require("node:fs");
const out = (value) => writeSync(1, String(value) + "\\n");
const args = process.argv.slice(2).join(" ");
if (args.startsWith("repo view ")) {
  out("samartomar/ai-harness");
} else if (args.startsWith("pr view 2 ")) {
  out(JSON.stringify({
    number: 2,
    title: "feat: real pr thing",
    labels: [{ name: "semver:patch" }],
    milestone: { title: "v2.9.0" },
  }));
} else if (args.startsWith("pr view 424 ")) {
  writeSync(2, "GraphQL: Could not resolve to a PullRequest with the number of 424.\\n");
  process.exit(1);
} else if (args.startsWith("api graphql ")) {
  out(JSON.stringify({
    data: { repository: { issue: { timelineItems: { nodes: [
      { closer: {
          __typename: "PullRequest",
          number: 431,
          title: "feat(release): bind escalation acknowledgement to GitHub evidence",
          merged: true,
          labels: { nodes: [{ name: "semver:minor" }] },
          milestone: { title: "v2.9.0" },
      } },
    ] } } } },
  }));
} else if (args === "api repos/{owner}/{repo}/milestones?state=all&per_page=100") {
  out(JSON.stringify([{ number: 1, title: "v2.9.0" }]));
} else if (args === "api repos/{owner}/{repo}/issues?milestone=1&state=all&per_page=100") {
  out(JSON.stringify([
    { number: 2, state: "closed", title: "feat: real pr thing", labels: [],
      pull_request: { merged_at: "2026-07-11T09:00:00Z" } },
    { number: 431, state: "closed", title: "feat(release): bind escalation acknowledgement to GitHub evidence", labels: [],
      pull_request: { merged_at: "2026-07-11T09:16:13Z" } },
    ${TRACKER_ITEM},
  ]));
} else {
  writeSync(2, "unexpected gh invocation: " + args + "\\n");
  process.exit(2);
}
`;

      const result = runPreflightCliWithStubs(dir, gitStub(gLog), gh, [
        "--milestone",
        "v2.9.0",
        "--intent",
        "minor",
      ]);

      expect(result.stdout, result.stderr).not.toBe("");
      const manifest = JSON.parse(result.stdout);
      expect(result.status, JSON.stringify(manifest, null, 2)).toBe(0);
      expect(manifest).toMatchObject({
        ok: true,
        computedBump: "minor",
        resolvedIssueRefs: [
          {
            issue: 424,
            pr: 431,
            evidence: "gh api graphql: repository.issue.timelineItems(CLOSED_EVENT).closer",
          },
        ],
      });
      expect(manifest.mergedPrs.map((p: { number: number }) => p.number).sort()).toEqual([2, 431]);
      expect(manifest.findings.map((f: { code: string }) => f.code)).not.toContain(
        "unresolved-pr-ref",
      );
    } finally {
      removeTempDir(dir);
    }
  });

  it("parses Git subjects without stripping meaningful trailing whitespace", () => {
    expect(parseGitLog(`${REAL_PR_SHA}\x1ffix: preserve subject tail (#2)  \n`)).toEqual([
      { sha: REAL_PR_SHA, subject: "fix: preserve subject tail (#2)  " },
    ]);
  });

  it("rejects malformed or identity-mismatched direct PR metadata without resolving a fallback", () => {
    const cases = [
      {
        name: "malformed labels",
        response: { number: 2, title: "fix: malformed", labels: [{ name: 3 }], milestone: null },
      },
      {
        name: "mismatched number",
        response: { number: 3, title: "fix: mismatched", labels: [], milestone: null },
      },
      {
        name: "missing milestone",
        response: { number: 2, title: "fix: missing", labels: [] },
      },
    ];

    for (const sample of cases) {
      const dir = mkdtempSync(join(tmpdir(), "aih-release-untrusted-pr-"));
      try {
        const gh = `
const { writeSync } = require("node:fs");
const out = (value) => writeSync(1, String(value) + "\\n");
const args = process.argv.slice(2).join(" ");
if (args.startsWith("repo view ")) out("samartomar/ai-harness");
else if (args.startsWith("pr view 2 ")) out(${JSON.stringify(JSON.stringify(sample.response))});
else if (args.startsWith("api graphql ")) {
  out(JSON.stringify({ data: { repository: { issue: { timelineItems: { nodes: [{ closer: {
    __typename: "PullRequest", number: 2, title: "fallback must not be trusted", merged: true,
    labels: { nodes: [{ name: "semver:patch" }] }, milestone: { title: "v2.9.0" },
  } }] } } } } }));
} else if (args === "api repos/{owner}/{repo}/milestones?state=all&per_page=100") {
  out(JSON.stringify([{ number: 1, title: "v2.9.0" }]));
} else if (args === "api repos/{owner}/{repo}/issues?milestone=1&state=all&per_page=100") {
  out(JSON.stringify([${TRACKER_ITEM}]));
} else { process.exit(2); }
`;
        const result = runPreflightCliWithStubs(
          dir,
          gitStub([`${REAL_PR_SHA}\x1ffix: trusted metadata (${"#2"})`]),
          gh,
          ["--milestone", "v2.9.0", "--intent", "patch"],
        );

        const manifest = JSON.parse(result.stdout);
        expect(result.status, sample.name).toBe(1);
        expect(manifest.mergedPrs, sample.name).toEqual([]);
        expect(manifest.findings, sample.name).toContainEqual({
          code: "unresolved-pr-ref",
          detail: `commit ${REAL_PR_SHA} cites #2 but GitHub returned untrusted pull request metadata`,
        });
      } finally {
        removeTempDir(dir);
      }
    }
  }, 30_000);

  it("(b) an issue ref with no closing merged PR becomes a named finding, not a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "aih-release-issue-ref-none-"));
    try {
      const gLog = [`${ISSUE_REF_SHA}\x1ffeat: bind release escalation to GitHub evidence (#424)`];
      const gh = `
const { writeSync } = require("node:fs");
const out = (value) => writeSync(1, String(value) + "\\n");
const args = process.argv.slice(2).join(" ");
if (args.startsWith("repo view ")) {
  out("samartomar/ai-harness");
} else if (args.startsWith("pr view 424 ")) {
  writeSync(2, "GraphQL: Could not resolve to a PullRequest with the number of 424.\\n");
  process.exit(1);
} else if (args.startsWith("api graphql ")) {
  out(JSON.stringify({
    data: { repository: { issue: { timelineItems: { nodes: [] } } } },
  }));
} else if (args === "api repos/{owner}/{repo}/milestones?state=all&per_page=100") {
  out(JSON.stringify([{ number: 1, title: "v2.9.0" }]));
} else if (args === "api repos/{owner}/{repo}/issues?milestone=1&state=all&per_page=100") {
  out(JSON.stringify([${TRACKER_ITEM}]));
} else {
  writeSync(2, "unexpected gh invocation: " + args + "\\n");
  process.exit(2);
}
`;

      const result = runPreflightCliWithStubs(dir, gitStub(gLog), gh, [
        "--milestone",
        "v2.9.0",
        "--intent",
        "minor",
      ]);

      expect(result.stdout, result.stderr).not.toBe("");
      const manifest = JSON.parse(result.stdout);
      expect(result.status).toBe(1);
      expect(manifest.ok).toBe(false);
      expect(manifest.findings).toContainEqual({
        code: "unresolved-pr-ref",
        detail: `commit ${ISSUE_REF_SHA} cites #424 which is not a pull request and has no unique closing merged PR`,
      });
    } finally {
      removeTempDir(dir);
    }
  });

  it("(c) an issue ref with two candidate closing merged PRs becomes a named finding (ambiguous)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aih-release-issue-ref-ambiguous-"));
    try {
      const gLog = [`${ISSUE_REF_SHA}\x1ffeat: bind release escalation to GitHub evidence (#424)`];
      const gh = `
const { writeSync } = require("node:fs");
const out = (value) => writeSync(1, String(value) + "\\n");
const args = process.argv.slice(2).join(" ");
if (args.startsWith("repo view ")) {
  out("samartomar/ai-harness");
} else if (args.startsWith("pr view 424 ")) {
  writeSync(2, "GraphQL: Could not resolve to a PullRequest with the number of 424.\\n");
  process.exit(1);
} else if (args.startsWith("api graphql ")) {
  out(JSON.stringify({
    data: { repository: { issue: { timelineItems: { nodes: [
      { closer: { __typename: "PullRequest", number: 431, title: "a", merged: true,
          labels: { nodes: [] }, milestone: null } },
      { closer: { __typename: "PullRequest", number: 500, title: "b", merged: true,
          labels: { nodes: [] }, milestone: null } },
    ] } } } },
  }));
} else if (args === "api repos/{owner}/{repo}/milestones?state=all&per_page=100") {
  out(JSON.stringify([{ number: 1, title: "v2.9.0" }]));
} else if (args === "api repos/{owner}/{repo}/issues?milestone=1&state=all&per_page=100") {
  out(JSON.stringify([${TRACKER_ITEM}]));
} else {
  writeSync(2, "unexpected gh invocation: " + args + "\\n");
  process.exit(2);
}
`;

      const result = runPreflightCliWithStubs(dir, gitStub(gLog), gh, [
        "--milestone",
        "v2.9.0",
        "--intent",
        "minor",
      ]);

      expect(result.stdout, result.stderr).not.toBe("");
      const manifest = JSON.parse(result.stdout);
      expect(result.status).toBe(1);
      expect(manifest.ok).toBe(false);
      expect(manifest.findings).toContainEqual({
        code: "unresolved-pr-ref",
        detail: `commit ${ISSUE_REF_SHA} cites #424 which is not a pull request and has 2 candidate closing merged PRs (#431, #500) — ambiguous`,
      });
    } finally {
      removeTempDir(dir);
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

  it("unresolved-pr-ref: a commit citing an issue with no unique closing merged PR", () => {
    const d = cleanData();
    d.unresolvedPrRefFindings = [
      `commit ${"c".repeat(40)} cites #424 which is not a pull request and has no unique closing merged PR`,
    ];
    const m = runPreflight(d);
    expect(m.ok).toBe(false);
    expect(m.findings).toContainEqual({
      code: "unresolved-pr-ref",
      detail: `commit ${"c".repeat(40)} cites #424 which is not a pull request and has no unique closing merged PR`,
    });
  });

  it("unresolved-pr-ref: surfaces one named finding per unresolvable ref", () => {
    const d = cleanData();
    d.unresolvedPrRefFindings = [
      "commit aaa cites #424 which is not a pull request and has no unique closing merged PR",
      "commit bbb cites #500 which is not a pull request and has 2 candidate closing merged PRs (#501, #502) — ambiguous",
    ];
    const codes = runPreflight(d).findings.filter((f) => f.code === "unresolved-pr-ref");
    expect(codes).toHaveLength(2);
  });
});

describe("runPreflight — resolved issue refs are recorded for auditability", () => {
  it("passes a recorded issue→PR resolution mapping straight through to the manifest", () => {
    const d = cleanData();
    d.resolvedIssueRefs = [
      {
        issue: 424,
        pr: 431,
        evidence: "gh api graphql: repository.issue.timelineItems(CLOSED_EVENT).closer",
      },
    ];
    const m = runPreflight(d);
    expect(m.resolvedIssueRefs).toEqual([
      {
        issue: 424,
        pr: 431,
        evidence: "gh api graphql: repository.issue.timelineItems(CLOSED_EVENT).closer",
      },
    ]);
    // Recording the mapping is not itself a finding.
    expect(m.findings.map((f) => f.code)).not.toContain("unresolved-pr-ref");
  });

  it("defaults to an empty array when gathering resolved nothing", () => {
    const m = runPreflight(cleanData());
    expect(m.resolvedIssueRefs).toEqual([]);
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
