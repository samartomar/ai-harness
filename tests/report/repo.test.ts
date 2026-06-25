import { describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type RunResult } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { repoStatusPanel } from "../../src/report/repo.js";

/** Canned git/gh state for a repo, mapped onto argv by {@link ctxFor}. */
interface Fixture {
  insideRepo?: boolean;
  current?: string;
  mainExists?: string;
  dirty?: boolean;
  branches?: Array<[name: string, age: string]>;
  /** Per-branch [behind, ahead] vs main. */
  aheadBehind?: Record<string, [number, number]>;
  gh?: Partial<RunResult>;
  lsRemote?: string | null;
  fetchedRefs?: string | null;
}

function ctxFor(f: Fixture, options: Record<string, unknown> = {}): PlanContext {
  const run = fakeRunner((argv): Partial<RunResult> | undefined => {
    if (argv[0] === "gh") return f.gh ?? { code: 127, spawnError: true };
    if (argv[0] !== "git") return undefined;
    const a = argv.slice(3); // drop `git -C <root>`
    const joined = a.join(" ");
    if (joined === "rev-parse --is-inside-work-tree")
      return f.insideRepo === false ? { code: 128, stderr: "not a repo" } : { stdout: "true" };
    if (joined === "rev-parse --abbrev-ref HEAD") return { stdout: f.current ?? "feature/login" };
    if (joined === "symbolic-ref --short refs/remotes/origin/HEAD") return { code: 128 };
    if (a[0] === "rev-parse" && a.includes("--verify")) {
      const cand = (a[a.length - 1] ?? "").replace("refs/heads/", "");
      return cand === (f.mainExists ?? "main") ? { stdout: "abc123" } : { code: 1 };
    }
    if (joined.startsWith("status --porcelain")) return { stdout: f.dirty ? " M file.txt" : "" };
    if (a[0] === "for-each-ref" && joined.includes("refs/heads"))
      return { stdout: (f.branches ?? []).map(([n, age]) => `${n}\t${age}`).join("\n") };
    if (a[0] === "rev-list") {
      const branch = (a[a.length - 1] ?? "").split("...")[1] ?? "";
      const [behind, ahead] = f.aheadBehind?.[branch] ?? [0, 0];
      return { stdout: `${behind}\t${ahead}` };
    }
    if (joined === "ls-remote --heads origin")
      return f.lsRemote == null ? { code: 128 } : { stdout: f.lsRemote };
    if (a[0] === "for-each-ref" && joined.includes("refs/remotes/origin"))
      return f.fetchedRefs == null ? { code: 128 } : { stdout: f.fetchedRefs };
    return undefined;
  });
  return {
    root: "/repo",
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options,
  };
}

describe("repoStatusPanel — local (network-free) branch status", () => {
  it("reports when the target root is not a git repository", async () => {
    const d = await repoStatusPanel(ctxFor({ insideRepo: false }));
    expect(d.describe).toContain("not a git repository");
    expect(d.data).toMatchObject({ isRepo: false });
  });

  it("renders branch status with ahead/behind vs main, and dirty state", async () => {
    const d = await repoStatusPanel(
      ctxFor({
        current: "feature/login",
        mainExists: "main",
        dirty: true,
        branches: [
          ["main", "3 days ago"],
          ["feature/login", "1 hour ago"],
        ],
        aheadBehind: { "feature/login": [2, 5] }, // behind 2, ahead 5
      }),
    );
    expect(d.describe).toContain("on feature/login");
    expect(d.describe).toContain("2 local branch(es)");
    expect(d.describe).toContain("1 ahead of main");
    expect(d.text).toContain("uncommitted changes");
    expect(d.text).toContain("+5/-2 vs main");
    expect(d.text).toContain("main (main)");
    expect(d.data).toMatchObject({ current: "feature/login", main: "main", dirty: true });
  });

  it("without --team, shows the hint and makes NO gh call", async () => {
    let ghCalled = false;
    const ctx = ctxFor({ current: "main", branches: [["main", "now"]] });
    const wrapped: PlanContext = {
      ...ctx,
      run: async (argv, o) => {
        if (argv[0] === "gh") ghCalled = true;
        return ctx.run(argv, o);
      },
    };
    const d = await repoStatusPanel(wrapped);
    expect(d.text).toContain("aih report --team");
    expect(ghCalled).toBe(false);
  });
});

describe("repoStatusPanel — --team degradation ladder", () => {
  const base: Fixture = { current: "main", mainExists: "main", branches: [["main", "now"]] };

  it("tier 1: open PRs via gh (author + draft)", async () => {
    const prs = [
      {
        number: 12,
        headRefName: "feature/login",
        author: { login: "sam" },
        title: "Login",
        isDraft: false,
      },
      {
        number: 13,
        headRefName: "fix/typo",
        author: { login: "lee" },
        title: "Typo",
        isDraft: true,
      },
    ];
    const d = await repoStatusPanel(
      ctxFor({ ...base, gh: { stdout: JSON.stringify(prs) } }, { team: true }),
    );
    expect(d.describe).toContain("team via gh");
    expect(d.text).toContain("Open PRs");
    expect(d.text).toContain("#12");
    expect(d.text).toContain("feature/login");
    expect(d.text).toContain("@sam");
    expect(d.text).toContain("(draft)");
  });

  it("tier 2: git ls-remote when gh is blocked", async () => {
    const d = await repoStatusPanel(
      ctxFor(
        {
          ...base,
          gh: { code: 127, spawnError: true },
          lsRemote: "abc\trefs/heads/main\ndef\trefs/heads/feature/x",
        },
        { team: true },
      ),
    );
    expect(d.describe).toContain("team via ls-remote");
    expect(d.text).toContain("git ls-remote");
    expect(d.text).toContain("feature/x");
  });

  it("tier 3: last-fetched origin/* refs when gh and ls-remote are both blocked", async () => {
    const d = await repoStatusPanel(
      ctxFor(
        {
          ...base,
          gh: { code: 1 },
          lsRemote: null,
          fetchedRefs: "origin/HEAD\norigin/main\norigin/feature/y",
        },
        { team: true },
      ),
    );
    expect(d.describe).toContain("team via fetched");
    expect(d.text).toContain("LAST-FETCHED");
    expect(d.text).toContain("feature/y");
    expect(d.text).not.toContain("origin/HEAD"); // filtered out
  });

  it("tier none: nothing available (fully blocked / air-gapped)", async () => {
    const d = await repoStatusPanel(
      ctxFor(
        { ...base, gh: { code: 127, spawnError: true }, lsRemote: null, fetchedRefs: null },
        { team: true },
      ),
    );
    expect(d.describe).toContain("team via none");
    expect(d.text).toContain("No team data");
  });
});
