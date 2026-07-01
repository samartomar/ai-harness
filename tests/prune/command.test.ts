import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SHARED_MARKER, sharedBlock } from "../../src/bootstrap-ai/canon.js";
import { mergeManagedBlock } from "../../src/internals/markers.js";
import type { Action, PlanContext } from "../../src/internals/plan.js";
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

const actionsOf = async (over: Partial<PlanContext> = {}): Promise<Action[]> =>
  (await command.plan(ctx(over))).actions;
const digestText = (actions: Action[]): string => {
  const d = actions.find((a): a is Extract<Action, { kind: "digest" }> => a.kind === "digest");
  return d?.text ?? "";
};

describe("aih prune command", () => {
  it("guides the user when there is no committed target set to diff", async () => {
    const text = digestText(await actionsOf());
    expect(text).toContain("No committed target set");
    expect(text).toContain("aih bootstrap-ai");
  });

  it("emits a `remove` action per file artifact and a `write` (block-subtract) per bootloader", async () => {
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md"); // dropped → file remove
    // codex's AGENTS.md bootloader carries a real managed block + a user preamble.
    writeFileSync(
      join(dir, "AGENTS.md"),
      mergeManagedBlock(undefined, sharedBlock("ai-coding"), "# My preamble"),
    );
    const actions = await actionsOf();

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

  it("routes an MCP config to a manual advisory in the digest — never an auto-action", async () => {
    marker("codex"); // keep codex (AGENTS.md stays); drop cursor
    write("ai-coding/adapters/codex.md");
    write("ai-coding/adapters/cursor.md");
    write(".cursor/mcp.json", JSON.stringify({ mcpServers: {} }));
    const actions = await actionsOf();
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

  it("skips a bootloader that carries no aih block (nothing to subtract)", async () => {
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md");
    writeFileSync(join(dir, "AGENTS.md"), "# just my own notes, no aih block\n");
    const actions = await actionsOf();
    // No write targets AGENTS.md (its block is absent), but the adapter is still removed.
    expect(actions.some((a) => a.kind === "write" && a.path === "AGENTS.md")).toBe(false);
    expect(
      actions.some((a) => a.kind === "remove" && a.path === "ai-coding/adapters/codex.md"),
    ).toBe(true);
  });

  it("never subtracts a block whose body is NOT aih's canonical body (drift/look-alike guard)", async () => {
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
    const actions = await actionsOf();
    // The look-alike/drifted block is left untouched (never blindly stripped).
    expect(actions.some((a) => a.kind === "write" && a.path === "AGENTS.md")).toBe(false);
  });
});

describe("aih prune --delete / --unrunnable", () => {
  /** A runner where `which <bin>` succeeds only for bins in `onPath`. */
  const pathRunner = (onPath: string[]) =>
    fakeRunner((argv) => {
      if (argv[0] !== "which") return undefined;
      const bin = argv[1] ?? "";
      return onPath.includes(bin)
        ? { code: 0, stdout: `/usr/bin/${bin}` }
        : { code: 1, stdout: "", stderr: "not found" };
    });

  it("--delete marks file removals hardDelete (single-slot .aih.bak, no legacy archive)", async () => {
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md"); // dropped
    const actions = await actionsOf({ options: { delete: true } });
    const rm = actions.find((a): a is Extract<Action, { kind: "remove" }> => a.kind === "remove");
    expect(rm?.hardDelete).toBe(true);
    const text = digestText(actions);
    expect(text).toContain("hard-delete");
    expect(text).not.toContain("move to .aih/legacy/");
  });

  it("default runs never hardDelete", async () => {
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md");
    const actions = await actionsOf();
    const rm = actions.find((a): a is Extract<Action, { kind: "remove" }> => a.kind === "remove");
    expect(rm?.hardDelete).toBeFalsy();
  });

  it("--unrunnable folds no-binary targeted CLIs in, with the loud warning", async () => {
    marker("claude", "cursor"); // both targeted…
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/cursor.md");
    // …but only claude's binary is on PATH.
    const actions = await actionsOf({
      options: { unrunnable: true },
      run: pathRunner(["claude"]),
    });
    expect(
      actions.some((a) => a.kind === "remove" && a.path === "ai-coding/adapters/cursor.md"),
    ).toBe(true);
    const text = digestText(actions);
    expect(text).toContain("--unrunnable");
    expect(text).toContain("PATH problem");
    expect(text).toContain(".aih-config.json are unchanged");
  });

  it("without the flag, an unrunnable-but-targeted CLI is untouched", async () => {
    marker("claude", "cursor");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/cursor.md");
    const actions = await actionsOf({ run: pathRunner(["claude"]) });
    expect(actions.some((a) => a.kind === "remove")).toBe(false);
    expect(digestText(actions)).toContain("No stale per-CLI artifacts");
  });
});
