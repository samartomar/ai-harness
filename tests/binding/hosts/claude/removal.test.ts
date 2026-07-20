import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeManagedWriteEngine,
  finalizeClaudeOwnership,
} from "../../../../src/binding/hosts/claude/managed-writes.js";
import { planClaudeRemoval } from "../../../../src/binding/hosts/claude/removal.js";
import {
  CLAUDE_BOOTLOADER_PATH,
  CLAUDE_MCP_PATH,
  CLAUDE_SETTINGS_PATH,
} from "../../../../src/binding/hosts/claude/surfaces.js";
import type {
  BindingLock,
  BindingOwnershipEntry,
  BindingWrite,
} from "../../../../src/binding/lock.js";
import type { BindingDeclaration } from "../../../../src/binding/schema.js";
import { applyActions, readJson, readText } from "./support.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-claude-rm-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, contents: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function declaration(): BindingDeclaration {
  return {
    schemaVersion: 1,
    framework: { id: "ecc", mode: "lean", host: "claude" },
    source: {
      kind: "git",
      repository: "affaan-m/ECC",
      commitSha: "c".repeat(40),
      treeDigest: "a".repeat(64),
    },
  };
}

function lockFrom(writes: BindingWrite[], ownership: BindingOwnershipEntry[]): BindingLock {
  const digest = "a".repeat(64);
  return {
    schemaVersion: 1,
    declaration: declaration(),
    writes,
    scannedDigest: digest,
    loadedDigest: digest,
    match: true,
    ownership,
  };
}

/** Bind `build()` output, apply it, and return a lock ready for removal. */
async function bindAndLock(built: {
  actions: import("../../../../src/internals/plan.js").Action[];
  writes: BindingWrite[];
  ownership: import("../../../../src/binding/hosts/claude/managed-writes.js").ClaudeOwnershipIntent[];
}): Promise<BindingLock> {
  await applyActions(root, built.actions);
  const ownership = finalizeClaudeOwnership(root, built.ownership);
  return lockFrom(built.writes, ownership);
}

describe("planClaudeRemoval — clean removal restores the world", () => {
  it("prunes an owned field whose pre-existing state was absent", async () => {
    seed(CLAUDE_SETTINGS_PATH, `${JSON.stringify({ telemetry: false }, null, 2)}\n`);
    const built = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/model", "m")
      .build();
    const lock = await bindAndLock(built);

    const removal = planClaudeRemoval(root, lock);
    expect(removal.drift).toHaveLength(0);
    await applyActions(root, removal.actions);

    expect(readJson(root, CLAUDE_SETTINGS_PATH)).toEqual({ telemetry: false });
  });

  it("restores an owned field's pre-existing value", async () => {
    seed(CLAUDE_SETTINGS_PATH, `${JSON.stringify({ model: "original" }, null, 2)}\n`);
    const built = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/model", "aih-value")
      .build();
    const lock = await bindAndLock(built);
    expect(readJson(root, CLAUDE_SETTINGS_PATH)).toEqual({ model: "aih-value" });

    const removal = planClaudeRemoval(root, lock);
    await applyActions(root, removal.actions);
    expect(readJson(root, CLAUDE_SETTINGS_PATH)).toEqual({ model: "original" });
  });

  it("prunes an owned MCP server while preserving unrelated servers", async () => {
    seed(
      CLAUDE_MCP_PATH,
      `${JSON.stringify({ mcpServers: { keep: { command: "keep" } } }, null, 2)}\n`,
    );
    const built = new ClaudeManagedWriteEngine(root)
      .mcpServer("ecc", { command: "ecc-mcp" })
      .build();
    const lock = await bindAndLock(built);

    const removal = planClaudeRemoval(root, lock);
    await applyActions(root, removal.actions);
    expect(readJson(root, CLAUDE_MCP_PATH)).toEqual({ mcpServers: { keep: { command: "keep" } } });
  });

  it("strips the CLAUDE.md block, preserving everything outside the fence and CRLF", async () => {
    const preamble = ["# preamble", "", "user note", ""].join("\r\n");
    seed(CLAUDE_BOOTLOADER_PATH, preamble);
    const built = new ClaudeManagedWriteEngine(root).claudeMdBlock("binding body").build();
    const lock = await bindAndLock(built);
    expect(readText(root, CLAUDE_BOOTLOADER_PATH)).toContain("binding body");

    const removal = planClaudeRemoval(root, lock);
    await applyActions(root, removal.actions);
    const after = readText(root, CLAUDE_BOOTLOADER_PATH);
    expect(after).toContain("user note");
    expect(after).not.toContain("binding body");
    expect(after).not.toContain("aih-binding:claude");
    expect(after).toContain("\r\n");
  });

  it("removes an owned file that had no pre-existing content", async () => {
    const rel = ".claude/skills/ecc/SKILL.md";
    const built = new ClaudeManagedWriteEngine(root).ownedFile(rel, "# skill\n").build();
    const lock = await bindAndLock(built);
    expect(existsSync(join(root, rel))).toBe(true);

    const removal = planClaudeRemoval(root, lock);
    await applyActions(root, removal.actions);
    expect(existsSync(join(root, rel))).toBe(false);
  });

  it("restores an owned file's pre-existing content", async () => {
    const rel = ".claude/agents/reviewer.md";
    seed(rel, "# user agent\n");
    const built = new ClaudeManagedWriteEngine(root).ownedFile(rel, "# aih agent\n").build();
    const lock = await bindAndLock(built);
    expect(readText(root, rel)).toBe("# aih agent\n");

    const removal = planClaudeRemoval(root, lock);
    await applyActions(root, removal.actions);
    expect(readText(root, rel)).toBe("# user agent\n");
  });

  it("is idempotent — a second removal is a no-op once the slot is gone", async () => {
    const built = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/model", "m")
      .build();
    const lock = await bindAndLock(built);
    await applyActions(root, planClaudeRemoval(root, lock).actions);
    const second = planClaudeRemoval(root, lock);
    expect(second.drift).toHaveLength(0);
    // Applying the (empty or merge-noop) plan changes nothing.
    const result = await applyActions(root, second.actions);
    expect(result.writes.every((w) => w.effect === "unchanged" || w.effect === "kept")).toBe(true);
  });
});

describe("planClaudeRemoval — drift is preserved and reported, never silently deleted", () => {
  it("preserves a modified owned JSON value and reports drift", async () => {
    const built = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/model", "aih-value")
      .build();
    const lock = await bindAndLock(built);
    // User modifies the AIH-owned field after bind.
    seed(CLAUDE_SETTINGS_PATH, `${JSON.stringify({ model: "user-edited" }, null, 2)}\n`);

    const removal = planClaudeRemoval(root, lock);
    expect(removal.drift).toHaveLength(1);
    expect(removal.drift[0]?.target).toBe(`${CLAUDE_SETTINGS_PATH}#/model`);
    await applyActions(root, removal.actions);
    // The user's value is untouched — never silently deleted.
    expect(readJson(root, CLAUDE_SETTINGS_PATH)).toEqual({ model: "user-edited" });
  });

  it("preserves a modified owned file and reports drift", async () => {
    const rel = ".claude/skills/ecc/SKILL.md";
    const built = new ClaudeManagedWriteEngine(root).ownedFile(rel, "# aih skill\n").build();
    const lock = await bindAndLock(built);
    seed(rel, "# user hand-edit\n");

    const removal = planClaudeRemoval(root, lock);
    expect(removal.drift).toHaveLength(1);
    await applyActions(root, removal.actions);
    expect(readText(root, rel)).toBe("# user hand-edit\n");
  });
});

describe("D18 standing test (verbatim ruling)", () => {
  it("unrelated content survives; the modified owned entry is preserved + reported, never deleted", async () => {
    // Bind: AIH owns /hooks/PreToolUse in settings.json.
    seed(
      CLAUDE_SETTINGS_PATH,
      `${JSON.stringify({ hooks: { PreToolUse: ["placeholder"] } }, null, 2)}\n`,
    );
    const built = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/hooks/PreToolUse", ["aih-hook"])
      .build();
    const lock = await bindAndLock(built);

    // Between bind and remove: modify ONE unrelated setting AND the AIH-owned one.
    seed(
      CLAUDE_SETTINGS_PATH,
      `${JSON.stringify(
        { unrelatedUserSetting: 42, hooks: { PreToolUse: ["user-modified"] } },
        null,
        2,
      )}\n`,
    );

    const removal = planClaudeRemoval(root, lock);

    // The modified owned entry is reported as drift, not scheduled for deletion.
    expect(removal.drift).toHaveLength(1);
    expect(removal.drift[0]?.target).toBe(`${CLAUDE_SETTINGS_PATH}#/hooks/PreToolUse`);

    await applyActions(root, removal.actions);
    const after = readJson(root, CLAUDE_SETTINGS_PATH);
    // Unrelated content survives removal.
    expect(after.unrelatedUserSetting).toBe(42);
    // The modified owned entry is preserved (never silently deleted).
    expect(after.hooks).toEqual({ PreToolUse: ["user-modified"] });
  });
});

describe("planClaudeRemoval — never a whole-file replacement", () => {
  it("keeps sibling keys added by the user after bind", async () => {
    const built = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/model", "m")
      .build();
    const lock = await bindAndLock(built);
    // User adds an unrelated key after bind (owned field left equal to applied).
    const current = readJson(root, CLAUDE_SETTINGS_PATH);
    seed(CLAUDE_SETTINGS_PATH, `${JSON.stringify({ ...current, userKey: "mine" }, null, 2)}\n`);

    const removal = planClaudeRemoval(root, lock);
    expect(removal.drift).toHaveLength(0);
    await applyActions(root, removal.actions);
    const after = readJson(root, CLAUDE_SETTINGS_PATH);
    expect(after.userKey).toBe("mine");
    expect(after.model).toBeUndefined();
  });
});
