import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Manifest, runReleasePreflightCli } from "../../src/internals/release-preflight.js";

const { shell, runner, files } = vi.hoisted(() => ({
  shell: vi.fn(),
  runner: vi.fn(),
  files: new Map<string, string>(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: shell,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      files.get(String(args[0])) ?? actual.readFileSync(...args),
  };
});
vi.mock("../../src/internals/proc.js", async (original) => ({
  ...(await original<typeof import("../../src/internals/proc.js")>()),
  defaultRunner: runner,
}));

const candidate = "a".repeat(40);
const repository = "fixture/release-review";
const milestone = "next-release";
const responses = new Map<string, string | Error>();
const output: string[] = [];
const item = (number: number, title = `change ${number}`) => ({
  number,
  title,
  labels: [{ name: "semver:minor" }, { name: "area:release" }],
  milestone: { title: milestone },
});
const tracker = { number: 900, title: "release: fixture", state: "open", labels: [] };
const prCommand = (number: number) => `gh pr view ${number} --json number,title,labels,milestone`;
function commits(subjects: string[]) {
  responses.set(
    "git log v-core-0.5.0..HEAD --format=%H\x1f%s",
    subjects.map((subject, index) => `${String(index + 1).repeat(40)}\x1f${subject}`).join("\n"),
  );
}
function respond(command: string, value: unknown) {
  responses.set(command, JSON.stringify(value));
}
function association(index: number, value: unknown) {
  respond(`gh api repos/{owner}/{repo}/commits/${String(index).repeat(40)}/pulls`, value);
}
async function invoke(args: string[] = ["--intent", "minor"]): Promise<Manifest> {
  await runReleasePreflightCli(["node", "release-preflight.ts", ...args]);
  expect(output).toHaveLength(1);
  const emitted = output[0];
  if (emitted === undefined) throw new Error("Preflight did not emit a manifest");
  return JSON.parse(emitted) as Manifest;
}

beforeEach(() => {
  responses.clear();
  output.length = 0;
  files.clear();
  shell.mockReset();
  runner.mockReset();
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((text) => output.push(String(text)));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  files.set(resolve("package.json"), '{"version":"0.5.0"}');
  files.set(resolve("src/version.ts"), 'export const VERSION = "0.5.0";');
  responses.set("gh repo view --json nameWithOwner --jq .nameWithOwner", `${repository}\n`);
  responses.set("git describe --tags --abbrev=0", "v-core-0.5.0\n");
  responses.set("git rev-parse HEAD", `${candidate}\n`);
  respond("gh api repos/{owner}/{repo}/milestones?state=all&per_page=100", [
    { number: 7, title: milestone },
  ]);
  respond("gh api repos/{owner}/{repo}/issues?milestone=7&state=all&per_page=100", [tracker]);
  respond(prCommand(1), item(1));
  commits(["feat: reviewed (#1)"]);
  shell.mockImplementation((command: string, args: string[]) => {
    const key = [command, ...args].join(" ");
    if (!responses.has(key)) throw new Error(`Unexpected command: ${key}`);
    const value = responses.get(key);
    if (value instanceof Error) throw value;
    return value;
  });
  runner.mockImplementation(async () => {
    throw new Error("Unexpected asynchronous command");
  });
});
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("release preflight gathering and CLI reporting", () => {
  it("binds direct, issue-closing and rebase evidence while deduplicating repeated PR references", async () => {
    commits(["feat: direct (#1)", "fix: repeat (#1)", "feat: issue (#42)", "fix: rebase"]);
    responses.set(prCommand(42), new Error("Not a pull request"));
    runner.mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        data: {
          repository: {
            issue: {
              timelineItems: {
                nodes: [
                  {
                    closer: {
                      __typename: "PullRequest",
                      merged: true,
                      ...item(2),
                      labels: { nodes: item(2).labels },
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    });
    association(4, [{ number: 2, state: "closed", merged_at: "2026-09-09T00:00:00Z" }]);
    respond(prCommand(2), item(2));
    respond("gh api repos/{owner}/{repo}/issues?milestone=7&state=all&per_page=100", [
      tracker,
      { ...item(2), state: "closed", pull_request: { merged_at: "2026-09-09T00:00:00Z" } },
    ]);
    vi.stubEnv("GIT_DIR", "must-not-retarget-the-cut");
    const manifest = await invoke();
    expect(manifest).toMatchObject({
      ok: true,
      candidateSha: candidate,
      nextVersion: "0.6.0",
      computedBump: "minor",
    });
    expect(manifest.mergedPrs.map((pr) => pr.number)).toEqual([1, 2]);
    expect(manifest.resolvedIssueRefs).toEqual([
      {
        issue: 42,
        pr: 2,
        evidence: "gh api graphql: repository.issue.timelineItems(CLOSED_EVENT).closer",
      },
    ]);
    expect(manifest.resolvedCommitRefs).toEqual([
      { sha: "4".repeat(40), pr: 2, evidence: "gh api repos/{owner}/{repo}/commits/{sha}/pulls" },
    ]);
    expect(
      shell.mock.calls.filter(([cmd, args]) => cmd === "gh" && args[0] === "pr" && args[2] === "1"),
    ).toHaveLength(1);
    for (const [cmd, , options] of shell.mock.calls)
      if (cmd === "git") expect(options.env.GIT_DIR).toBeUndefined();
    expect(runner.mock.calls[0]?.[0].slice(0, 3)).toEqual(["gh", "api", "graphql"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("retains named failures for untrusted direct metadata and failed issue resolution", async () => {
    commits([
      "fix: invalid JSON (#1)",
      "fix: wrong identity (#2)",
      "fix: bad labels (#3)",
      "fix: missing milestone (#4)",
      "fix: invalid milestone (#5)",
      "fix: unresolved issue (#6)",
    ]);
    responses.set(prCommand(1), "not-json");
    respond(prCommand(2), item(999));
    respond(prCommand(3), { ...item(3), labels: [{}] });
    respond(prCommand(4), { number: 4, title: "missing milestone", labels: [] });
    respond(prCommand(5), { ...item(5), milestone: "untrusted" });
    responses.set(prCommand(6), new Error("Not a pull request"));
    runner.mockResolvedValue({ code: 1, stdout: "", stderr: "lookup unavailable" });
    const manifest = await invoke();
    expect(manifest.ok).toBe(false);
    expect(manifest.mergedPrs).toEqual([]);
    const findings = manifest.findings.filter((finding) => finding.code === "unresolved-pr-ref");
    expect(findings).toHaveLength(6);
    expect(
      findings
        .slice(0, 5)
        .every((finding) => finding.detail.includes("untrusted pull request metadata")),
    ).toBe(true);
    expect(findings[5]?.detail).toContain("lookup unavailable");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("reports unavailable, ambiguous and conflicting commit associations without guessing a release PR", async () => {
    commits([
      "feat: direct (#1)",
      "fix: unreadable",
      "fix: malformed",
      "fix: ambiguous",
      "fix: missing PR",
      "fix: corrupt PR",
      "fix: conflicting PR",
    ]);
    responses.set(
      `gh api repos/{owner}/{repo}/commits/${"2".repeat(40)}/pulls`,
      new Error("offline"),
    );
    association(3, {});
    association(
      4,
      [2, 3].map((number) => ({ number, state: "closed", merged_at: "2026-09-09T00:00:00Z" })),
    );
    for (const [index, number] of [
      [5, 5],
      [6, 6],
      [7, 1],
    ] as const)
      association(index, [{ number, state: "closed", merged_at: "2026-09-09T00:00:00Z" }]);
    responses.set(prCommand(5), new Error("unavailable"));
    responses.set(prCommand(6), "{");
    let firstPrRead = true;
    const normal = shell.getMockImplementation();
    if (normal === undefined) throw new Error("Expected the read-only shell fixture");
    shell.mockImplementation((cmd: string, args: string[], options: unknown) => {
      if ([cmd, ...args].join(" ") === prCommand(1)) {
        const value = item(1, firstPrRead ? "original title" : "conflicting title");
        firstPrRead = false;
        return JSON.stringify(value);
      }
      return normal(cmd, args, options);
    });
    const manifest = await invoke();
    expect(manifest.ok).toBe(false);
    expect(manifest.mergedPrs).toHaveLength(1);
    expect(manifest.resolvedCommitRefs).toEqual([]);
    const findings = manifest.findings.filter((finding) => finding.code === "unresolved-pr-ref");
    expect(findings).toHaveLength(6);
    expect(findings.map((finding) => finding.detail).join("\n")).toContain(
      "conflicting metadata for pull request #1",
    );
    expect(process.exitCode).toBe(1);
  });

  it("requires the exact tracker comment when the gathered bump exceeds declared intent", async () => {
    const url = `https://github.com/${repository}/issues/900#issuecomment-123`;
    runner.mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        id: 123,
        html_url: url,
        issue_url: `https://api.github.com/repos/${repository}/issues/900`,
        body: `${candidate}:patch:minor`,
        user: { login: "fixture-owner" },
        author_association: "OWNER",
        created_at: "2026-09-09T00:00:00Z",
      }),
    });
    const accepted = await invoke(["--intent", "patch", "--ack-intent-escalation-comment", url]);
    expect(accepted).toMatchObject({ ok: true, intentAcknowledged: true, intentEscalation: true });
    expect(runner).toHaveBeenCalledWith(["gh", "api", `repos/${repository}/issues/comments/123`]);
    output.length = 0;
    runner.mockResolvedValue({ code: 1, stdout: "", stderr: "unavailable" });
    const rejected = await invoke(["--intent", "patch", "--ack-intent-escalation-comment", url]);
    expect(rejected).toMatchObject({ ok: false, intentAcknowledged: false });
    expect(rejected.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["intent-acknowledgement", "intent-escalation"]),
    );
    expect(rejected.intentAcknowledgementArtifact).toBeUndefined();
  });

  it("reports missing tracker and version inputs without attempting to invent an acknowledgement", async () => {
    respond("gh api repos/{owner}/{repo}/milestones?state=all&per_page=100", []);
    files.set(resolve("src/version.ts"), "// no exported version");
    const result = await invoke([
      "--milestone",
      "absent",
      "--intent",
      "patch",
      "--ack-intent-escalation-comment",
    ]);
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["missing-tracker", "version-mismatch", "intent-acknowledgement"]),
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects retired or malformed CLI authority arguments before any gathering", async () => {
    await expect(invoke(["--ack-intent-escalation", "never-authority"])).rejects.toThrow(/retired/);
    await expect(invoke(["--intent", "urgent"])).rejects.toThrow(/patch, minor, or major/);
    expect(shell).not.toHaveBeenCalled();
    files.set("preflight-fixture.json", JSON.stringify({}));
    await expect(
      invoke([
        "--input",
        "preflight-fixture.json",
        "--ack-intent-escalation-comment",
        "https://example.invalid",
      ]),
    ).rejects.toThrow(/live-mode only/);
    expect(runner).not.toHaveBeenCalled();
  });
});
