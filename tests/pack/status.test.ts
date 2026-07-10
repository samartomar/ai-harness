import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import type { Pack } from "../../src/pack/manifest.js";
import { readPacksFile } from "../../src/pack/manifest.js";
import type { PackStatusReport } from "../../src/pack/status.js";
import { packStatus, packStatusCommand } from "../../src/pack/status.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const PIN = "a".repeat(40);
const CONTEXT_DIR = "ai-coding";

let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-pack-status-"));
  home = mkdtempSync(join(tmpdir(), "aih-pack-status-home-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function ctx(options: Record<string, unknown> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: workspace,
    contextDir: CONTEXT_DIR,
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { USERPROFILE: home, HOME: home } }),
    // USERPROFILE isolates the machine `~/.claude/skills` root to the temp home.
    env: { USERPROFILE: home, HOME: home },
    posture: "vibe",
    options,
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
}

/** Write a committed lockfile with the given approved skills (like remove.test.ts's). */
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
        scope: "repo",
        card: `${CONTEXT_DIR}/skill-cards/${e.name}.json`,
        evidenceSha256: "0".repeat(64),
        approvedBy: "docs-platform",
        approvedAt: "2026-01-01T00:00:00.000Z",
      })),
    }),
  );
}

/** A manifest ref that matches the writeLock defaults for `name`. */
function matchingRef(name: string): { name: string; source: string; commit: string } {
  return { name, source: `owner/repo@${PIN}`, commit: PIN };
}

/** Write the committed pack manifest (raw entries allowed, for fail-soft tests). */
function writePacks(packs: unknown[]): void {
  write("aih-packs.json", JSON.stringify({ schemaVersion: 1, packs }));
}

/** A promoted skill at `<ctx>/skills/<id>/<name>/SKILL.md`. */
function promoteSkill(id: string, name: string): void {
  write(join(CONTEXT_DIR, "skills", id, name, "SKILL.md"), `# ${name}\n`);
}

describe("readPacksFile — the fail-soft manifest read", () => {
  it("returns an empty manifest for an absent file", () => {
    expect(readPacksFile(workspace)).toEqual({ schemaVersion: 1, packs: [] });
  });

  it("drops a malformed pack entry while valid siblings survive", () => {
    writePacks([
      { name: "docs", skills: [matchingRef("clean")] },
      { name: "broken" }, // no skills → dropped, not fatal
      { name: 42, skills: [] }, // wrong types → dropped
    ]);
    const manifest = readPacksFile(workspace);
    expect(manifest.packs.map((p: Pack) => p.name)).toEqual(["docs"]);
  });

  it("returns an empty manifest for unparseable JSON", () => {
    write("aih-packs.json", "{ not json");
    expect(readPacksFile(workspace).packs).toEqual([]);
  });
});

describe("packStatus — the pure join", () => {
  it("reports an absent manifest with no packs and no findings", () => {
    const report = packStatus(ctx());
    expect(report.manifestPresent).toBe(false);
    expect(report.packs).toEqual([]);
    expect(report.findings).toEqual([]);
  });

  it("grades a fully matching, installed pack ready/approved/installed", () => {
    writeLock([{ name: "clean" }, { name: "tidy", source: "local", commit: "local" }]);
    promoteSkill("owner-repo", "clean");
    promoteSkill("local-src", "tidy");
    writePacks([
      {
        name: "docs-quality",
        skills: [matchingRef("clean"), { name: "tidy", source: "local", commit: "local" }],
      },
    ]);
    const report = packStatus(ctx());
    expect(report.findings).toEqual([]);
    const pack = report.packs[0];
    expect(pack).toMatchObject({
      name: "docs-quality",
      rollup: "ready",
      counts: { skills: 2, approved: 2, installed: 2 },
    });
    for (const skill of pack?.skills ?? []) {
      expect(skill.approval).toBe("approved");
      expect(skill.install).toBe("installed");
    }
  });

  it("flags a ref whose name has no lock entry as missing-approval (pack blocked)", () => {
    writePacks([{ name: "docs", skills: [matchingRef("ghost")] }]);
    const report = packStatus(ctx());
    expect(report.packs[0]?.rollup).toBe("blocked");
    expect(report.packs[0]?.skills[0]?.approval).toBe("missing-approval");
    expect(report.findings.map((f) => f.check.code)).toEqual(["pack.missing-approval"]);
    expect(report.findings[0]?.pack).toBe("docs");
  });

  it("fails closed as pin-mismatch when the manifest commit disagrees with the lock", () => {
    writeLock([{ name: "clean" }]); // lock pins PIN
    promoteSkill("owner-repo", "clean");
    writePacks([
      {
        name: "docs",
        skills: [{ name: "clean", source: `owner/repo@${PIN}`, commit: "b".repeat(40) }],
      },
    ]);
    const report = packStatus(ctx());
    expect(report.packs[0]?.rollup).toBe("blocked");
    expect(report.packs[0]?.skills[0]?.approval).toBe("pin-mismatch");
    const finding = report.findings[0];
    expect(finding?.check.code).toBe("pack.pin-mismatch");
    // The detail names both sides: the manifest ref and the authoritative lock pin.
    expect(finding?.check.detail).toContain("b".repeat(40));
    expect(finding?.check.detail).toContain(PIN);
  });

  it("fails closed as pin-mismatch when the manifest SOURCE disagrees with the lock", () => {
    writeLock([{ name: "clean" }]);
    writePacks([{ name: "docs", skills: [{ name: "clean", source: "evil/repo", commit: PIN }] }]);
    const report = packStatus(ctx());
    expect(report.packs[0]?.skills[0]?.approval).toBe("pin-mismatch");
    expect(report.findings[0]?.check.code).toBe("pack.pin-mismatch");
  });

  it("fails closed when pack-level requiredChecks are declared but not enforced", () => {
    writeLock([{ name: "clean" }]);
    writePacks([{ name: "docs", requiredChecks: ["no-exec"], skills: [matchingRef("clean")] }]);
    const report = packStatus(ctx());
    expect(report.packs[0]?.rollup).toBe("blocked");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pack: "docs",
          check: expect.objectContaining({
            code: "pack.required-checks-unsupported",
            detail: expect.stringContaining("requiredChecks are declared"),
          }),
        }),
      ]),
    );
  });

  it("flags BOTH packs when two packs list the same skill name", () => {
    writeLock([{ name: "clean" }]);
    writePacks([
      { name: "a", skills: [matchingRef("clean")] },
      { name: "b", skills: [matchingRef("clean")] },
    ]);
    const report = packStatus(ctx());
    const dups = report.findings.filter((f) => f.check.code === "pack.duplicate-name");
    expect(dups.map((f) => f.pack).sort()).toEqual(["a", "b"]);
    for (const f of dups) expect(f.check.detail).toContain("a, b");
  });

  it("flags a pack that lists the same skill name twice", () => {
    writeLock([{ name: "clean" }]);
    writePacks([{ name: "a", skills: [matchingRef("clean"), matchingRef("clean")] }]);
    const report = packStatus(ctx());
    const dups = report.findings.filter((f) => f.check.code === "pack.duplicate-name");
    expect(dups).toHaveLength(1);
    expect(dups[0]?.pack).toBe("a");
    expect(dups[0]?.check.detail).toContain("2×");
  });

  it("reports a quarantined-only install as quarantined", () => {
    writeLock([{ name: "x" }]);
    // Parked under the quarantine archive in its original promoted layout.
    write(".aih/quarantine/ai-coding/skills/src/x/SKILL.md", "# x\n");
    writePacks([{ name: "docs", skills: [matchingRef("x")] }]);
    const report = packStatus(ctx());
    expect(report.packs[0]?.skills[0]?.install).toBe("quarantined");
    // Quarantine is an install-axis state, not an approval problem.
    expect(report.packs[0]?.skills[0]?.approval).toBe("approved");
  });

  it("treats approved-but-not-on-disk as not-installed, and the pack stays ready", () => {
    // The "approve now, install later" flow — NOT an error, no finding.
    writeLock([{ name: "clean" }]);
    writePacks([{ name: "docs", skills: [matchingRef("clean")] }]);
    const report = packStatus(ctx());
    expect(report.packs[0]?.skills[0]?.install).toBe("not-installed");
    expect(report.packs[0]?.rollup).toBe("ready");
    expect(report.packs[0]?.counts).toEqual({ skills: 1, approved: 1, installed: 0 });
    expect(report.findings).toEqual([]);
  });

  it("emits pack.unknown-manifest when the file is present but yields zero valid packs", () => {
    writePacks([{ name: "broken" }]); // fails the schema → dropped → zero packs
    const report = packStatus(ctx());
    expect(report.manifestPresent).toBe(true);
    expect(report.packs).toEqual([]);
    expect(report.findings.map((f) => f.check.code)).toEqual(["pack.unknown-manifest"]);
    expect(report.findings[0]?.pack).toBeUndefined(); // manifest-wide, not pack-scoped
  });

  it("--pack narrows the packs AND the findings to the named pack", () => {
    writeLock([{ name: "clean" }]);
    writePacks([
      { name: "a", skills: [matchingRef("clean")] },
      { name: "b", skills: [matchingRef("ghost")] }, // missing-approval finding
    ]);
    const report = packStatus(ctx(), "a");
    expect(report.packs.map((p) => p.name)).toEqual(["a"]);
    // b's missing-approval is out of view; a is clean.
    expect(report.findings).toEqual([]);
  });

  it("--pack still surfaces a cross-pack duplicate the filtered pack participates in", () => {
    writeLock([{ name: "clean" }]);
    writePacks([
      { name: "a", skills: [matchingRef("clean")] },
      { name: "b", skills: [matchingRef("clean")] },
    ]);
    const report = packStatus(ctx(), "a");
    const dups = report.findings.filter((f) => f.check.code === "pack.duplicate-name");
    expect(dups.map((f) => f.pack)).toEqual(["a"]); // a's side only — b is out of view
    expect(dups[0]?.check.detail).toContain("a, b"); // but the detail names the other pack
  });
});

describe("packStatusCommand", () => {
  it("is a read-only, positional-less command with a single static digest", async () => {
    expect(packStatusCommand.readOnly).toBe(true);
    expect(packStatusCommand.options?.map((o) => o.flags)).toEqual(["--pack <name>"]);
    writeLock([{ name: "clean" }]);
    promoteSkill("owner-repo", "clean");
    writePacks([{ name: "docs-quality", skills: [matchingRef("clean")] }]);
    const c = ctx();

    const plan = await packStatusCommand.plan(c);
    // Exactly one digest action — no probe/exec/write (pure).
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.kind).toBe("digest");

    const result = await executePlan(plan, c);
    const digest = result.digests.find((d) => d.describe === "pack status");
    expect(digest?.text).toContain("docs-quality — ready · 1 skills · 1 approved · 1 installed");
    expect(digest?.text).toContain(
      `  - clean  [approved] [installed]  (owner/repo@${PIN}@${PIN.slice(0, 12)})`,
    );
    const data = digest?.data as PackStatusReport;
    expect(data.packs[0]?.name).toBe("docs-quality");
  });

  it("emits a friendly empty digest when no aih-packs.json exists", async () => {
    const c = ctx();
    const result = await executePlan(await packStatusCommand.plan(c), c);
    const digest = result.digests.find((d) => d.describe === "pack status");
    expect(digest?.text).toContain("no packs defined — create aih-packs.json");
    expect((digest?.data as PackStatusReport)?.manifestPresent).toBe(false);
  });

  it("--pack narrows the digest to the named pack", async () => {
    writeLock([{ name: "clean" }]);
    writePacks([
      { name: "a", skills: [matchingRef("clean")] },
      { name: "b", skills: [matchingRef("ghost")] },
    ]);
    const c = ctx({ pack: "a" });
    const result = await executePlan(await packStatusCommand.plan(c), c);
    const digest = result.digests.find((d) => d.describe === "pack status");
    expect(digest?.text).toContain("a — ready");
    expect(digest?.text).not.toContain("b — ");
    expect((digest?.data as PackStatusReport)?.packs).toHaveLength(1);
  });
});
