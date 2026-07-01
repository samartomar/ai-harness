import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SHARED_MARKER, sharedBlock } from "../../src/bootstrap-ai/canon.js";
import { mergeManagedBlock } from "../../src/internals/markers.js";
import type { Action, Plan, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/prune/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-prune-cmd-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    ...over,
  };
}

function write(rel: string, content = "x"): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function marker(...targets: string[]): void {
  writeFileSync(
    join(dir, ".aih-config.json"),
    JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets }),
  );
}

const actionsOf = (over: Partial<PlanContext> = {}): Action[] =>
  (command.plan(ctx(over)) as Plan).actions;
const digestText = (actions: Action[]): string => {
  const d = actions.find((a): a is Extract<Action, { kind: "digest" }> => a.kind === "digest");
  return d?.text ?? "";
};

describe("aih prune command", () => {
  it("guides the user when there is no committed target set to diff", () => {
    const text = digestText(actionsOf());
    expect(text).toContain("No committed target set");
    expect(text).toContain("aih bootstrap-ai");
  });

  it("emits a `remove` action per file artifact and a `write` (block-subtract) per bootloader", () => {
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md"); // dropped → file remove
    // codex's AGENTS.md bootloader carries a real managed block + a user preamble.
    writeFileSync(
      join(dir, "AGENTS.md"),
      mergeManagedBlock(undefined, sharedBlock("ai-coding"), "# My preamble"),
    );
    const actions = actionsOf();

    const removes = actions.filter((a) => a.kind === "remove").map((a) => a.path);
    expect(removes).toContain("ai-coding/adapters/codex.md");

    const subtract = actions.find(
      (a): a is Extract<Action, { kind: "write" }> => a.kind === "write" && a.path === "AGENTS.md",
    );
    expect(subtract).toBeDefined();
    // The write lands the file MINUS aih's canon block, preamble preserved.
    expect(subtract?.contents).toBe("# My preamble\n");

    // A .gitignore write is present so `.aih/legacy/` is ignored before the move.
    expect(actions.some((a) => a.kind === "write" && a.path === ".gitignore")).toBe(true);
  });

  it("routes an MCP config to a manual advisory in the digest — never an auto-action", () => {
    marker("codex"); // keep codex (AGENTS.md stays); drop cursor
    write("ai-coding/adapters/codex.md");
    write("ai-coding/adapters/cursor.md");
    write(".cursor/mcp.json", JSON.stringify({ mcpServers: {} }));
    const actions = actionsOf();
    // The MCP config is NOT touched by any write/remove action.
    const touched = actions
      .filter((a) => a.kind === "write" || a.kind === "remove")
      .map((a) => (a as { path: string }).path);
    expect(touched).not.toContain(".cursor/mcp.json");
    // It appears as a manual-review line in the digest instead.
    const text = digestText(actions);
    expect(text).toContain("Manual review");
    expect(text).toContain(".cursor/mcp.json");
  });

  it("skips a bootloader that carries no aih block (nothing to subtract)", () => {
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md");
    writeFileSync(join(dir, "AGENTS.md"), "# just my own notes, no aih block\n");
    const actions = actionsOf();
    // No write targets AGENTS.md (its block is absent), but the adapter is still removed.
    expect(actions.some((a) => a.kind === "write" && a.path === "AGENTS.md")).toBe(false);
    expect(
      actions.some((a) => a.kind === "remove" && a.path === "ai-coding/adapters/codex.md"),
    ).toBe(true);
  });

  it("never subtracts a block whose body is NOT aih's canonical body (drift/look-alike guard)", () => {
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md");
    // A block carrying the aih marker but a HAND-EDITED body — not what aih generates.
    writeFileSync(
      join(dir, "AGENTS.md"),
      mergeManagedBlock(
        undefined,
        { marker: SHARED_MARKER, note: "x", body: "hand-edited, not aih canonical" },
        "# preamble",
      ),
    );
    const actions = actionsOf();
    // The look-alike/drifted block is left untouched (never blindly stripped).
    expect(actions.some((a) => a.kind === "write" && a.path === "AGENTS.md")).toBe(false);
  });
});
