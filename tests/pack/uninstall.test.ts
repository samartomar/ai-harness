import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AihError } from "../../src/errors.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { packUninstallCommand } from "../../src/pack/uninstall.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const PIN = "a".repeat(40);
const CONTEXT_DIR = "ai-coding";

let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-pack-un-"));
  home = mkdtempSync(join(tmpdir(), "aih-pack-un-home-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/**
 * A ctx over the temp workspace — mirrors remove.test.ts: `run` defaults to a no-op
 * fake (git absent → nothing dirty → not gated); USERPROFILE/HOME isolate the machine
 * `~/.claude/skills` inventory root to the temp home.
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
        pack: "docs",
        scope: "repo",
        card: `${CONTEXT_DIR}/skill-cards/${name}.json`,
        evidenceSha256: "0".repeat(64),
        approvedBy: "docs-platform",
        approvedAt: "2026-01-01T00:00:00.000Z",
      })),
    }),
  );
}

/** Write the committed pack manifest — one pack per entry, refs from the shared pin. */
function writePacks(packs: Array<{ name: string; skills: string[] }>): void {
  write(
    "aih-packs.json",
    JSON.stringify({
      schemaVersion: 1,
      packs: packs.map((p) => ({
        name: p.name,
        skills: p.skills.map((name) => ({ name, source: `owner/repo@${PIN}`, commit: PIN })),
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

/** Files + card for one member (the lock is written once, for all members). */
function installFiles(id: string, name: string): void {
  promoteSkill(id, name);
  write(`${CONTEXT_DIR}/skill-cards/${name}.json`, JSON.stringify(validCard(name)));
}

const promotedDir = (id: string, name: string): string =>
  join(workspace, CONTEXT_DIR, "skills", id, name);
const legacyDir = (id: string, name: string): string =>
  join(workspace, ".aih", "legacy", CONTEXT_DIR, "skills", id, name);
const cardPath = (name: string): string =>
  join(workspace, CONTEXT_DIR, "skill-cards", `${name}.json`);

const readLock = (): { skills: Array<{ name: string }> } =>
  JSON.parse(readFileSync(join(workspace, "aih-skills.lock.json"), "utf8")) as {
    skills: Array<{ name: string }>;
  };

const manifestBytes = (): string => readFileSync(join(workspace, "aih-packs.json"), "utf8");

/**
 * The standard fixture: pack `docs` curates `alpha` (source src-a) and `beta`
 * (source src-b), both fully installed (dir + card + lock entry).
 */
function seedInstalledPack(): void {
  installFiles("src-a", "alpha");
  installFiles("src-b", "beta");
  writeLock(["alpha", "beta"]);
  writePacks([{ name: "docs", skills: ["alpha", "beta"] }]);
}

function digestOf(result: Awaited<ReturnType<typeof executePlan>>): {
  text: string;
  data: Record<string, unknown>;
} {
  const d = result.digests.find((x) => x.describe === "pack uninstall");
  return { text: d?.text ?? "", data: (d?.data ?? {}) as Record<string, unknown> };
}

/** Await the command's plan — async so a plan-time refusal REJECTS instead of throwing. */
const planOf = async (c: PlanContext) => packUninstallCommand.plan(c);

describe("packUninstallCommand — pack closure", () => {
  it("--apply uninstalls both members across two sources; manifest untouched", async () => {
    seedInstalledPack();
    const before = manifestBytes();
    const c = ctx({ apply: true, options: { pack: "docs" } });
    const result = await executePlan(await planOf(c), c);

    // Both dirs archived reversibly, both cards dropped, both approvals dropped.
    expect(existsSync(promotedDir("src-a", "alpha"))).toBe(false);
    expect(existsSync(promotedDir("src-b", "beta"))).toBe(false);
    expect(existsSync(join(legacyDir("src-a", "alpha"), "SKILL.md"))).toBe(true);
    expect(existsSync(join(legacyDir("src-b", "beta"), "SKILL.md"))).toBe(true);
    expect(existsSync(cardPath("alpha"))).toBe(false);
    expect(existsSync(cardPath("beta"))).toBe(false);
    // The composed lockfile writes ACCUMULATE — a per-member on-disk read would have
    // resurrected alpha's entry when beta's write landed. Final lock is empty.
    expect(readLock().skills).toEqual([]);
    // The pack MANIFEST is not touched — curation stays byte-for-byte.
    expect(manifestBytes()).toBe(before);
    // Per-member digest rows.
    const { text, data } = digestOf(result);
    expect(text).toContain("alpha  [removed]");
    expect(text).toContain("beta  [removed]");
    expect(text).toContain("manifest unchanged");
    expect(data.counts).toMatchObject({ members: 2, removed: 2, notInstalled: 0 });
  });

  it("--delete hard-deletes each member to <dir>.aih.bak instead of .aih/legacy/", async () => {
    seedInstalledPack();
    const c = ctx({ apply: true, options: { pack: "docs", delete: true } });
    const result = await executePlan(await planOf(c), c);

    expect(existsSync(`${promotedDir("src-a", "alpha")}.aih.bak`)).toBe(true);
    expect(existsSync(`${promotedDir("src-b", "beta")}.aih.bak`)).toBe(true);
    expect(existsSync(legacyDir("src-a", "alpha"))).toBe(false);
    expect(existsSync(legacyDir("src-b", "beta"))).toBe(false);
    expect(result.removed.some((r) => r.effect === "delete")).toBe(true);
    expect(digestOf(result).text).toContain(".aih.bak");
  });

  it("dry-run previews the composed plan but writes NOTHING", async () => {
    seedInstalledPack();
    const before = manifestBytes();
    const c = ctx({ apply: false, options: { pack: "docs" } });
    const result = await executePlan(await planOf(c), c);

    // Planned: 2 dir removes + 2 card removes, 2 lockfile writes — none executed.
    expect(result.removed).toHaveLength(4);
    expect(result.writes).toHaveLength(2);
    expect(existsSync(promotedDir("src-a", "alpha"))).toBe(true);
    expect(existsSync(promotedDir("src-b", "beta"))).toBe(true);
    expect(existsSync(cardPath("alpha"))).toBe(true);
    expect(readLock().skills).toHaveLength(2);
    expect(manifestBytes()).toBe(before);
  });

  it("a member with a duplicate physical copy refuses the WHOLE plan; nothing removed", async () => {
    seedInstalledPack();
    // A second physical copy of alpha under the repo `.claude` root → ambiguous.
    write(".claude/skills/alpha/SKILL.md", "# alpha\n");
    const c = ctx({ apply: true, options: { pack: "docs" } });
    try {
      await planOf(c);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(AihError);
      expect((e as AihError).code).toBe("AIH_TRUST");
      const msg = (e as AihError).message;
      expect(msg).toContain("pack docs: member alpha");
      expect(msg).toContain("physical installs");
      expect(msg).toContain("aih skill remove --name alpha");
    }
    // Plan-time refusal: every member's files and approvals are intact.
    expect(existsSync(promotedDir("src-a", "alpha"))).toBe(true);
    expect(existsSync(promotedDir("src-b", "beta"))).toBe(true);
    expect(readLock().skills).toHaveLength(2);
  });

  it("a quarantined-only member refuses the whole plan (restore first)", async () => {
    installFiles("src-a", "alpha");
    // beta exists ONLY as a parked quarantine copy (its approval survives).
    write(`.aih/quarantine/${CONTEXT_DIR}/skills/src-b/beta/SKILL.md`, "# parked\n");
    writeLock(["alpha", "beta"]);
    writePacks([{ name: "docs", skills: ["alpha", "beta"] }]);
    const c = ctx({ apply: true, options: { pack: "docs" } });
    try {
      await planOf(c);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(AihError);
      expect((e as AihError).code).toBe("AIH_TRUST");
      const msg = (e as AihError).message;
      expect(msg).toContain("pack docs: member beta");
      expect(msg).toContain("quarantined");
      expect(msg).toContain("restore");
    }
    expect(existsSync(promotedDir("src-a", "alpha"))).toBe(true);
  });

  it("a not-installed member is skipped with nothing-to-do; the others proceed", async () => {
    installFiles("src-a", "alpha");
    writeLock(["alpha"]);
    // `ghost` is curated but neither on disk nor in the lock.
    writePacks([{ name: "docs", skills: ["alpha", "ghost"] }]);
    const c = ctx({ apply: true, options: { pack: "docs" } });
    const result = await executePlan(await planOf(c), c);

    expect(existsSync(promotedDir("src-a", "alpha"))).toBe(false);
    expect(existsSync(join(legacyDir("src-a", "alpha"), "SKILL.md"))).toBe(true);
    expect(readLock().skills).toEqual([]);
    const { text, data } = digestOf(result);
    expect(text).toContain("ghost  [not installed]  nothing to do");
    expect(data.counts).toMatchObject({ members: 2, removed: 1, notInstalled: 1 });
  });

  it("an orphaned-approval member (dir gone, lock present) is cleaned like skill remove", async () => {
    installFiles("src-a", "alpha");
    installFiles("src-b", "beta");
    writeLock(["alpha", "beta"]);
    writePacks([{ name: "docs", skills: ["alpha", "beta"] }]);
    // beta's dir was deleted by hand — the approval + card survived, orphaned.
    rmSync(promotedDir("src-b", "beta"), { recursive: true, force: true });
    const c = ctx({ apply: true, options: { pack: "docs" } });
    const result = await executePlan(await planOf(c), c);

    expect(readLock().skills).toEqual([]); // both approvals dropped
    expect(existsSync(cardPath("beta"))).toBe(false); // orphan's card cleaned too
    const { text, data } = digestOf(result);
    expect(text).toContain("beta  [orphaned approval]");
    expect(data.counts).toMatchObject({ members: 2, removed: 1, orphanedApprovals: 1 });
  });

  it("refuses (AIH_TRUST) an unknown pack, an absent manifest, and a missing --pack", async () => {
    writePacks([{ name: "docs", skills: ["alpha"] }]);
    await expect(planOf(ctx({ options: { pack: "nope" } }))).rejects.toThrow(
      /no pack named "nope"/,
    );
    await expect(planOf(ctx({ options: {} }))).rejects.toThrow(/requires --pack/);
    rmSync(join(workspace, "aih-packs.json"), { force: true });
    await expect(planOf(ctx({ options: { pack: "docs" } }))).rejects.toThrow(/no aih-packs\.json/);
  });

  it("declares the uninstall command shape (mutator, --pack + --delete options)", () => {
    expect(packUninstallCommand.name).toBe("uninstall");
    expect(packUninstallCommand.readOnly).toBeUndefined();
    expect(packUninstallCommand.options?.map((o) => o.flags)).toEqual([
      "--pack <name>",
      "--delete",
    ]);
  });
});
