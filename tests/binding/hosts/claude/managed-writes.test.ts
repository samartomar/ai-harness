import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeManagedWriteEngine,
  finalizeClaudeOwnership,
} from "../../../../src/binding/hosts/claude/managed-writes.js";
import {
  CLAUDE_BINDING_MARKER,
  CLAUDE_BOOTLOADER_PATH,
  CLAUDE_MCP_PATH,
  CLAUDE_SETTINGS_PATH,
} from "../../../../src/binding/hosts/claude/surfaces.js";
import { BindingOwnershipEntrySchema, BindingWriteSchema } from "../../../../src/binding/lock.js";
import { applyActions, readJson, readText } from "./support.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-claude-mw-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, contents: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

describe("registry-derived surface paths (D4.3)", () => {
  it("resolves settings, mcp, and bootloader paths from the CLI registry", () => {
    expect(CLAUDE_SETTINGS_PATH).toBe(".claude/settings.json");
    expect(CLAUDE_MCP_PATH).toBe(".mcp.json");
    expect(CLAUDE_BOOTLOADER_PATH).toBe("CLAUDE.md");
  });
});

describe("jsonField (owned field in a shared JSON file)", () => {
  it("binds an owned top-level field and records json-pointer ownership", async () => {
    const built = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/model", "claude-opus")
      .build();
    await applyActions(root, built.actions);

    expect(readJson(root, CLAUDE_SETTINGS_PATH)).toEqual({ model: "claude-opus" });

    expect(built.ownership).toHaveLength(1);
    const own = built.ownership[0];
    expect(own?.kind).toBe("json-pointer");
    expect(own?.target).toBe(`${CLAUDE_SETTINGS_PATH}#/model`);
    expect(own?.preExisting).toEqual({ absent: true });
    expect(own?.applied).toBe("claude-opus");

    expect(built.writes[0]).toMatchObject({
      path: CLAUDE_SETTINGS_PATH,
      mechanism: "json-pointer",
    });
    expect(BindingWriteSchema.safeParse(built.writes[0]).success).toBe(true);
  });

  it("preserves unrelated sibling keys byte-for-byte (never a whole-file replace)", async () => {
    seed(
      CLAUDE_SETTINGS_PATH,
      `${JSON.stringify({ telemetry: false, hooks: { PostToolUse: ["keep"] } }, null, 2)}\n`,
    );
    const built = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/hooks/PreToolUse", ["fresh"])
      .build();
    await applyActions(root, built.actions);

    const after = readJson(root, CLAUDE_SETTINGS_PATH);
    expect(after).toEqual({
      telemetry: false,
      hooks: { PostToolUse: ["keep"], PreToolUse: ["fresh"] },
    });
  });

  it("captures a pre-existing value at plan time", async () => {
    seed(CLAUDE_SETTINGS_PATH, `${JSON.stringify({ model: "old-model" }, null, 2)}\n`);
    const built = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/model", "new-model")
      .build();
    expect(built.ownership[0]?.preExisting).toEqual({ value: "old-model" });
    await applyActions(root, built.actions);
    expect(readJson(root, CLAUDE_SETTINGS_PATH)).toEqual({ model: "new-model" });
  });

  it("replaces (not array-unions) an owned array leaf so re-binds stay deterministic", async () => {
    seed(CLAUDE_SETTINGS_PATH, `${JSON.stringify({ hooks: { PreToolUse: ["a"] } }, null, 2)}\n`);
    const built = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/hooks/PreToolUse", ["b"])
      .build();
    await applyActions(root, built.actions);
    expect(readJson(root, CLAUDE_SETTINGS_PATH)).toEqual({ hooks: { PreToolUse: ["b"] } });
  });

  it("refuses a file outside the D4.3 shared-JSON surface", () => {
    const engine = new ClaudeManagedWriteEngine(root);
    expect(() => engine.jsonField(".claude/other.json", "/x", 1)).toThrow();
    expect(() => engine.jsonField("package.json", "/x", 1)).toThrow();
  });

  it("refuses a malformed or too-deep JSON pointer (fail closed)", () => {
    const engine = new ClaudeManagedWriteEngine(root);
    expect(() => engine.jsonField(CLAUDE_SETTINGS_PATH, "model", 1)).toThrow();
    expect(() => engine.jsonField(CLAUDE_SETTINGS_PATH, "/a/b/c", 1)).toThrow();
  });
});

describe("mcpServer (.mcp.json server ownership)", () => {
  it("records mcp-server LEAF ownership when mcpServers already exists", async () => {
    // Pre-existing container => the server is owned as a leaf (siblings survive).
    seed(
      CLAUDE_MCP_PATH,
      `${JSON.stringify({ mcpServers: { keep: { command: "k" } } }, null, 2)}\n`,
    );
    const built = new ClaudeManagedWriteEngine(root)
      .mcpServer("ecc", { command: "ecc-mcp", args: ["serve"] })
      .build();
    await applyActions(root, built.actions);

    expect(readJson(root, CLAUDE_MCP_PATH)).toEqual({
      mcpServers: { keep: { command: "k" }, ecc: { command: "ecc-mcp", args: ["serve"] } },
    });
    const own = built.ownership[0];
    expect(own?.kind).toBe("mcp-server");
    expect(own?.target).toBe("ecc");
    expect(own?.applied).toEqual({ command: "ecc-mcp", args: ["serve"] });
    expect(built.writes[0]?.mechanism).toBe("mcp-server");
  });

  it("records json-pointer PARENT ownership when mcpServers is absent (own what AIH creates)", async () => {
    // No mcpServers container => AIH creates it, so it OWNS the whole container.
    const built = new ClaudeManagedWriteEngine(root)
      .mcpServer("ecc", { command: "ecc-mcp" })
      .build();
    await applyActions(root, built.actions);

    expect(readJson(root, CLAUDE_MCP_PATH)).toEqual({
      mcpServers: { ecc: { command: "ecc-mcp" } },
    });
    expect(built.ownership).toHaveLength(1);
    const own = built.ownership[0];
    expect(own?.kind).toBe("json-pointer");
    expect(own?.target).toBe(`${CLAUDE_MCP_PATH}#/mcpServers`);
    expect(own?.preExisting).toEqual({ absent: true });
    expect(own?.applied).toEqual({ ecc: { command: "ecc-mcp" } });
    // The per-slot write still records the mcp-server mechanism.
    expect(built.writes[0]?.mechanism).toBe("mcp-server");
  });

  it("preserves other MCP servers already in the file", async () => {
    seed(
      CLAUDE_MCP_PATH,
      `${JSON.stringify({ mcpServers: { existing: { command: "keep" } } }, null, 2)}\n`,
    );
    const built = new ClaudeManagedWriteEngine(root)
      .mcpServer("ecc", { command: "ecc-mcp" })
      .build();
    await applyActions(root, built.actions);
    expect(readJson(root, CLAUDE_MCP_PATH)).toEqual({
      mcpServers: { existing: { command: "keep" }, ecc: { command: "ecc-mcp" } },
    });
  });

  it("aggregates two servers into one .mcp.json write AND one parent-container ownership entry", async () => {
    const built = new ClaudeManagedWriteEngine(root)
      .mcpServer("a", { command: "a-mcp" })
      .mcpServer("b", { command: "b-mcp" })
      .build();
    expect(built.actions.filter((a) => a.kind === "write")).toHaveLength(1);
    // Two per-slot writes, but ONE aggregated parent-container ownership entry.
    expect(built.writes).toHaveLength(2);
    expect(built.ownership).toHaveLength(1);
    expect(built.ownership[0]?.target).toBe(`${CLAUDE_MCP_PATH}#/mcpServers`);
    expect(built.ownership[0]?.applied).toEqual({
      a: { command: "a-mcp" },
      b: { command: "b-mcp" },
    });
    await applyActions(root, built.actions);
    expect(readJson(root, CLAUDE_MCP_PATH)).toEqual({
      mcpServers: { a: { command: "a-mcp" }, b: { command: "b-mcp" } },
    });
  });
});

describe("container ownership — depth-2 into an absent parent (D18 own what you created)", () => {
  it("owns the PARENT container as one entry for a single leaf into an absent parent", () => {
    const built = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/enabledPlugins/gstack@aih-gstack", true)
      .build();
    expect(built.ownership).toHaveLength(1);
    const own = built.ownership[0];
    expect(own?.kind).toBe("json-pointer");
    expect(own?.target).toBe(`${CLAUDE_SETTINGS_PATH}#/enabledPlugins`);
    expect(own?.preExisting).toEqual({ absent: true });
    expect(own?.applied).toEqual({ "gstack@aih-gstack": true });
    // The per-slot write stays; only ownership collapses to the parent.
    expect(built.writes).toHaveLength(1);
    expect(built.writes[0]?.mechanism).toBe("json-pointer");
  });

  it("aggregates multiple leaves under the same absent parent into ONE merged-container entry", () => {
    const built = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/skillOverrides/a", "off")
      .jsonField(CLAUDE_SETTINGS_PATH, "/skillOverrides/b", "off")
      .build();
    expect(built.ownership).toHaveLength(1);
    expect(built.ownership[0]?.target).toBe(`${CLAUDE_SETTINGS_PATH}#/skillOverrides`);
    expect(built.ownership[0]?.applied).toEqual({ a: "off", b: "off" });
    // Both per-slot writes are still recorded.
    expect(built.writes).toHaveLength(2);
  });

  it("keeps LEAF ownership when the parent already exists (siblings owned independently)", () => {
    seed(
      CLAUDE_SETTINGS_PATH,
      `${JSON.stringify({ skillOverrides: { userOwned: "off" } }, null, 2)}\n`,
    );
    const built = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/skillOverrides/a", "off")
      .build();
    expect(built.ownership).toHaveLength(1);
    expect(built.ownership[0]?.target).toBe(`${CLAUDE_SETTINGS_PATH}#/skillOverrides/a`);
    expect(built.ownership[0]?.applied).toBe("off");
  });
});

describe("claudeMdBlock (single managed CLAUDE.md fence)", () => {
  const bootstrapBlock = [
    "# repo — Claude bootloader",
    "",
    "hand-written preamble",
    "",
    "<!-- BEGIN ai-canonical:shared (note) -->",
    "",
    "shared canon body",
    "",
    "<!-- END ai-canonical:shared -->",
    "",
  ].join("\n");

  it("adds its own fence while preserving the bootstrap block and user content", async () => {
    seed(CLAUDE_BOOTLOADER_PATH, bootstrapBlock);
    const built = new ClaudeManagedWriteEngine(root).claudeMdBlock("binding guidance body").build();
    await applyActions(root, built.actions);

    const after = readText(root, CLAUDE_BOOTLOADER_PATH);
    expect(after).toContain("hand-written preamble");
    expect(after).toContain("<!-- BEGIN ai-canonical:shared");
    expect(after).toContain("shared canon body");
    expect(after).toContain(`<!-- BEGIN ${CLAUDE_BINDING_MARKER}`);
    expect(after).toContain("binding guidance body");

    const own = built.ownership[0];
    expect(own?.kind).toBe("file");
    expect(own?.target).toBe(`${CLAUDE_BOOTLOADER_PATH}#block:${CLAUDE_BINDING_MARKER}`);
    expect(built.writes[0]?.mechanism).toBe("file");
  });

  it("re-binding the same body rewrites no bytes (idempotent)", async () => {
    seed(CLAUDE_BOOTLOADER_PATH, bootstrapBlock);
    const first = new ClaudeManagedWriteEngine(root).claudeMdBlock("stable body").build();
    await applyActions(root, first.actions);
    const afterFirst = readText(root, CLAUDE_BOOTLOADER_PATH);

    const second = new ClaudeManagedWriteEngine(root).claudeMdBlock("stable body").build();
    const result = await applyActions(root, second.actions);
    expect(readText(root, CLAUDE_BOOTLOADER_PATH)).toBe(afterFirst);
    expect(result.writes.every((w) => w.effect === "unchanged")).toBe(true);
    expect(result.backups).toHaveLength(0);
  });

  it("preserves CRLF line endings", async () => {
    seed(CLAUDE_BOOTLOADER_PATH, bootstrapBlock.replace(/\n/g, "\r\n"));
    const built = new ClaudeManagedWriteEngine(root).claudeMdBlock("crlf body").build();
    await applyActions(root, built.actions);
    const after = readText(root, CLAUDE_BOOTLOADER_PATH);
    expect(after).toContain("\r\n");
    expect(after).not.toMatch(/[^\r]\n/);
  });

  it("preserves LF line endings", async () => {
    seed(CLAUDE_BOOTLOADER_PATH, bootstrapBlock);
    const built = new ClaudeManagedWriteEngine(root).claudeMdBlock("lf body").build();
    await applyActions(root, built.actions);
    expect(readText(root, CLAUDE_BOOTLOADER_PATH)).not.toContain("\r\n");
  });
});

describe("ownedFile (digest-owned rules/skills/agents file)", () => {
  it("binds a skill file and records file ownership", async () => {
    const rel = ".claude/skills/ecc/SKILL.md";
    const built = new ClaudeManagedWriteEngine(root).ownedFile(rel, "# ecc skill\n").build();
    await applyActions(root, built.actions);
    expect(readText(root, rel)).toBe("# ecc skill\n");
    const own = built.ownership[0];
    expect(own?.kind).toBe("file");
    expect(own?.target).toBe(rel);
    expect(built.writes[0]?.mechanism).toBe("file");
  });

  it("accepts rules/, skills/, and agents/ roots", () => {
    const engine = new ClaudeManagedWriteEngine(root);
    expect(() => engine.ownedFile(".claude/rules/r.md", "x")).not.toThrow();
    expect(() => engine.ownedFile(".claude/skills/s/SKILL.md", "x")).not.toThrow();
    expect(() => engine.ownedFile(".claude/agents/a.md", "x")).not.toThrow();
  });

  it("refuses a path outside the D4.3 owned-file surfaces", () => {
    const engine = new ClaudeManagedWriteEngine(root);
    expect(() => engine.ownedFile(".claude/settings.json", "x")).toThrow();
    expect(() => engine.ownedFile("docs/readme.md", "x")).toThrow();
    expect(() => engine.ownedFile(".claude/commands/c.md", "x")).toThrow();
  });

  it("rejects a Windows backslash path at the schema boundary", () => {
    const engine = new ClaudeManagedWriteEngine(root);
    expect(() => engine.ownedFile(".claude\\skills\\s\\SKILL.md", "x")).toThrow();
  });

  it("rejects a parent-traversal path", () => {
    const engine = new ClaudeManagedWriteEngine(root);
    expect(() => engine.ownedFile(".claude/skills/../../etc/x", "x")).toThrow();
  });
});

describe("finalizeClaudeOwnership (post-apply digest sealing)", () => {
  it("produces lock-valid ownership entries after apply", async () => {
    seed(CLAUDE_BOOTLOADER_PATH, "# preamble\n");
    const built = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/model", "m")
      .mcpServer("ecc", { command: "ecc-mcp" })
      .claudeMdBlock("body")
      .ownedFile(".claude/skills/ecc/SKILL.md", "# skill\n")
      .build();
    await applyActions(root, built.actions);

    const entries = finalizeClaudeOwnership(root, built.ownership);
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(BindingOwnershipEntrySchema.safeParse(entry).success).toBe(true);
      expect(entry.postApplyDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("digests are stable across identical re-binds", async () => {
    const build = () =>
      new ClaudeManagedWriteEngine(root).jsonField(CLAUDE_SETTINGS_PATH, "/model", "m").build();
    const first = build();
    await applyActions(root, first.actions);
    const a = finalizeClaudeOwnership(root, first.ownership)[0]?.postApplyDigest;
    const second = build();
    await applyActions(root, second.actions);
    const b = finalizeClaudeOwnership(root, second.ownership)[0]?.postApplyDigest;
    expect(a).toBe(b);
  });
});

describe("symlinked target refusal (fsxn/execute guards engaged)", () => {
  it("refuses to write through a symlinked/junctioned parent dir", async () => {
    // Junction works on Windows without privilege; dir symlink elsewhere.
    const { symlinkSync } = await import("node:fs");
    const outside = mkdtempSync(join(tmpdir(), "aih-claude-outside-"));
    try {
      symlinkSync(
        outside,
        join(root, ".claude"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      return; // symlink unsupported in this environment — nothing to prove
    }
    const built = new ClaudeManagedWriteEngine(root)
      .jsonField(CLAUDE_SETTINGS_PATH, "/model", "m")
      .build();
    await expect(applyActions(root, built.actions)).rejects.toThrow();
    rmSync(outside, { recursive: true, force: true });
    expect(existsSync(join(outside, "settings.json"))).toBe(false);
  });
});
