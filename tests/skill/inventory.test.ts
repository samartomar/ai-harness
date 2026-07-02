import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import type { SkillInventory } from "../../src/skill/inventory.js";
import { skillInventory, skillInventoryCommand } from "../../src/skill/inventory.js";

const PIN = "a".repeat(40);
const CONTEXT_DIR = "ai-coding";

let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-skill-inv-"));
  home = mkdtempSync(join(tmpdir(), "aih-skill-inv-home-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function ctx(): PlanContext {
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
    options: {},
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
  verdict?: "GREEN" | "YELLOW";
  pack?: string;
  card?: string;
}

function writeLock(entries: LockEntryInput[]): void {
  write(
    "aih-skills.lock.json",
    JSON.stringify({
      schemaVersion: 1,
      skills: entries.map((e) => ({
        name: e.name,
        source: e.source ?? `owner/repo@${PIN}`,
        commit: e.commit ?? PIN,
        verdict: e.verdict ?? "GREEN",
        ...(e.pack ? { pack: e.pack } : {}),
        scope: "repo",
        card: e.card ?? `${CONTEXT_DIR}/skill-cards/${e.name}.json`,
        evidenceSha256: "0".repeat(64),
        approvedBy: "docs-platform",
        approvedAt: "2026-01-01T00:00:00.000Z",
      })),
    }),
  );
}

/** A promoted skill at `<ctx>/skills/<id>/<name>/SKILL.md`. */
function promoteSkill(id: string, name: string): void {
  write(join(CONTEXT_DIR, "skills", id, name, "SKILL.md"), `# ${name}\n`);
}

function inv(): SkillInventory {
  return skillInventory(ctx());
}

describe("skillInventory — the pure join", () => {
  it("returns all-zero counts for an empty repo with a friendly note", () => {
    const result = inv();
    expect(result.counts).toEqual({ installed: 0, approved: 0, unapproved: 0, stalePin: 0 });
    expect(result.skills).toEqual([]);
    // The promoted root does not exist → present: false.
    expect(result.roots.find((r) => r.label === "promoted")?.present).toBe(false);
  });

  it("marks a promoted skill with a matching lock entry approved", () => {
    writeLock([{ name: "clean", pack: "docs-quality" }]);
    write(`${CONTEXT_DIR}/skill-cards/clean.json`, JSON.stringify(validCard("clean")));
    promoteSkill("owner-repo", "clean");
    const result = inv();
    expect(result.counts).toMatchObject({ installed: 1, approved: 1, unapproved: 0, stalePin: 0 });
    const row = result.skills[0];
    expect(row).toMatchObject({
      name: "clean",
      root: "promoted",
      status: "approved",
      verdict: "GREEN",
      pack: "docs-quality",
      cardPresent: true,
    });
    expect(row?.source).toBe(`owner/repo@${PIN}`);
    expect(row?.commit).toBe(PIN);
  });

  it("flags an on-disk skill with no lock entry as unapproved", () => {
    write(`${CONTEXT_DIR}/skills/loose/foo/SKILL.md`, "# foo\n");
    const result = inv();
    expect(result.counts).toMatchObject({ installed: 1, unapproved: 1, approved: 0 });
    expect(result.skills[0]).toMatchObject({ name: "foo", status: "unapproved" });
    expect(result.skills[0]?.verdict).toBeUndefined();
  });

  it("flags an approved skill whose trust-lock source drifted from the pin as stale-pin", () => {
    const acquired = "d".repeat(40);
    writeLock([{ name: "clean", commit: PIN }]);
    write(`${CONTEXT_DIR}/skill-cards/clean.json`, JSON.stringify(validCard("clean")));
    promoteSkill("owner-repo", "clean");
    // The trust-lock records that `clean` was acquired at a DIFFERENT commit than the
    // approval pin → stale-pin with a drift reason.
    write(
      ".aih/trust-lock.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: "owner-repo",
            kind: "github",
            source: "owner/repo",
            pinnedSha: acquired,
            promotedAt: "2026-01-01T00:00:00.000Z",
            promotedSkills: ["clean"],
            analyzersRun: ["aih-native"],
            artifactHashes: [],
            findings: [],
          },
        ],
      }),
    );
    const result = inv();
    expect(result.counts).toMatchObject({ installed: 1, approved: 0, stalePin: 1 });
    const row = result.skills[0];
    expect(row?.status).toBe("stale-pin");
    expect(row?.driftReason).toBe(
      `approved commit ${PIN.slice(0, 7)} ≠ acquired ${acquired.slice(0, 7)}`,
    );
  });

  it("keeps a matching trust-lock pin approved (no false drift)", () => {
    writeLock([{ name: "clean", commit: PIN }]);
    write(`${CONTEXT_DIR}/skill-cards/clean.json`, JSON.stringify(validCard("clean")));
    promoteSkill("owner-repo", "clean");
    write(
      ".aih/trust-lock.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: "owner-repo",
            kind: "github",
            source: "owner/repo",
            pinnedSha: PIN,
            promotedAt: "2026-01-01T00:00:00.000Z",
            promotedSkills: ["clean"],
            analyzersRun: ["aih-native"],
            artifactHashes: [],
            findings: [],
          },
        ],
      }),
    );
    expect(inv().skills[0]?.status).toBe("approved");
  });

  it("counts a mixed inventory correctly across roots", () => {
    writeLock([{ name: "clean" }]);
    write(`${CONTEXT_DIR}/skill-cards/clean.json`, JSON.stringify(validCard("clean")));
    promoteSkill("owner-repo", "clean"); // approved
    write(`${CONTEXT_DIR}/skills/loose/foo/SKILL.md`, "# foo\n"); // unapproved
    write(".claude/skills/repo-skill/SKILL.md", "# repo\n"); // unapproved (repo root)
    const result = inv();
    expect(result.counts).toMatchObject({ installed: 3, approved: 1, unapproved: 2, stalePin: 0 });
    expect(result.skills.map((s) => s.root).sort()).toEqual(["promoted", "promoted", "repo"]);
  });
});

describe("skillInventoryCommand", () => {
  it("is a read-only, source-less command with a single static digest", async () => {
    expect(skillInventoryCommand.readOnly).toBe(true);
    expect(skillInventoryCommand.options).toEqual([]);
    writeLock([{ name: "clean" }]);
    write(`${CONTEXT_DIR}/skill-cards/clean.json`, JSON.stringify(validCard("clean")));
    promoteSkill("owner-repo", "clean");
    const c = ctx();

    const plan = await skillInventoryCommand.plan(c);
    // Exactly one digest action — no probe/exec (pure).
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.kind).toBe("digest");

    const result = await executePlan(plan, c);
    const digest = result.digests.find((d) => d.describe === "skill inventory");
    expect(digest?.text).toContain("1 installed · 1 approved · 0 unapproved · 0 stale");
    expect(digest?.text).toContain("clean");
    const data = digest?.data as SkillInventory;
    expect(data.counts.installed).toBe(1);
    expect(data.skills[0]?.name).toBe("clean");
  });

  it("emits a friendly empty digest for a bare repo", async () => {
    const c = ctx();
    const result = await executePlan(await skillInventoryCommand.plan(c), c);
    const digest = result.digests.find((d) => d.describe === "skill inventory");
    expect(digest?.text).toContain("0 installed · 0 approved · 0 unapproved · 0 stale");
    expect(digest?.text).toContain("No skills installed");
    expect((digest?.data as SkillInventory).counts.installed).toBe(0);
  });
});

/** A minimal valid SkillCard body for the given name (so cardPresent resolves true). */
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
