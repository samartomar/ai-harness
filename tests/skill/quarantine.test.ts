import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AihError } from "../../src/errors.js";
import { executePlan } from "../../src/internals/execute.js";
import type { Plan, PlanContext } from "../../src/internals/plan.js";
import { defaultRunner, fakeRunner, type Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { skillInventory, skillInventoryCommand } from "../../src/skill/inventory.js";
import { skillQuarantineCommand } from "../../src/skill/quarantine.js";
import { skillRemoveCommand } from "../../src/skill/remove.js";

const PIN = "a".repeat(40);
const CONTEXT_DIR = "ai-coding";

let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-skill-q-"));
  home = mkdtempSync(join(tmpdir(), "aih-skill-q-home-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/**
 * A ctx over the temp workspace. `run` defaults to a no-op fake (git absent → nothing
 * dirty → not gated), matching remove.test.ts. USERPROFILE isolates the machine
 * `~/.claude/skills` root to the temp home so the machine-root guard is exercisable.
 */
function ctx(
  opts: { apply?: boolean; options?: Record<string, unknown>; run?: Runner } = {},
): PlanContext {
  const run = opts.run ?? fakeRunner(() => undefined);
  return {
    root: workspace,
    contextDir: CONTEXT_DIR,
    apply: opts.apply ?? false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { USERPROFILE: home, HOME: home } }),
    env: { USERPROFILE: home, HOME: home },
    posture: "vibe",
    options: opts.options ?? {},
  };
}

function write(rel: string, body: string): void {
  const path = join(workspace, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function writeHome(rel: string, body: string): void {
  const path = join(home, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

/** Write a committed lockfile with the given approved skills (schemaVersion 1). */
function writeLock(names: string[]): void {
  write(
    "aih-skills.lock.json",
    JSON.stringify({
      schemaVersion: 1,
      skills: names.map((name) => ({
        name,
        source: `owner/repo@${PIN}`,
        commit: PIN,
        verdict: "GREEN",
        scope: "repo",
        card: `${CONTEXT_DIR}/skill-cards/${name}.json`,
        evidenceSha256: "0".repeat(64),
        approvedBy: "docs-platform",
        approvedAt: "2026-01-01T00:00:00.000Z",
      })),
    }),
  );
}

/** A minimal valid committed SkillCard body. */
function validCard(name: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name,
    source: `owner/repo@${PIN}`,
    commit: PIN,
    license: "MIT License",
    installScope: "repo",
    riskClass: "green",
    requiresMcp: false,
    requiresShell: false,
    scanEvidence: [`.aih/skill-reports/owner-repo-${PIN.slice(0, 8)}.json`],
  };
}

/** A promoted skill dir at `<ctx>/skills/<id>/<name>/SKILL.md`. */
function promoteSkill(id: string, name: string): void {
  write(join(CONTEXT_DIR, "skills", id, name, "SKILL.md"), `# ${name}\n`);
}

/** Fully install an APPROVED promoted skill: files + card + lockfile entry. */
function installApproved(id: string, name: string): void {
  promoteSkill(id, name);
  write(`${CONTEXT_DIR}/skill-cards/${name}.json`, JSON.stringify(validCard(name)));
  writeLock([name]);
}

const promotedDir = (id: string, name: string): string =>
  join(workspace, CONTEXT_DIR, "skills", id, name);
const quarantineDir = (id: string, name: string): string =>
  join(workspace, ".aih", "quarantine", CONTEXT_DIR, "skills", id, name);
const cardPath = (name: string): string =>
  join(workspace, CONTEXT_DIR, "skill-cards", `${name}.json`);
const lockPath = (): string => join(workspace, "aih-skills.lock.json");

function digestData(result: Awaited<ReturnType<typeof executePlan>>): Record<string, unknown> {
  const d = result.digests.find((x) => x.describe === "skill quarantine");
  return (d?.data ?? {}) as Record<string, unknown>;
}

/** Await the command's plan (its `plan` field is typed `Plan | Promise<Plan>`). */
const planOf = (c: PlanContext) => Promise.resolve(skillQuarantineCommand.plan(c));
/** The plan synchronously (the plan fn is sync) — used where a rejection is awaited. */
const planOfSync = (c: PlanContext) => skillQuarantineCommand.plan(c) as Plan;

/** Quarantine `name` end-to-end under --apply (the setup step for restore-side tests). */
async function applyQuarantine(name: string): Promise<void> {
  const c = ctx({ apply: true, options: { name } });
  await executePlan(await planOf(c), c);
}

const git = (...args: string[]): void => {
  execFileSync("git", ["-C", workspace, ...args], { stdio: "ignore" });
};

/**
 * A ctx whose runner really shells git (so the dirty-worktree gate observes the temp
 * repo's true status) — the rest of the tests use the hermetic no-op fake.
 */
function gitCtx(options: Record<string, unknown>): PlanContext {
  return ctx({ apply: true, options, run: defaultRunner });
}

/** Init a real git repo, install + commit an approved skill so its files are TRACKED. */
function initGitRepoWithInstalledSkill(): void {
  git("init", "-q");
  git("config", "user.email", "t@t.com");
  git("config", "user.name", "t");
  installApproved("owner-repo", "clean");
  git("add", "-A");
  git("commit", "-qm", "base");
}

describe("skillQuarantineCommand — disable without removing", () => {
  it("dry-run previews the move but writes NOTHING (lock + card + dir untouched)", async () => {
    installApproved("owner-repo", "clean");
    const c = ctx({ apply: false, options: { name: "clean" } });
    const result = await executePlan(await planOf(c), c);

    // Exactly one remove (the dir) — NO lock write, NO card removal.
    expect(result.removed).toEqual([
      {
        path: "ai-coding/skills/owner-repo/clean",
        describe: "quarantine skill clean (approved)",
        effect: "remove",
        to: ".aih/quarantine/ai-coding/skills/owner-repo/clean",
      },
    ]);
    expect(result.writes).toHaveLength(0);
    expect(existsSync(promotedDir("owner-repo", "clean"))).toBe(true);
    expect(existsSync(join(workspace, ".aih", "quarantine"))).toBe(false);
    expect(existsSync(cardPath("clean"))).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).skills).toHaveLength(1);
  });

  it("--apply moves the dir to .aih/quarantine/, KEEPING the lock entry and the card", async () => {
    installApproved("owner-repo", "clean");
    const c = ctx({ apply: true, options: { name: "clean" } });
    const result = await executePlan(await planOf(c), c);

    expect(existsSync(promotedDir("owner-repo", "clean"))).toBe(false);
    // The whole subtree moved atomically — SKILL.md rides along.
    expect(existsSync(join(quarantineDir("owner-repo", "clean"), "SKILL.md"))).toBe(true);
    // The difference from `remove`: approval + card INTACT (disable, don't retract).
    const lock = JSON.parse(readFileSync(lockPath(), "utf8"));
    expect(lock.skills.map((s: { name: string }) => s.name)).toEqual(["clean"]);
    expect(existsSync(cardPath("clean"))).toBe(true);

    const digest = result.digests.find((d) => d.describe === "skill quarantine");
    expect(digestData(result)).toMatchObject({
      name: "clean",
      approvalKept: true,
      from: "ai-coding/skills/owner-repo/clean",
      to: ".aih/quarantine/ai-coding/skills/owner-repo/clean",
    });
    expect(digest?.text).toContain("Approval: kept");
    // The exact restore path is printed for the manual move-back.
    expect(digest?.text).toContain(
      "Restore: move .aih/quarantine/ai-coding/skills/owner-repo/clean back to " +
        "ai-coding/skills/owner-repo/clean",
    );
  });

  it("inventory surfaces the parked copy as quarantined, excluded from the approved counts", async () => {
    installApproved("owner-repo", "clean");
    await applyQuarantine("clean");

    const inv = skillInventory(ctx());
    expect(inv.counts).toMatchObject({
      installed: 1,
      approved: 0,
      unapproved: 0,
      stalePin: 0,
      quarantined: 1,
    });
    expect(inv.skills).toHaveLength(1);
    expect(inv.skills[0]).toMatchObject({
      name: "clean",
      root: "quarantined",
      status: "quarantined",
    });
    // The quarantined inventory root is present and reported.
    expect(inv.roots.find((r) => r.label === "quarantined")?.present).toBe(true);
  });

  it("the inventory digest gains the quarantined header count + a restore-note section", async () => {
    installApproved("owner-repo", "clean");
    await applyQuarantine("clean");
    const c = ctx();
    const result = await executePlan(await skillInventoryCommand.plan(c), c);
    const digest = result.digests.find((d) => d.describe === "skill inventory");
    expect(digest?.text).toContain(
      "1 installed · 0 approved · 0 unapproved · 0 stale · 1 quarantined",
    );
    expect(digest?.text).toContain("quarantined:");
    expect(digest?.text).toContain("clean  [quarantined]  (move back to restore)");
  });

  it("skill remove refuses a quarantined skill — restore it first", async () => {
    installApproved("owner-repo", "clean");
    await applyQuarantine("clean");
    const c = ctx({ options: { name: "clean" } });
    try {
      skillRemoveCommand.plan(c);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(AihError);
      expect((e as AihError).code).toBe("AIH_TRUST");
      const msg = (e as AihError).message;
      expect(msg).toContain("restore it first");
      expect(msg).toContain(".aih/quarantine/ai-coding/skills/owner-repo/clean");
    }
  });

  it("refuses (AIH_TRUST) when --name is omitted", () => {
    installApproved("owner-repo", "clean");
    const c = ctx({ options: {} });
    expect(() => skillQuarantineCommand.plan(c)).toThrow(/requires --name/);
  });

  it("refuses (AIH_TRUST) when --name matches no installed skill", () => {
    installApproved("owner-repo", "clean");
    const c = ctx({ options: { name: "nope" } });
    try {
      skillQuarantineCommand.plan(c);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(AihError);
      expect((e as AihError).code).toBe("AIH_TRUST");
      expect((e as AihError).message).toContain("nothing to quarantine");
    }
  });

  it("refuses re-quarantining an ALREADY quarantined skill, naming the restore path", async () => {
    installApproved("owner-repo", "clean");
    await applyQuarantine("clean");
    const c = ctx({ options: { name: "clean" } });
    try {
      skillQuarantineCommand.plan(c);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(AihError);
      expect((e as AihError).code).toBe("AIH_TRUST");
      const msg = (e as AihError).message;
      expect(msg).toContain(
        "already quarantined at .aih/quarantine/ai-coding/skills/owner-repo/clean",
      );
      expect(msg).toContain("move it back to restore");
    }
  });

  it("refuses an orphaned approval (in the lock, not on disk) — that is remove's job", () => {
    installApproved("owner-repo", "clean");
    rmSync(promotedDir("owner-repo", "clean"), { recursive: true, force: true });
    const c = ctx({ options: { name: "clean" } });
    try {
      skillQuarantineCommand.plan(c);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(AihError);
      expect((e as AihError).code).toBe("AIH_TRUST");
      const msg = (e as AihError).message;
      expect(msg).toContain("already gone");
      expect(msg).toContain("aih skill remove --name clean");
    }
  });

  it("refuses (AIH_TRUST) an ambiguous name with multiple physical installs", () => {
    promoteSkill("source-a", "foo");
    promoteSkill("source-b", "foo");
    const c = ctx({ options: { name: "foo" } });
    try {
      skillQuarantineCommand.plan(c);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(AihError);
      expect((e as AihError).code).toBe("AIH_TRUST");
      const msg = (e as AihError).message;
      expect(msg).toContain("2 physical installs");
      expect(msg).toContain("source-a/foo");
      expect(msg).toContain("source-b/foo");
    }
  });

  it("refuses (AIH_TRUST) a skill installed only in the machine root", () => {
    writeHome(join(".claude", "skills", "globby", "SKILL.md"), "# globby\n");
    const c = ctx({ options: { name: "globby" } });
    try {
      skillQuarantineCommand.plan(c);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(AihError);
      expect((e as AihError).code).toBe("AIH_TRUST");
      expect((e as AihError).message).toContain("machine root");
    }
  });

  it("refuses (AIH_TRUST) quarantining a skill whose dir CONTAINS another skill", () => {
    promoteSkill("owner-repo", "parent");
    write("ai-coding/skills/owner-repo/parent/child/SKILL.md", "# child\n");
    const c = ctx({ options: { name: "parent" } });
    try {
      skillQuarantineCommand.plan(c);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(AihError);
      expect((e as AihError).code).toBe("AIH_TRUST");
      const msg = (e as AihError).message;
      expect(msg).toContain("collateral");
      expect(msg).toContain("parent/child");
    }
  });

  // Dirty-worktree gate — real git repo. The removal target is the skill DIRECTORY;
  // the directory-aware gate (dirtyRemoveTargets) matches a dirty file INSIDE it as a
  // descendant, so an uncommitted edit to SKILL.md blocks the move without --force.
  it("refuses the apply when a file inside the skill dir is dirty, without --force", () => {
    initGitRepoWithInstalledSkill();
    writeFileSync(join(promotedDir("owner-repo", "clean"), "SKILL.md"), "# edited\n", "utf8");
    const c = gitCtx({ name: "clean" });
    return expect(executePlan(planOfSync(c), c)).rejects.toMatchObject({
      code: "AIH_DIRTY_WORKTREE",
    });
  }, 20000); // real git init + status subprocesses can edge past the 5s default on slow Windows CI

  it("proceeds past a dirty skill dir when --force is passed", async () => {
    initGitRepoWithInstalledSkill();
    writeFileSync(join(promotedDir("owner-repo", "clean"), "SKILL.md"), "# edited\n", "utf8");
    const c = gitCtx({ name: "clean", force: true });
    await executePlan(await planOf(c), c);
    expect(existsSync(promotedDir("owner-repo", "clean"))).toBe(false);
    // The dirty edit rides into quarantine — nothing is lost.
    expect(readFileSync(join(quarantineDir("owner-repo", "clean"), "SKILL.md"), "utf8")).toBe(
      "# edited\n",
    );
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).skills).toHaveLength(1);
  }, 20000); // real git init + status subprocesses can edge past the 5s default on slow Windows CI

  it("REFUSES a second quarantine while a parked copy occupies the destination (Codex high)", async () => {
    // The engine's never-overwrite fallback would park the second copy at a `.1`
    // sibling — but every printed restore path would then name the OLDER payload
    // under the kept approval, steering a restore to the wrong bytes. The command
    // fails closed instead; the `.1` machinery remains as engine-level defense.
    installApproved("owner-repo", "clean");
    await applyQuarantine("clean");
    // Re-install the same skill by hand (lock + card are still intact by design).
    promoteSkill("owner-repo", "clean");

    const c = ctx({ apply: true, options: { name: "clean" } });
    expect(() => skillQuarantineCommand.plan(c)).toThrow(
      /a quarantined copy of clean already exists at .* restore it/s,
    );
    // Nothing moved: the live re-install and the original parked copy both survive.
    expect(existsSync(join(promotedDir("owner-repo", "clean"), "SKILL.md"))).toBe(true);
    expect(existsSync(join(quarantineDir("owner-repo", "clean"), "SKILL.md"))).toBe(true);
    expect(existsSync(`${quarantineDir("owner-repo", "clean")}.1`)).toBe(false);
  });

  it("quarantines a repo-root .claude/skills skill with the bare name (review low)", async () => {
    // The non-promoted branch of quarantinedSkillName: no id segment to strip.
    write(".claude/skills/rooty/SKILL.md", "# rooty\n");
    const c = ctx({ apply: true, options: { name: "rooty" } });
    const result = await executePlan(await planOf(c), c);
    expect(existsSync(join(workspace, ".aih/quarantine/.claude/skills/rooty/SKILL.md"))).toBe(true);
    expect(existsSync(join(workspace, ".claude/skills/rooty"))).toBe(false);
    const d = result.digests.find((x) => x.describe === "skill quarantine");
    expect(d?.text).toContain(".aih/quarantine/.claude/skills/rooty");
    // Inventory reports it quarantined under its bare name.
    const inv = skillInventory(c);
    const row = inv.skills.find((s) => s.status === "quarantined");
    expect(row?.name).toBe("rooty");
  });

  it("declares the quarantine command shape (mutator, --name option, no --delete)", () => {
    expect(skillQuarantineCommand.name).toBe("quarantine");
    expect(skillQuarantineCommand.readOnly).toBeUndefined();
    expect(skillQuarantineCommand.options?.map((o) => o.flags)).toEqual(["--name <skill>"]);
  });
});
