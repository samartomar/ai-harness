import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AihError } from "../../src/errors.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { skillInventory } from "../../src/skill/inventory.js";
import { assertSkillSyncRelativePathForTest, skillSyncCommand } from "../../src/skill/sync.js";

const PIN = "a".repeat(40);
const CONTEXT_DIR = "ai-coding";

let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-skill-sync-"));
  home = mkdtempSync(join(tmpdir(), "aih-skill-sync-home-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function ctx(options: Record<string, unknown>, apply = false): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: workspace,
    contextDir: CONTEXT_DIR,
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { USERPROFILE: home, HOME: home } }),
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

function writeLock(name: string): void {
  write(
    "aih-skills.lock.json",
    JSON.stringify({
      schemaVersion: 1,
      skills: [
        {
          name,
          source: `owner/repo@${PIN}`,
          commit: PIN,
          verdict: "GREEN",
          scope: "repo",
          card: `${CONTEXT_DIR}/skill-cards/${name}.json`,
          evidenceSha256: "0".repeat(64),
          approvedBy: "docs-platform",
          approvedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  );
}

function sha256Text(body: string): string {
  return createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
}

function writeTrustLockArtifacts(
  id: string,
  name: string,
  artifactHashes: Array<{ path: string; sha256: string }>,
): void {
  write(
    ".aih/trust-lock.json",
    JSON.stringify({
      schemaVersion: 1,
      sources: [
        {
          id,
          kind: "github",
          source: "owner/repo",
          pinnedSha: PIN,
          promotedAt: "2026-01-01T00:00:00.000Z",
          promotedSkills: [name],
          analyzersRun: ["aih-native"],
          artifactHashes,
          findings: [],
        },
      ],
    }),
  );
}

function writeTrustLock(
  id: string,
  name: string,
  files: Array<{ path: string; body: string }>,
  sourceSkillPath = name,
): void {
  writeTrustLockArtifacts(
    id,
    name,
    files.map((file) => ({
      path: `${sourceSkillPath}/${file.path}`,
      sha256: sha256Text(file.body),
    })),
  );
}

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

function promoteSkill(id: string, name: string): void {
  write(join(CONTEXT_DIR, "skills", id, name, "SKILL.md"), `# ${name}\n`);
  write(join(CONTEXT_DIR, "skills", id, name, "README.md"), `${name} docs\n`);
}

function installApproved(id: string, name: string): void {
  promoteSkill(id, name);
  write(`${CONTEXT_DIR}/skill-cards/${name}.json`, JSON.stringify(validCard(name)));
  writeLock(name);
  writeTrustLock(id, name, [
    { path: "SKILL.md", body: `# ${name}\n` },
    { path: "README.md", body: `${name} docs\n` },
  ]);
}

const codexSkill = (name: string, rel = "SKILL.md"): string =>
  join(home, ".codex", "skills", name, rel);
const claudeSkill = (name: string, rel = "SKILL.md"): string =>
  join(home, ".claude", "skills", name, rel);

describe("skillSyncCommand", () => {
  it("dry-run previews copying an approved promoted skill without writing machine files", async () => {
    installApproved("owner-repo", "clean");
    const c = ctx({ name: "clean", cli: "codex" });

    const result = await executePlan(await skillSyncCommand.plan(c), c);

    expect(result.writes.map((w) => w.path).sort()).toEqual([
      codexSkill("clean", "README.md"),
      codexSkill("clean", "SKILL.md"),
    ]);
    expect(existsSync(codexSkill("clean"))).toBe(false);
  });

  it("--apply writes approved promoted skill files to Claude and Codex machine roots", async () => {
    installApproved("owner-repo", "clean");
    const c = ctx({ name: "clean", cli: "claude,codex" }, true);

    await executePlan(await skillSyncCommand.plan(c), c);

    expect(readFileSync(claudeSkill("clean"), "utf8")).toBe("# clean\n");
    expect(readFileSync(codexSkill("clean"), "utf8")).toBe("# clean\n");
    expect(readFileSync(codexSkill("clean", "README.md"), "utf8")).toBe("clean docs\n");
    const machineRows = skillInventory(c)
      .skills.filter((row) => row.name === "clean" && row.root === "machine")
      .map((row) => row.abs)
      .sort();
    expect(machineRows).toEqual([
      join(home, ".claude", "skills", "clean"),
      join(home, ".codex", "skills", "clean"),
    ]);
  });

  it("refuses to sync an unapproved promoted skill", () => {
    promoteSkill("owner-repo", "clean");
    const c = ctx({ name: "clean", cli: "codex" });

    expect(() => skillSyncCommand.plan(c)).toThrow(AihError);
    try {
      skillSyncCommand.plan(c);
    } catch (e) {
      expect((e as AihError).code).toBe("AIH_TRUST");
      expect((e as AihError).message).toContain("approved promoted skill");
    }
  });

  it("refuses unsupported CLI machine roots", () => {
    installApproved("owner-repo", "clean");
    const c = ctx({ name: "clean", cli: "cursor" });

    expect(() => skillSyncCommand.plan(c)).toThrow(/does not have a machine skill-discovery path/);
  });

  it("refuses a promoted skill whose directory contains a nested skill", () => {
    installApproved("owner-repo", "parent");
    write(join(CONTEXT_DIR, "skills", "owner-repo", "parent", "child", "SKILL.md"), "# child\n");
    const c = ctx({ name: "parent", cli: "codex" });

    expect(() => skillSyncCommand.plan(c)).toThrow(/contains nested skill/);
  });

  it("refuses when promoted skill bytes no longer match the approved trust-lock artifact hashes", () => {
    installApproved("owner-repo", "clean");
    write(
      join(CONTEXT_DIR, "skills", "owner-repo", "clean", "SKILL.md"),
      "# tampered after approval\n",
    );
    const c = ctx({ name: "clean", cli: "codex" });

    expect(() => skillSyncCommand.plan(c)).toThrow(/promoted skill bytes changed after approval/);
  });

  it("accepts trust receipts from prefixed source skill paths", async () => {
    installApproved("owner-repo", "clean");
    writeTrustLock(
      "owner-repo",
      "clean",
      [
        { path: "SKILL.md", body: "# clean\n" },
        { path: "README.md", body: "clean docs\n" },
      ],
      "packages/skills/clean",
    );
    const c = ctx({ name: "clean", cli: "codex" });

    const result = await executePlan(await skillSyncCommand.plan(c), c);

    expect(result.writes.map((write) => write.path).sort()).toEqual([
      codexSkill("clean", "README.md"),
      codexSkill("clean", "SKILL.md"),
    ]);
  });

  it("does not overmatch direct skill receipts that contain skills path segments", async () => {
    installApproved("owner-repo", "clean");
    write(
      join(CONTEXT_DIR, "skills", "owner-repo", "clean", "docs", "skills", "clean", "notes.md"),
      "notes\n",
    );
    writeTrustLock("owner-repo", "clean", [
      { path: "SKILL.md", body: "# clean\n" },
      { path: "README.md", body: "clean docs\n" },
      { path: "docs/skills/clean/notes.md", body: "notes\n" },
    ]);
    const c = ctx({ name: "clean", cli: "codex" });

    const result = await executePlan(await skillSyncCommand.plan(c), c);

    expect(result.writes.map((write) => write.path)).toContain(
      codexSkill("clean", join("docs", "skills", "clean", "notes.md")),
    );
  });

  it("refuses duplicate trust receipts for the same promoted file", () => {
    installApproved("owner-repo", "clean");
    writeTrustLockArtifacts("owner-repo", "clean", [
      { path: "clean/SKILL.md", sha256: sha256Text("# clean\n") },
      { path: "clean/SKILL.md", sha256: sha256Text("# tampered\n") },
      { path: "clean/README.md", sha256: sha256Text("clean docs\n") },
    ]);
    const c = ctx({ name: "clean", cli: "codex" });

    expect(() => skillSyncCommand.plan(c)).toThrow(/ambiguous trust-lock artifact receipts/);
  });

  it("refuses when an approved promoted skill file was deleted after approval", () => {
    installApproved("owner-repo", "clean");
    unlinkSync(join(workspace, CONTEXT_DIR, "skills", "owner-repo", "clean", "README.md"));
    const c = ctx({ name: "clean", cli: "codex" });

    expect(() => skillSyncCommand.plan(c)).toThrow(/approved promoted skill file is missing/);
  });

  it("refuses UNC-style escaped source paths", () => {
    expect(() => assertSkillSyncRelativePathForTest("//server/share/file.md")).toThrow(
      /outside source root/,
    );
  });

  it("refuses syncing through a symlinked machine-root parent", () => {
    installApproved("owner-repo", "clean");
    const external = mkdtempSync(join(tmpdir(), "aih-skill-sync-external-"));
    try {
      symlinkSync(external, join(home, ".codex"), "junction");
      const c = ctx({ name: "clean", cli: "codex" });

      expect(() => skillSyncCommand.plan(c)).toThrow(/symlinked machine skill path/);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});
