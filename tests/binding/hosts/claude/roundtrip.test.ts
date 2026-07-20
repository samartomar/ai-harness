import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeManagedWriteEngine,
  finalizeClaudeOwnership,
} from "../../../../src/binding/hosts/claude/managed-writes.js";
import { planClaudeRemoval } from "../../../../src/binding/hosts/claude/removal.js";
import { queueSkillDenyList } from "../../../../src/binding/hosts/claude/skill-overrides.js";
import {
  CLAUDE_BINDING_MARKER,
  CLAUDE_BOOTLOADER_PATH,
  CLAUDE_MCP_PATH,
  CLAUDE_SETTINGS_PATH,
} from "../../../../src/binding/hosts/claude/surfaces.js";
import {
  type BindingLock,
  bindingDir,
  bindingLockPath,
  readBindingLock,
  writeBindingLockAtomic,
} from "../../../../src/binding/lock.js";
import type { BindingDeclaration } from "../../../../src/binding/schema.js";
import { applyActions, readJson, readText } from "./support.js";

/**
 * W3 exit criterion, end to end WITH THE LOCK IN THE LOOP: bind -> lock write ->
 * lock read -> conservative removal -> clean tree on a fixture project. The engine
 * tests cover each mechanism in isolation; this suite proves the composed flow the
 * W4 adapters will drive, including a pre-existing user deny entry surviving the
 * round trip and every user surface byte remaining intact.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-claude-rt-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, contents: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, contents, "utf8");
}

function declaration(): BindingDeclaration {
  return {
    schemaVersion: 1,
    framework: { id: "gstack", host: "claude" },
    source: {
      kind: "git",
      repository: "gstack/gstack",
      commitSha: "d".repeat(40),
      treeDigest: "e".repeat(64),
    },
  };
}

const USER_CLAUDE_MD = "# My project\n\nUser instructions stay.\n";

function seedFixtureProject(): void {
  seed(CLAUDE_BOOTLOADER_PATH, USER_CLAUDE_MD);
  seed(
    CLAUDE_SETTINGS_PATH,
    `${JSON.stringify(
      { model: "opus", skillOverrides: { "gs-review": "off" }, userSetting: 7 },
      null,
      2,
    )}\n`,
  );
  seed(
    CLAUDE_MCP_PATH,
    `${JSON.stringify({ mcpServers: { "user-mcp": { command: "u" } } }, null, 2)}\n`,
  );
}

describe("W3 exit criterion — bind/verify/remove round-trip with the lock in the loop", () => {
  it("binds all mechanisms, locks, removes from the re-read lock, and leaves a clean tree", async () => {
    seedFixtureProject();

    // -- BIND: every W3 mechanism through one engine ---------------------------
    const engine = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/enabledPlugins/gstack@aih-gstack", true)
      .mcpServer("gstack-mcp", { command: "gstack-mcp-server" })
      .claudeMdBlock("Routing: gstack skills live under .claude/skills/gstack.")
      .ownedFile(".claude/rules/gstack/routing.md", "# gstack routing rule\n");
    // Deny-list regeneration from the pinned inventory: one name the user already
    // denied (pre-existing "off" must be RESTORED, not pruned) and one fresh name.
    queueSkillDenyList(engine, {
      names: ["gs-review", "gs-ship"],
      sourceDigest: "e".repeat(64),
    });
    const bound = engine.build();
    await applyActions(root, bound.actions);
    const ownership = finalizeClaudeOwnership(root, bound.ownership);

    // -- VERIFY: bound surfaces present, user surfaces intact ------------------
    const settingsAfterBind = readJson(root, CLAUDE_SETTINGS_PATH);
    expect(settingsAfterBind.enabledPlugins).toEqual({ "gstack@aih-gstack": true });
    expect(settingsAfterBind.skillOverrides).toEqual({ "gs-review": "off", "gs-ship": "off" });
    expect(settingsAfterBind.model).toBe("opus");
    expect(settingsAfterBind.userSetting).toBe(7);
    expect(readJson(root, CLAUDE_MCP_PATH).mcpServers).toEqual({
      "user-mcp": { command: "u" },
      "gstack-mcp": { command: "gstack-mcp-server" },
    });
    const claudeMdAfterBind = readText(root, CLAUDE_BOOTLOADER_PATH);
    expect(claudeMdAfterBind).toContain("User instructions stay.");
    expect(claudeMdAfterBind).toContain(CLAUDE_BINDING_MARKER);
    expect(existsSync(join(root, ".claude", "rules", "gstack", "routing.md"))).toBe(true);

    // -- LOCK: write, then re-read (the removal input is the RE-READ lock) -----
    const digest = "e".repeat(64);
    const lock: BindingLock = {
      schemaVersion: 1,
      declaration: declaration(),
      writes: bound.writes,
      scannedDigest: digest,
      loadedDigest: digest,
      match: true,
      ownership,
    };
    writeBindingLockAtomic(root, lock);
    const read = readBindingLock(root);
    expect(read.present).toBe(true);
    if (!read.present) return;

    // -- REMOVE: conservative removal from the re-read lock --------------------
    const removal = planClaudeRemoval(root, read.lock);
    expect(removal.drift).toEqual([]);
    await applyActions(root, removal.actions);
    rmSync(bindingDir(root), { recursive: true, force: true });

    // -- CLEAN TREE: user state byte-survives; every bound surface is gone -----
    const settingsAfterRemove = readJson(root, CLAUDE_SETTINGS_PATH);
    expect(settingsAfterRemove.enabledPlugins).toBeUndefined();
    // The user's own pre-existing deny entry is RESTORED; the fresh one is pruned.
    expect(settingsAfterRemove.skillOverrides).toEqual({ "gs-review": "off" });
    expect(settingsAfterRemove.model).toBe("opus");
    expect(settingsAfterRemove.userSetting).toBe(7);
    expect(readJson(root, CLAUDE_MCP_PATH).mcpServers).toEqual({ "user-mcp": { command: "u" } });
    expect(readText(root, CLAUDE_BOOTLOADER_PATH)).toBe(USER_CLAUDE_MD);
    expect(existsSync(join(root, ".claude", "rules", "gstack"))).toBe(false);
    expect(existsSync(bindingLockPath(root))).toBe(false);
  });

  it("re-binding over an existing bind stays idempotent and still round-trips clean", async () => {
    seedFixtureProject();

    const bind = () => {
      const engine = new ClaudeManagedWriteEngine(root).jsonField(
        CLAUDE_SETTINGS_PATH,
        "/enabledPlugins/gstack@aih-gstack",
        true,
      );
      return engine.build();
    };

    const first = bind();
    await applyActions(root, first.actions);
    const firstOwnership = finalizeClaudeOwnership(root, first.ownership);

    // Re-bind: the second apply must be a no-op on bytes (idempotent)...
    const second = bind();
    const result = await applyActions(root, second.actions);
    const changed = result.writes.filter((w) => w.effect !== "unchanged");
    expect(changed).toEqual([]);
    expect(result.backups).toEqual([]);
    // ...and removal driven by the FIRST bind's ownership (true pre-existing)
    // still restores the pre-bind world.
    const digest = "e".repeat(64);
    writeBindingLockAtomic(root, {
      schemaVersion: 1,
      declaration: declaration(),
      writes: first.writes,
      scannedDigest: digest,
      loadedDigest: digest,
      match: true,
      ownership: firstOwnership,
    });
    const read = readBindingLock(root);
    if (!read.present) throw new Error("lock must be present");
    const removal = planClaudeRemoval(root, read.lock);
    await applyActions(root, removal.actions);
    expect(readJson(root, CLAUDE_SETTINGS_PATH).enabledPlugins).toBeUndefined();
    expect(readJson(root, CLAUDE_SETTINGS_PATH).userSetting).toBe(7);
  });
});
