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
import type { SkillsLock } from "../../src/skill/lockfile.js";
import { removeSkillLockEntry } from "../../src/skill/lockfile.js";
import { skillRemoveCommand } from "../../src/skill/remove.js";

const PIN = "a".repeat(40);
const CONTEXT_DIR = "ai-coding";

let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-skill-rm-"));
  home = mkdtempSync(join(tmpdir(), "aih-skill-rm-home-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/**
 * A ctx over the temp workspace. `run` defaults to a no-op fake (git absent → nothing
 * dirty → not gated), matching inventory.test.ts. USERPROFILE isolates the machine
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

interface LockEntryInput {
  name: string;
  pack?: string;
}

/** Write a committed lockfile with the given approved skills (schemaVersion 1). */
function writeLock(entries: LockEntryInput[]): void {
  write(
    "aih-skills.lock.json",
    JSON.stringify({
      schemaVersion: 1,
      skills: entries.map((e) => ({
        name: e.name,
        source: `owner/repo@${PIN}`,
        commit: PIN,
        verdict: "GREEN",
        ...(e.pack ? { pack: e.pack } : {}),
        scope: "repo",
        card: `${CONTEXT_DIR}/skill-cards/${e.name}.json`,
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
function installApproved(id: string, name: string, pack?: string): void {
  promoteSkill(id, name);
  write(`${CONTEXT_DIR}/skill-cards/${name}.json`, JSON.stringify(validCard(name)));
  writeLock([{ name, pack }]);
}

const promotedDir = (id: string, name: string): string =>
  join(workspace, CONTEXT_DIR, "skills", id, name);
const legacyDir = (id: string, name: string): string =>
  join(workspace, ".aih", "legacy", CONTEXT_DIR, "skills", id, name);
const cardPath = (name: string): string =>
  join(workspace, CONTEXT_DIR, "skill-cards", `${name}.json`);

function digestData(result: Awaited<ReturnType<typeof executePlan>>): Record<string, unknown> {
  const d = result.digests.find((x) => x.describe === "skill remove");
  return (d?.data ?? {}) as Record<string, unknown>;
}

/** Await the command's plan (its `plan` field is typed `Plan | Promise<Plan>`). */
const planOf = (c: PlanContext) => Promise.resolve(skillRemoveCommand.plan(c));
/** The plan synchronously (the plan fn is sync) — used where a rejection is awaited. */
const planOfSync = (c: PlanContext) => skillRemoveCommand.plan(c) as Plan;

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

describe("skillRemoveCommand — the destructive inverse", () => {
  it("dry-run previews the move + lock drop but writes NOTHING", async () => {
    installApproved("owner-repo", "clean", "docs-quality");
    const c = ctx({ apply: false, options: { name: "clean" } });
    const plan = await planOf(c);
    const result = await executePlan(plan, c);

    // One remove (dir) + one lock write + one card remove + one digest.
    expect(result.removed.map((r) => r.effect)).toEqual(["remove", "remove"]);
    expect(result.writes).toHaveLength(1);
    // Nothing on disk changed: skill dir still present, no legacy archive, lock intact.
    expect(existsSync(promotedDir("owner-repo", "clean"))).toBe(true);
    expect(existsSync(legacyDir("owner-repo", "clean"))).toBe(false);
    expect(existsSync(cardPath("clean"))).toBe(true);
    const lock = JSON.parse(readFileSync(join(workspace, "aih-skills.lock.json"), "utf8"));
    expect(lock.skills).toHaveLength(1);
    expect(digestData(result)).toMatchObject({ droppedApproval: true, cardRemoved: true });
  });

  it("--apply moves the dir to .aih/legacy/, drops the lock entry, removes the card", async () => {
    installApproved("owner-repo", "clean", "docs-quality");
    const c = ctx({ apply: true, options: { name: "clean" } });
    await executePlan(await planOf(c), c);

    expect(existsSync(promotedDir("owner-repo", "clean"))).toBe(false);
    // The whole subtree moved atomically — SKILL.md rides along.
    expect(existsSync(join(legacyDir("owner-repo", "clean"), "SKILL.md"))).toBe(true);
    expect(existsSync(cardPath("clean"))).toBe(false);
    const lock = JSON.parse(readFileSync(join(workspace, "aih-skills.lock.json"), "utf8"));
    expect(lock.skills).toEqual([]);
  });

  it("--delete renames the dir to <dir>.aih.bak instead of .aih/legacy/", async () => {
    installApproved("owner-repo", "clean");
    const c = ctx({ apply: true, options: { name: "clean", delete: true } });
    const result = await executePlan(await planOf(c), c);

    expect(result.removed.some((r) => r.effect === "delete")).toBe(true);
    expect(existsSync(promotedDir("owner-repo", "clean"))).toBe(false);
    expect(existsSync(`${promotedDir("owner-repo", "clean")}.aih.bak`)).toBe(true);
    expect(existsSync(legacyDir("owner-repo", "clean"))).toBe(false);
  });

  it("removes an unapproved on-disk skill without writing the lockfile", async () => {
    // No lock entry, no card — just files on disk.
    promoteSkill("loose", "foo");
    const c = ctx({ apply: true, options: { name: "foo" } });
    const result = await executePlan(await planOf(c), c);

    expect(existsSync(promotedDir("loose", "foo"))).toBe(false);
    expect(existsSync(join(legacyDir("loose", "foo"), "SKILL.md"))).toBe(true);
    // Lock file was never created (no approval to drop).
    expect(existsSync(join(workspace, "aih-skills.lock.json"))).toBe(false);
    expect(result.writes).toHaveLength(0);
    expect(digestData(result)).toMatchObject({ droppedApproval: false, cardRemoved: false });
  });

  it("refuses (AIH_TRUST) when --name matches no installed skill", () => {
    installApproved("owner-repo", "clean");
    const c = ctx({ options: { name: "nope" } });
    expect(() => skillRemoveCommand.plan(c)).toThrow(AihError);
    try {
      skillRemoveCommand.plan(c);
    } catch (e) {
      expect((e as AihError).code).toBe("AIH_TRUST");
      expect((e as AihError).message).toContain("nothing to remove");
    }
  });

  it("refuses (AIH_TRUST) when --name is omitted", () => {
    installApproved("owner-repo", "clean");
    const c = ctx({ options: {} });
    expect(() => skillRemoveCommand.plan(c)).toThrow(/requires --name/);
  });

  it("refuses (AIH_TRUST) when the name is installed under multiple roots", () => {
    // Same name promoted AND under the repo `.claude` root → ambiguous.
    promoteSkill("a", "foo");
    write(".claude/skills/foo/SKILL.md", "# foo\n");
    const c = ctx({ options: { name: "foo" } });
    try {
      skillRemoveCommand.plan(c);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(AihError);
      expect((e as AihError).code).toBe("AIH_TRUST");
      expect((e as AihError).message).toContain("physical installs");
    }
  });

  it("refuses removing a live copy while a same-named QUARANTINED sibling exists (review medium)", () => {
    // The parked copy shares the name-keyed approval — removing the live install
    // would drop the lock entry + card the quarantined copy's restore relies on.
    installApproved("owner-repo", "clean");
    mkdirSync(join(workspace, ".aih/quarantine/ai-coding/skills/other-src/clean"), {
      recursive: true,
    });
    writeFileSync(
      join(workspace, ".aih/quarantine/ai-coding/skills/other-src/clean/SKILL.md"),
      "# parked\n",
    );
    const c = ctx({ apply: true, options: { name: "clean" } });
    expect(() => skillRemoveCommand.plan(c)).toThrow(
      /also has a quarantined copy .* restore or delete the quarantined copy first/s,
    );
    // Nothing changed: live copy, lock entry, and parked copy all intact.
    expect(existsSync(promotedDir("owner-repo", "clean"))).toBe(true);
  });

  it("refuses (AIH_TRUST) duplicate physical installs of the same name in ONE root (Codex high-1)", () => {
    // Two promoted SOURCES ship the same logical skill name; the inventory keeps one
    // row per physical dir, so the resolver must see BOTH and refuse — removing an
    // arbitrary copy while dropping the shared name-keyed approval would leave the
    // survivor active-but-unapproved.
    promoteSkill("source-a", "foo");
    promoteSkill("source-b", "foo");
    const c = ctx({ options: { name: "foo" } });
    try {
      skillRemoveCommand.plan(c);
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

  it("refuses (AIH_TRUST) removing a skill whose dir CONTAINS another skill (Codex high-2)", () => {
    // parent/ and parent/child/ are both valid discovered skills; moving parent/ would
    // take child/ as collateral while child's approval survives, dangling.
    promoteSkill("owner-repo", "parent");
    write("ai-coding/skills/owner-repo/parent/child/SKILL.md", "# child\n");
    const c = ctx({ options: { name: "parent" } });
    try {
      skillRemoveCommand.plan(c);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(AihError);
      expect((e as AihError).code).toBe("AIH_TRUST");
      const msg = (e as AihError).message;
      expect(msg).toContain("collateral");
      expect(msg).toContain("parent/child");
    }
  });

  it("drops an ORPHANED approval whose skill dir is already gone (review medium)", async () => {
    // The dir was deleted by hand; the committed lock entry + card survived. That
    // stale governance state is exactly this command's job — no file move, but the
    // approval and card are dropped rather than refusing with "nothing to remove".
    installApproved("owner-repo", "clean");
    rmSync(promotedDir("owner-repo", "clean"), { recursive: true, force: true });
    const c = ctx({ apply: true, options: { name: "clean" } });
    const result = await executePlan(await planOf(c), c);

    const lock = JSON.parse(readFileSync(join(workspace, "aih-skills.lock.json"), "utf8"));
    expect(lock.skills).toHaveLength(0); // orphaned entry dropped
    expect(existsSync(cardPath("clean"))).toBe(false); // card cleaned up too
    expect(result.removed.map((r) => r.path)).toEqual(["ai-coding/skill-cards/clean.json"]);
    expect(digestData(result)).toMatchObject({
      status: "orphaned-approval",
      droppedApproval: true,
      cardRemoved: true,
    });
  });

  it("still refuses when the name is in NEITHER the inventory nor the lockfile", () => {
    installApproved("owner-repo", "clean");
    const c = ctx({ options: { name: "ghost" } });
    expect(() => skillRemoveCommand.plan(c)).toThrow(/nothing to remove/);
  });

  it("removes a MALFORMED committed card by its canonical path (Codex low)", async () => {
    // The card exists at the canonical path but fails the schema — removal keys on
    // path EXISTENCE (never schema validity, never the lockfile's `card` field), so
    // stale review material is not orphaned by a destructive remove.
    installApproved("owner-repo", "clean");
    write("ai-coding/skill-cards/clean.json", "{ not valid json");
    const c = ctx({ apply: true, options: { name: "clean" } });
    const result = await executePlan(await planOf(c), c);
    expect(existsSync(join(workspace, "ai-coding/skill-cards/clean.json"))).toBe(false);
    expect(digestData(result)).toMatchObject({ cardRemoved: true });
  });

  it("refuses (AIH_TRUST) a skill installed only in the machine root", () => {
    // Lives under the isolated ~/.claude/skills — not this repo's to remove.
    writeHome(join(".claude", "skills", "globby", "SKILL.md"), "# globby\n");
    const c = ctx({ options: { name: "globby" } });
    try {
      skillRemoveCommand.plan(c);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(AihError);
      expect((e as AihError).code).toBe("AIH_TRUST");
      expect((e as AihError).message).toContain("machine root");
    }
  });

  it("surfaces a loader-ref advisory and leaves the loader file byte-for-byte unchanged", async () => {
    installApproved("owner-repo", "clean");
    const settingsRel = ".claude/settings.json";
    const settingsBody = JSON.stringify({ skills: ["clean"], other: true }, null, 2);
    write(settingsRel, settingsBody);
    const c = ctx({ apply: true, options: { name: "clean" } });
    const result = await executePlan(await planOf(c), c);

    const digest = result.digests.find((d) => d.describe === "skill remove");
    expect(digest?.text).toContain(`[manual] ${settingsRel} mentions "clean"`);
    expect((digestData(result).advisories as string[]).length).toBe(1);
    // The advisory NEVER edits the file — bytes must be identical after --apply.
    expect(readFileSync(join(workspace, settingsRel), "utf8")).toBe(settingsBody);
  });

  // Dirty-worktree gate — real git repo. The gate (dirtyRemoveTargets) matches a
  // removal action's path against `git status --porcelain -z -uall`. A file removal
  // target (the committed card) that is itself dirty is an exact match, so the whole
  // apply is refused without --force. NB: git's `-uall` reports individual FILES, so a
  // DIRECTORY-removal target whose children are dirty does NOT match by path — the
  // card is the file-granular guard that gates a dirty removal here (see report).
  it("refuses the apply when the committed card (a removal target) is dirty, without --force", () => {
    initGitRepoWithInstalledSkill();
    // Modify the committed card → it's a dirty file that IS a removal target.
    writeFileSync(cardPath("clean"), JSON.stringify({ ...validCard("clean"), extra: 1 }), "utf8");
    const c = gitCtx({ name: "clean" });
    return expect(executePlan(planOfSync(c), c)).rejects.toMatchObject({
      code: "AIH_DIRTY_WORKTREE",
    });
  }, 20000); // real git init + status subprocesses can edge past the 5s default on slow Windows CI

  it("proceeds past a dirty removal target when --force is passed", async () => {
    initGitRepoWithInstalledSkill();
    writeFileSync(cardPath("clean"), JSON.stringify({ ...validCard("clean"), extra: 1 }), "utf8");
    const c = gitCtx({ name: "clean", force: true });
    await executePlan(await planOf(c), c);
    expect(existsSync(promotedDir("owner-repo", "clean"))).toBe(false);
    expect(existsSync(join(legacyDir("owner-repo", "clean"), "SKILL.md"))).toBe(true);
    expect(existsSync(cardPath("clean"))).toBe(false);
  }, 20000); // real git init + status subprocesses can edge past the 5s default on slow Windows CI

  it("declares the remove command shape (mutator, --name + --delete options)", () => {
    expect(skillRemoveCommand.name).toBe("remove");
    expect(skillRemoveCommand.readOnly).toBeUndefined();
    expect(skillRemoveCommand.options?.map((o) => o.flags)).toEqual(["--name <skill>", "--delete"]);
  });
});

describe("removeSkillLockEntry", () => {
  const lock: SkillsLock = {
    schemaVersion: 1,
    skills: [
      {
        name: "alpha",
        source: `owner/repo@${PIN}`,
        commit: PIN,
        verdict: "GREEN",
        scope: "repo",
        card: `${CONTEXT_DIR}/skill-cards/alpha.json`,
        evidenceSha256: "0".repeat(64),
        approvedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        name: "beta",
        source: `owner/repo@${PIN}`,
        commit: PIN,
        verdict: "YELLOW",
        scope: "repo",
        card: `${CONTEXT_DIR}/skill-cards/beta.json`,
        evidenceSha256: "0".repeat(64),
        approvedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };

  it("drops the named entry and preserves the siblings", () => {
    const next = removeSkillLockEntry(lock, "alpha");
    expect(next.schemaVersion).toBe(1);
    expect(next.skills.map((s) => s.name)).toEqual(["beta"]);
    // Immutable — the input is untouched.
    expect(lock.skills).toHaveLength(2);
  });

  it("is a no-op for an absent name", () => {
    expect(removeSkillLockEntry(lock, "missing").skills.map((s) => s.name)).toEqual([
      "alpha",
      "beta",
    ]);
  });
});
