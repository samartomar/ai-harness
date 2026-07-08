import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AihError } from "../../src/errors.js";
import { executePlan } from "../../src/internals/execute.js";
import type { CommandSpec, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  packAddCommand,
  packInitCommand,
  packRemoveEntryCommand,
} from "../../src/pack/authoring.js";
import type { PacksFile } from "../../src/pack/manifest.js";
import { readPacksFileStrictForWrite } from "../../src/pack/manifest.js";
import { packStatus, packValidateCommand } from "../../src/pack/status.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const PIN = "a".repeat(40);
const CONTEXT_DIR = "ai-coding";

let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-pack-authoring-"));
  home = mkdtempSync(join(tmpdir(), "aih-pack-authoring-home-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/**
 * A ctx over the temp workspace. `run` is a no-op fake (git absent → nothing dirty →
 * not gated), matching remove.test.ts. USERPROFILE isolates the machine
 * `~/.claude/skills` root to the temp home.
 */
function ctx(
  opts: { apply?: boolean; verify?: boolean; options?: Record<string, unknown> } = {},
): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: workspace,
    contextDir: CONTEXT_DIR,
    apply: opts.apply ?? false,
    verify: opts.verify ?? false,
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

interface LockEntryInput {
  name: string;
  source?: string;
  commit?: string;
  pack?: string;
}

/** Write a committed lockfile with the given approved skills (like status.test.ts's). */
function writeLock(entries: LockEntryInput[]): void {
  write(
    "aih-skills.lock.json",
    JSON.stringify({
      schemaVersion: 1,
      skills: entries.map((e) => ({
        name: e.name,
        source: e.source ?? `owner/repo@${PIN}`,
        commit: e.commit ?? PIN,
        verdict: "GREEN",
        ...(e.pack !== undefined ? { pack: e.pack } : {}),
        scope: "repo",
        card: `${CONTEXT_DIR}/skill-cards/${e.name}.json`,
        evidenceSha256: "0".repeat(64),
        approvedBy: "docs-platform",
        approvedAt: "2026-01-01T00:00:00.000Z",
      })),
    }),
  );
}

/** Write the committed pack manifest (raw entries allowed, for the fail-closed guard tests). */
function writePacks(packs: unknown[]): void {
  write("aih-packs.json", JSON.stringify({ schemaVersion: 1, packs }));
}

/** The manifest ref authoring derives from writeLock's defaults for `name`. */
function derivedRef(name: string): { name: string; source: string; commit: string } {
  return { name, source: `owner/repo@${PIN}`, commit: PIN };
}

/** The on-disk manifest, parsed raw (what a fresh clone would actually read). */
function manifestOnDisk(): PacksFile {
  return JSON.parse(readFileSync(join(workspace, "aih-packs.json"), "utf8")) as PacksFile;
}

const manifestPath = (): string => join(workspace, "aih-packs.json");

/** Plan + execute `command` under --apply against the temp workspace. */
async function applyPlan(
  command: CommandSpec,
  options: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof executePlan>>> {
  const c = ctx({ apply: true, options });
  return executePlan(await command.plan(c), c);
}

/** Assert `fn` throws a fail-closed AIH_TRUST refusal whose message matches `pattern`. */
function expectRefusal(fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
    throw new Error("expected an AIH_TRUST refusal");
  } catch (e) {
    expect(e).toBeInstanceOf(AihError);
    expect((e as AihError).code).toBe("AIH_TRUST");
    expect((e as AihError).message).toMatch(pattern);
  }
}

describe("readPacksFileStrictForWrite — the fail-closed authoring read", () => {
  it("starts fresh when the file is absent", () => {
    expect(readPacksFileStrictForWrite(workspace)).toEqual({ schemaVersion: 1, packs: [] });
  });

  it("refuses when the raw file is not valid JSON", () => {
    write("aih-packs.json", "{ not json");
    expectRefusal(() => readPacksFileStrictForWrite(workspace), /is not valid JSON/);
  });

  it("refuses when a pack the fail-soft read would drop is present", () => {
    writePacks([{ name: "docs", skills: [derivedRef("clean")] }, { name: "broken" }]);
    expectRefusal(
      () => readPacksFileStrictForWrite(workspace),
      /contains entries aih cannot parse — fix them by hand first/,
    );
  });
});

describe("pack add", () => {
  it("previews the manifest write on dry-run and writes NOTHING", async () => {
    writeLock([{ name: "clean" }]);
    const c = ctx({ options: { pack: "docs", skill: "clean" } });
    const result = await executePlan(await packAddCommand.plan(c), c);
    expect(result.applied).toBe(false);
    expect(result.writes).toEqual([
      expect.objectContaining({ path: "aih-packs.json", effect: "create" }),
    ]);
    expect(existsSync(manifestPath())).toBe(false); // dry-run: nothing on disk
  });

  it("creates the file + pack from nothing under --apply, refs derived exactly from the lock", async () => {
    // Both pin shapes the lock can carry: a 40-hex GitHub commit and "local".
    writeLock([{ name: "clean" }, { name: "tidy", source: "local", commit: "local" }]);
    await applyPlan(packAddCommand, { pack: "docs", skill: "clean", description: "docs set" });
    const result = await applyPlan(packAddCommand, { pack: "docs", skill: "tidy" });
    expect(manifestOnDisk()).toEqual({
      schemaVersion: 1,
      packs: [
        {
          name: "docs",
          description: "docs set",
          skills: [derivedRef("clean"), { name: "tidy", source: "local", commit: "local" }],
        },
      ],
    });
    const digest = result.digests.find((d) => d.describe === "pack add");
    expect(digest?.text).toContain("Pack: docs (updated — 2 skills)");
    expect(digest?.text).toContain("Skill: tidy  (local@local)");
    expect(digest?.text).toContain("Rollup: ready");
    expect(digest?.data).toMatchObject({
      pack: "docs",
      skill: "tidy",
      source: "local",
      commit: "local",
      created: false,
      packSize: 2,
      rollup: "ready",
    });
  });

  it("keeps skills name-sorted when adds arrive in reverse alphabetical order, and packs sorted", async () => {
    writeLock([{ name: "alpha" }, { name: "zulu" }]);
    await applyPlan(packAddCommand, { pack: "zz-ops", skill: "zulu" });
    await applyPlan(packAddCommand, { pack: "aa-docs", skill: "alpha" });
    const manifest = manifestOnDisk();
    expect(manifest.packs.map((p) => p.name)).toEqual(["aa-docs", "zz-ops"]);
    // Now reverse-alphabetical adds INSIDE one pack.
    writeLock([{ name: "alpha" }, { name: "zulu" }, { name: "mike" }]);
    await applyPlan(packRemoveEntryCommand, { pack: "aa-docs", skill: "alpha" });
    await applyPlan(packAddCommand, { pack: "zz-ops", skill: "mike" });
    await applyPlan(packAddCommand, { pack: "zz-ops", skill: "alpha" });
    expect(manifestOnDisk().packs.map((p) => p.name)).toEqual(["zz-ops"]);
    expect(manifestOnDisk().packs[0]?.skills.map((s) => s.name)).toEqual(["alpha", "mike", "zulu"]);
  });

  it("refuses a skill with no lock entry (not approved)", () => {
    writeLock([{ name: "clean" }]);
    expectRefusal(
      () => packAddCommand.plan(ctx({ options: { pack: "docs", skill: "ghost" } })),
      /skill ghost is not approved — run `aih skill vet` \+ `aih skill approve` first/,
    );
    expect(existsSync(manifestPath())).toBe(false);
  });

  it("refuses a skill already in the target pack", () => {
    writeLock([{ name: "clean" }]);
    writePacks([{ name: "docs", skills: [derivedRef("clean")] }]);
    expectRefusal(
      () => packAddCommand.plan(ctx({ options: { pack: "docs", skill: "clean" } })),
      /skill clean is already in pack docs — nothing to add/,
    );
  });

  it("refuses a skill already in a DIFFERENT pack, naming it and suggesting remove-entry", () => {
    writeLock([{ name: "clean" }]);
    writePacks([{ name: "ops", skills: [derivedRef("clean")] }]);
    expectRefusal(
      () => packAddCommand.plan(ctx({ options: { pack: "docs", skill: "clean" } })),
      /already in pack ops[\s\S]*pack\.duplicate-name[\s\S]*pack remove-entry --pack ops --skill clean/,
    );
  });

  it("refuses (fail-closed) when a malformed sibling pack would be dropped by a rewrite", () => {
    writeLock([{ name: "clean" }, { name: "tidy" }]);
    // "broken" fails the schema; the fail-soft read would drop it — a rewrite
    // built on that read would silently DELETE the operator's pack.
    writePacks([{ name: "docs", skills: [derivedRef("clean")] }, { name: "broken" }]);
    expectRefusal(
      () => packAddCommand.plan(ctx({ options: { pack: "docs", skill: "tidy" } })),
      /aih-packs\.json contains entries aih cannot parse — fix them by hand first/,
    );
    // Nothing changed: the malformed sibling survives byte-for-byte.
    expect(readFileSync(manifestPath(), "utf8")).toContain('"broken"');
  });

  it("refuses when --pack or --skill is missing", () => {
    writeLock([{ name: "clean" }]);
    expectRefusal(
      () => packAddCommand.plan(ctx({ options: { skill: "clean" } })),
      /pack add requires --pack/,
    );
    expectRefusal(
      () => packAddCommand.plan(ctx({ options: { pack: "docs" } })),
      /pack add requires --skill/,
    );
  });

  it("refuses unsafe pack and skill names before writing", () => {
    writeLock([{ name: "clean" }]);
    expectRefusal(
      () => packAddCommand.plan(ctx({ options: { pack: "../x", skill: "clean" } })),
      /pack add requires a safe --pack value/,
    );
    expectRefusal(
      () => packAddCommand.plan(ctx({ options: { pack: "docs", skill: "../x" } })),
      /pack add requires a safe --skill value/,
    );
    expect(existsSync(manifestPath())).toBe(false);
  });
});

describe("pack remove-entry", () => {
  it("removes a ref while the pack keeps its other skills", async () => {
    writeLock([{ name: "clean" }, { name: "tidy" }]);
    writePacks([{ name: "docs", skills: [derivedRef("clean"), derivedRef("tidy")] }]);
    const result = await applyPlan(packRemoveEntryCommand, { pack: "docs", skill: "clean" });
    expect(manifestOnDisk().packs).toEqual([{ name: "docs", skills: [derivedRef("tidy")] }]);
    const digest = result.digests.find((d) => d.describe === "pack remove-entry");
    expect(digest?.text).toContain("Pack: docs (now 1 skill)");
    expect(digest?.text).toContain("Approval: untouched — clean stays approved");
    expect(digest?.data).toMatchObject({ pack: "docs", skill: "clean", packDropped: false });
  });

  it("drops the whole pack when its last skill is removed, and the digest says so", async () => {
    writeLock([{ name: "clean" }]);
    writePacks([
      { name: "docs", skills: [derivedRef("clean")] },
      { name: "ops", skills: [derivedRef("clean")] }, // sibling survives untouched
    ]);
    const result = await applyPlan(packRemoveEntryCommand, { pack: "docs", skill: "clean" });
    expect(manifestOnDisk().packs.map((p) => p.name)).toEqual(["ops"]);
    const digest = result.digests.find((d) => d.describe === "pack remove-entry");
    expect(digest?.text).toContain("dropped — its last skill was removed");
    expect(digest?.text).toContain("a pack needs at least one skill ref");
    expect(digest?.data).toMatchObject({ packDropped: true, packSize: 0 });
  });

  it("refuses a pack that is not in the manifest", () => {
    writePacks([{ name: "docs", skills: [derivedRef("clean")] }]);
    expectRefusal(
      () => packRemoveEntryCommand.plan(ctx({ options: { pack: "ghost", skill: "clean" } })),
      /no pack named ghost in aih-packs\.json/,
    );
  });

  it("refuses a skill that is not in that pack", () => {
    writePacks([{ name: "docs", skills: [derivedRef("clean")] }]);
    expectRefusal(
      () => packRemoveEntryCommand.plan(ctx({ options: { pack: "docs", skill: "tidy" } })),
      /skill tidy is not in pack docs/,
    );
  });
});

describe("pack init", () => {
  it("refuses unsafe pack names before reading approvals", () => {
    expectRefusal(
      () => packInitCommand.plan(ctx({ options: { pack: "../x" } })),
      /pack init requires a safe --pack value/,
    );
  });

  it("seeds a pack from every lock entry tagged pack=<pack>, name-sorted", async () => {
    writeLock([
      { name: "zulu", pack: "docs" },
      { name: "alpha", pack: "docs" },
      { name: "other", pack: "ops" },
      { name: "untagged" },
    ]);
    const result = await applyPlan(packInitCommand, { pack: "docs", description: "the docs set" });
    expect(manifestOnDisk()).toEqual({
      schemaVersion: 1,
      packs: [
        {
          name: "docs",
          description: "the docs set",
          skills: [derivedRef("alpha"), derivedRef("zulu")],
        },
      ],
    });
    const digest = result.digests.find((d) => d.describe === "pack init");
    expect(digest?.text).toContain("Pack: docs (created — 2 skills tagged pack=docs)");
    expect(digest?.text).toContain(`  - alpha  (owner/repo@${PIN}@${PIN.slice(0, 12)})`);
    expect(digest?.text).toContain(`  - zulu  (owner/repo@${PIN}@${PIN.slice(0, 12)})`);
    expect(digest?.data).toMatchObject({ pack: "docs", packSize: 2, rollup: "ready" });
  });

  it("refuses a pack that already exists in the manifest", () => {
    writeLock([{ name: "clean", pack: "docs" }]);
    writePacks([{ name: "docs", skills: [derivedRef("clean")] }]);
    expectRefusal(
      () => packInitCommand.plan(ctx({ options: { pack: "docs" } })),
      /pack docs already exists in aih-packs\.json/,
    );
  });

  it("refuses when no lock entries carry the tag", () => {
    writeLock([{ name: "clean", pack: "ops" }, { name: "tidy" }]);
    expectRefusal(
      () => packInitCommand.plan(ctx({ options: { pack: "docs" } })),
      /no approved skills tagged pack=docs[\s\S]*aih skill approve --pack docs/,
    );
  });

  it("refuses (fail-closed) when a tagged skill is already curated in another pack", () => {
    writeLock([{ name: "clean", pack: "docs" }]);
    writePacks([{ name: "ops", skills: [derivedRef("clean")] }]);
    expectRefusal(
      () => packInitCommand.plan(ctx({ options: { pack: "docs" } })),
      /cannot seed pack docs[\s\S]*pack\.duplicate-name[\s\S]*clean \(in pack ops\)/,
    );
  });
});

describe("round-trip — authoring feeds the slice-1 join", () => {
  it("add --apply → status shows the skill approved and validate passes clean", async () => {
    writeLock([{ name: "clean" }]);
    await applyPlan(packAddCommand, { pack: "docs", skill: "clean" });

    const report = packStatus(ctx());
    expect(report.findings).toEqual([]);
    expect(report.packs[0]).toMatchObject({ name: "docs", rollup: "ready" });
    expect(report.packs[0]?.skills[0]).toMatchObject({ name: "clean", approval: "approved" });

    const c = ctx({ verify: true }); // the runner forces verify for alwaysVerify commands
    const result = await executePlan(await packValidateCommand.plan(c), c);
    expect(result.report?.ok).toBe(true);
    expect(result.report?.exitCode()).toBe(0);
    expect(result.report?.checks).toEqual([
      expect.objectContaining({ name: "pack docs valid", verdict: "pass" }),
    ]);
  });
});
