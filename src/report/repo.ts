import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";

/**
 * Repo / branch status for `aih report` (local scope). The default panel is
 * read-only LOCAL git only — branches, ahead/behind vs the main branch, dirty
 * state, staleness — and never touches the network. `aih report --team` opts into
 * a team view via a graceful degradation ladder (gh open PRs → `git ls-remote` →
 * last-fetched `origin/*` refs), so a blocked `gh`/network degrades instead of
 * failing. All git/gh calls go through the injected Runner, so tests stay hermetic.
 */

const MAX_BRANCHES = 20;
const MAIN_CANDIDATES = ["main", "master", "develop", "trunk"] as const;

/** Run a read-only git command scoped to the repo root; `undefined` on any failure. */
async function git(ctx: PlanContext, args: string[]): Promise<string | undefined> {
  const res = await ctx.run(["git", "-C", ctx.root, ...args]);
  if (res.spawnError || res.code !== 0) return undefined;
  return res.stdout.replace(/\s+$/, "");
}

interface BranchRow {
  name: string;
  age: string;
  ahead: number;
  behind: number;
}

interface LocalStatus {
  isRepo: boolean;
  current?: string;
  main?: string;
  dirty?: boolean;
  branches: BranchRow[];
}

/** The repo's main branch: origin/HEAD, else the first existing candidate, else current. */
async function mainBranch(ctx: PlanContext, current: string): Promise<string> {
  const head = await git(ctx, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  for (const c of MAIN_CANDIDATES) {
    if ((await git(ctx, ["rev-parse", "--verify", "--quiet", `refs/heads/${c}`])) !== undefined) {
      return c;
    }
  }
  return current;
}

/** Ahead/behind of `branch` vs `main` (left=main-only=behind, right=branch-only=ahead). */
async function aheadBehind(
  ctx: PlanContext,
  main: string,
  branch: string,
): Promise<{ ahead: number; behind: number }> {
  if (branch === main) return { ahead: 0, behind: 0 };
  const out = await git(ctx, ["rev-list", "--left-right", "--count", `${main}...${branch}`]);
  const [behind = 0, ahead = 0] = (out ?? "").split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
  return { ahead, behind };
}

/** Collect read-only local branch status. `isRepo:false` when the root isn't a git repo. */
export async function localStatus(ctx: PlanContext): Promise<LocalStatus> {
  if ((await git(ctx, ["rev-parse", "--is-inside-work-tree"])) !== "true") {
    return { isRepo: false, branches: [] };
  }
  const current = (await git(ctx, ["rev-parse", "--abbrev-ref", "HEAD"])) || "HEAD";
  const main = await mainBranch(ctx, current);
  const dirty = ((await git(ctx, ["status", "--porcelain"])) ?? "").length > 0;
  const refs = await git(ctx, [
    "for-each-ref",
    "--sort=-committerdate",
    `--count=${MAX_BRANCHES}`,
    "refs/heads",
    "--format=%(refname:short)%09%(committerdate:relative)",
  ]);
  const branches: BranchRow[] = [];
  for (const line of (refs ?? "").split("\n").filter(Boolean)) {
    const [name = "", age = ""] = line.split("\t");
    branches.push({ name, age, ...(await aheadBehind(ctx, main, name)) });
  }
  return { isRepo: true, current, main, dirty, branches };
}

function renderLocal(s: LocalStatus): string {
  const head = `On ${s.current} (${s.dirty ? "uncommitted changes" : "clean"}) · main = ${s.main}`;
  const rows = s.branches.map((b) => {
    const mark = b.name === s.current ? "*" : " ";
    if (b.name === s.main) return `  ${mark} ${b.name} (main) · ${b.age}`;
    return `  ${mark} ${b.name}  +${b.ahead}/-${b.behind} vs ${s.main}  · ${b.age}`;
  });
  return lines(head, "", ...(rows.length > 0 ? rows : ["  (no local branches)"]));
}

interface TeamView {
  tier: "gh" | "ls-remote" | "fetched" | "none";
  body: string;
  data: Record<string, unknown>;
}

interface GhPr {
  number: number;
  headRefName: string;
  author?: { login?: string };
  title: string;
  isDraft: boolean;
}

/** Team branch view via a degradation ladder: gh PRs → git ls-remote → fetched refs. */
async function teamView(ctx: PlanContext): Promise<TeamView> {
  // Tier 1 — gh: open PRs are the in-progress branches, with author + draft state.
  const pr = await ctx.run([
    "gh",
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "50",
    "--json",
    "number,headRefName,author,title,isDraft",
  ]);
  if (!pr.spawnError && pr.code === 0 && pr.stdout.trim().startsWith("[")) {
    try {
      const prs = JSON.parse(pr.stdout) as GhPr[];
      const body =
        prs.length > 0
          ? lines(
              "Open PRs — in-progress branches across the team:",
              "",
              ...prs.map(
                (p) =>
                  `  #${p.number}${p.isDraft ? " (draft)" : ""}  ${p.headRefName}  · @${p.author?.login ?? "?"}  · ${p.title}`,
              ),
            )
          : "No open PRs — no team branches in progress.";
      return { tier: "gh", body, data: { prs } };
    } catch {
      // fall through to the next tier on malformed JSON
    }
  }
  // Tier 2 — git ls-remote: live remote branch names without gh.
  const ls = await git(ctx, ["ls-remote", "--heads", "origin"]);
  if (ls !== undefined) {
    const names = ls
      .split("\n")
      .filter(Boolean)
      .map((l) => l.replace(/^.*\trefs\/heads\//, ""));
    return {
      tier: "ls-remote",
      body: lines(
        "`gh` unavailable — live remote branches via `git ls-remote`:",
        "",
        ...names.slice(0, 50).map((n) => `  ${n}`),
      ),
      data: { branches: names },
    };
  }
  // Tier 3 — last-fetched origin/* refs (works fully offline, may be stale).
  const fetched = await git(ctx, [
    "for-each-ref",
    "refs/remotes/origin",
    "--format=%(refname:short)",
  ]);
  if (fetched !== undefined && fetched.length > 0) {
    const names = fetched
      .split("\n")
      .filter(Boolean)
      .filter((n) => n !== "origin/HEAD");
    return {
      tier: "fetched",
      body: lines(
        "Network/`gh` blocked — showing LAST-FETCHED remote branches (may be stale;",
        "`git fetch` or `gh` gives live data):",
        "",
        ...names.slice(0, 50).map((n) => `  ${n}`),
      ),
      data: { branches: names, stale: true },
    };
  }
  return {
    tier: "none",
    body: "No team data available — no `gh`, no reachable remote, nothing fetched.",
    data: { available: false },
  };
}

/**
 * The repo/branch-status digest. Local-only and network-free by default; with
 * `--team` it appends the degradation-ladder team view.
 */
export async function repoStatusPanel(ctx: PlanContext): Promise<DigestAction> {
  const s = await localStatus(ctx);
  if (!s.isRepo) {
    return digest(
      "Repo status — not a git repository",
      lines("No git repository at the target root — `git init` to track branch status."),
      { isRepo: false },
    );
  }
  const team = ctx.options.team === true ? await teamView(ctx) : undefined;
  const body = team
    ? lines(renderLocal(s), "", "—", "", team.body)
    : lines(
        renderLocal(s),
        "",
        "  Team view: `aih report --team` lists in-progress branches across the team",
        "  (gh-backed, with offline fallback when gh/network is blocked).",
      );
  const wip = s.branches.filter((b) => b.name !== s.main && b.ahead > 0).length;
  const describe = `Repo status — on ${s.current}, ${s.branches.length} local branch(es), ${wip} ahead of ${s.main}${team ? ` · team via ${team.tier}` : ""}`;
  return digest(describe, body, {
    current: s.current,
    main: s.main,
    dirty: s.dirty,
    branches: s.branches,
    ...(team ? { team: { tier: team.tier, ...team.data } } : {}),
  });
}
