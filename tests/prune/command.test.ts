import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHARED_MARKER, sharedBlock } from "../../src/bootstrap-ai/canon.js";
import { executePlan } from "../../src/internals/execute.js";
import { mergeManagedBlock } from "../../src/internals/markers.js";
import type { Action, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { policyProjectCommand } from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/prune/index.js";

// prune's ECC share runs through @aihq/framework-ecc: read it from this repository's package source.
vi.mock("../../src/framework-plugin/load-framework-plugin.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/framework-plugin/load-framework-plugin.js")>();
  const { sourcePluginAccess } = await import("../framework-plugin/source-plugin-mocks.js");
  return {
    ...actual,
    loadFrameworkPluginV1: (
      id: Parameters<typeof actual.loadFrameworkPluginV1>[0],
      options: Parameters<typeof actual.loadFrameworkPluginV1>[1] = {},
    ) => actual.loadFrameworkPluginV1(id, { ...options, access: sourcePluginAccess(id) }),
  };
});
vi.mock("../../src/catalog-package/framework-descriptors.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/catalog-package/framework-descriptors.js")>();
  const { eccDescriptorLoad } = await import("../framework-plugin/source-plugin-mocks.js");
  return {
    ...actual,
    loadFrameworkDescriptorBytesV1: async (
      id: Parameters<typeof actual.loadFrameworkDescriptorBytesV1>[0],
    ) => (id === "ecc" ? eccDescriptorLoad() : actual.loadFrameworkDescriptorBytesV1(id)),
  };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-prune-cmd-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  const env = { HOME: join(dir, "home"), USERPROFILE: join(dir, "home") };
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env }),
    env,
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
  const d = actions.find(
    (a): a is Extract<Action, { kind: "digest" }> =>
      a.kind === "digest" && a.describe.startsWith("Stale artifacts"),
  );
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

  it("preserves unreceipted ECC content instead of launching an upstream uninstall", async () => {
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/cursor.md");
    write(".cursor/plugins/operator.js", "operator\n");
    const actions = await actionsOf();
    expect(actions.some((action) => action.kind === "exec" && action.argv.includes("npx"))).toBe(
      false,
    );
    expect(
      actions.some(
        (action) => action.kind === "remove" && action.path === "ai-coding/adapters/cursor.md",
      ),
    ).toBe(true);
    expect(
      actions.some(
        (action) =>
          (action.kind === "remove" || action.kind === "write") &&
          action.path === ".cursor/plugins/operator.js",
      ),
    ).toBe(false);
  });

  describe("dropped-target managed-MCP residue", () => {
    const MANAGED = ".claude/managed-settings.json";
    const managedPath = (): string => join(dir, ".claude", "managed-settings.json");
    const readJson = (path: string): Record<string, unknown> =>
      JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const writeOf = (
      actions: Action[],
      path: string,
    ): Extract<Action, { kind: "write" }> | undefined =>
      actions.find(
        (a): a is Extract<Action, { kind: "write" }> => a.kind === "write" && a.path === path,
      );

    /**
     * Project a real AIH-owned managed-MCP pair for claude, then drop claude from the
     * committed targets — the exact state issue #566 describes. Built with the real
     * projection command so the fixture cannot drift from what production writes.
     */
    async function droppedClaudeProjection(keep = ["kiro"]): Promise<void> {
      write("ai-coding/adapters/claude.md");
      write("ai-coding/adapters/kiro.md");
      write(".claude/managed-settings.json", JSON.stringify({ operatorOnly: true }));
      writeFileSync(
        join(dir, "aih-org-policy.json"),
        JSON.stringify({
          schemaVersion: 2,
          minimumPosture: "enterprise",
          references: { repoContract: "ai-coding/project.json" },
          governance: { supportedClis: ["claude", "kiro"] },
          mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
        }),
      );
      marker("claude", "kiro");
      const projectCtx = ctx({ apply: true });
      await executePlan(await policyProjectCommand.plan(projectCtx), projectCtx);
      const cfg = readJson(join(dir, ".aih-config.json"));
      writeFileSync(join(dir, ".aih-config.json"), JSON.stringify({ ...cfg, targets: keep }));
    }

    it("subtracts exactly the two marker-proven keys, ownership last, never a delete", async () => {
      await droppedClaudeProjection();
      const actions = await actionsOf();

      const subtract = writeOf(actions, MANAGED);
      const ownership = writeOf(actions, ".aih-config.json");
      expect(subtract?.removeJsonTopLevelKeys).toEqual([
        "allowManagedMcpServersOnly",
        "allowedMcpServers",
      ]);
      expect(ownership?.removeJsonTopLevelKeys).toEqual(["managedMcpProjection"]);
      // Owned content first, ownership state second (src/ecc/reconcile-driver.ts:485, :511).
      expect(actions.indexOf(subtract as Action)).toBeLessThan(
        actions.indexOf(ownership as Action),
      );
      // FILE DELETION IS NEVER AUTHORIZED — the marker proves two keys, not the file.
      expect(actions.filter((a) => a.kind === "remove").map((a) => a.path)).not.toContain(MANAGED);
      expect(digestText(actions)).toContain(MANAGED);
    });

    it("leaves every other key's value unchanged under --apply", async () => {
      await droppedClaudeProjection();
      const before = readJson(managedPath());

      const applyCtx = ctx({ apply: true });
      await executePlan(await command.plan(applyCtx), applyCtx);
      const after = readJson(managedPath());

      expect(after).not.toHaveProperty("allowManagedMcpServersOnly");
      expect(after).not.toHaveProperty("allowedMcpServers");
      expect(after.operatorOnly).toBe(true);
      // organizationPolicy / sandbox carry no provenance and are NEVER subtracted.
      expect(after.organizationPolicy).toEqual(before.organizationPolicy);
      expect(after.sandbox).toEqual(before.sandbox);
      expect(readJson(join(dir, ".aih-config.json"))).not.toHaveProperty("managedMcpProjection");
    });

    it("reconciles the residue even after the dropped CLI's adapter is already gone", async () => {
      await droppedClaudeProjection();
      rmSync(join(dir, "ai-coding", "adapters", "claude.md"));

      const applyCtx = ctx({ apply: true });
      await executePlan(await command.plan(applyCtx), applyCtx);

      expect(readJson(managedPath())).not.toHaveProperty("allowManagedMcpServersOnly");
    });

    it("never weakens the projection for a still-committed but unrunnable claude", async () => {
      // --unrunnable prunes per-CLI FILES on a weaker signal (no binary on PATH). A
      // missing binary is not evidence the repo dropped Claude, so it must never
      // subtract an enforcement control.
      await droppedClaudeProjection(["claude", "kiro"]);
      const before = readFileSync(managedPath(), "utf8");

      const applyCtx = ctx({ apply: true, options: { unrunnable: true } });
      await executePlan(await command.plan(applyCtx), applyCtx);

      expect(readFileSync(managedPath(), "utf8")).toBe(before);
      expect(readJson(join(dir, ".aih-config.json"))).toMatchObject({
        managedMcpProjection: { state: "active" },
      });
    });

    it("revokes rather than crashing when a directory sits at the projected path", async () => {
      // Presence must be probed with a stat, not a content read: `readFileSync` throws
      // EISDIR on a directory, which took the whole command down before it could report
      // the residue it exists to report.
      await droppedClaudeProjection();
      rmSync(managedPath());
      mkdirSync(managedPath(), { recursive: true });

      const applyCtx = ctx({ apply: true });
      const actions = (await command.plan(applyCtx)).actions;
      await executePlan({ capability: "prune", actions }, applyCtx);

      expect(writeOf(actions, MANAGED)).toBeUndefined();
      expect(digestText(actions)).toContain("not a readable regular file");
      expect(readJson(join(dir, ".aih-config.json"))).toMatchObject({
        managedMcpProjection: { state: "revoked" },
      });
    });

    it.skipIf(process.platform === "win32")(
      "classifies a FIFO as non-regular and revokes the ownership claim",
      async () => {
        await droppedClaudeProjection();
        rmSync(managedPath());
        const made = spawnSync("mkfifo", [managedPath()]);
        expect(made.status, made.stderr?.toString()).toBe(0);

        const applyCtx = ctx({ apply: true });
        const actions = (await command.plan(applyCtx)).actions;
        await executePlan({ capability: "prune", actions }, applyCtx);

        expect(writeOf(actions, MANAGED)).toBeUndefined();
        expect(digestText(actions)).toContain("not a readable regular file");
        expect(readJson(join(dir, ".aih-config.json"))).toMatchObject({
          managedMcpProjection: { state: "revoked" },
        });
      },
    );

    it("revokes a claim whose projected path is a dangling symlink", async () => {
      // Presence must be NO-FOLLOW: `existsSync` calls a dangling link absent, which
      // would leave the stale ownership claim standing forever with nothing reported.
      await droppedClaudeProjection();
      rmSync(managedPath());
      symlinkSync(join(dir, "nowhere.json"), managedPath());

      const applyCtx = ctx({ apply: true });
      const actions = (await command.plan(applyCtx)).actions;
      await executePlan({ capability: "prune", actions }, applyCtx);

      expect(writeOf(actions, MANAGED)).toBeUndefined();
      expect(digestText(actions)).toContain("not a readable regular file");
      expect(readJson(join(dir, ".aih-config.json"))).toMatchObject({
        managedMcpProjection: { state: "revoked" },
      });
    });

    it("never names a repair for a residue behind a symlinked parent", async () => {
      // The leaf read is no-follow, but a symlinked PARENT would still redirect it —
      // and the executor refuses those outright. Classifying such a path as repairable
      // would name `aih prune` for a finding prune is guaranteed to refuse, breaking
      // the one promise this lifecycle makes: the command it names clears it.
      await droppedClaudeProjection();
      const elsewhere = join(dir, "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      const real = readFileSync(managedPath(), "utf8");
      writeFileSync(join(elsewhere, "managed-settings.json"), real);
      rmSync(join(dir, ".claude"), { recursive: true, force: true });
      symlinkSync(elsewhere, join(dir, ".claude"), "junction");

      const applyCtx = ctx({ apply: true });
      const actions = (await command.plan(applyCtx)).actions;
      await executePlan({ capability: "prune", actions }, applyCtx);

      expect(writeOf(actions, MANAGED)).toBeUndefined();
      expect(digestText(actions)).toContain("symlinked parent");
      // The redirected file is untouched, and the claim is given up rather than kept.
      expect(readFileSync(join(elsewhere, "managed-settings.json"), "utf8")).toBe(real);
      expect(readJson(join(dir, ".aih-config.json"))).toMatchObject({
        managedMcpProjection: { state: "revoked" },
      });
    });

    it("revokes rather than overwrites a drifted pair", async () => {
      await droppedClaudeProjection();
      const operatorPair = [{ serverCommand: ["operator-mcp", "serve"] }];
      writeFileSync(
        managedPath(),
        JSON.stringify({ ...readJson(managedPath()), allowedMcpServers: operatorPair }),
      );

      const applyCtx = ctx({ apply: true });
      await executePlan(await command.plan(applyCtx), applyCtx);

      expect(readJson(managedPath()).allowedMcpServers).toEqual(operatorPair);
      expect(readJson(join(dir, ".aih-config.json"))).toMatchObject({
        managedMcpProjection: { state: "revoked" },
      });
    });

    it("stays silent and mutates nothing when no ownership marker proves the residue", async () => {
      // Prune must advertise only what prune can act on. With no active claim there is
      // nothing to subtract AND nothing to revoke, so naming the file here would tell an
      // agent to re-run a command designed to refuse — forever. `aih doctor`'s
      // `org-policy.dropped-target-unowned` owns this case and says to escalate.
      write("ai-coding/adapters/claude.md");
      write("ai-coding/adapters/kiro.md");
      const operatorOwned = JSON.stringify({
        allowManagedMcpServersOnly: true,
        allowedMcpServers: [{ serverCommand: ["operator-mcp", "serve"] }],
      });
      write(".claude/managed-settings.json", operatorOwned);
      marker("kiro");

      const applyCtx = ctx({ apply: true });
      const actions = (await command.plan(applyCtx)).actions;
      await executePlan({ capability: "prune", actions }, applyCtx);

      expect(writeOf(actions, MANAGED)).toBeUndefined();
      expect(readFileSync(managedPath(), "utf8")).toBe(operatorOwned);
      expect(digestText(actions)).not.toContain(MANAGED);
    });

    it("converges — a second prune says nothing about an already-reconciled residue", async () => {
      await droppedClaudeProjection();
      const first = ctx({ apply: true });
      await executePlan(await command.plan(first), first);

      const second = ctx({ apply: true });
      const actions = (await command.plan(second)).actions;
      const after = readFileSync(managedPath(), "utf8");
      await executePlan({ capability: "prune", actions }, second);

      expect(writeOf(actions, MANAGED)).toBeUndefined();
      expect(digestText(actions)).not.toContain(MANAGED);
      // organizationPolicy / sandbox legitimately remain and are never touched.
      expect(readFileSync(managedPath(), "utf8")).toBe(after);
      expect(readJson(managedPath())).toHaveProperty("organizationPolicy");
    });
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

  it("treats --cli/--all-tools/--detect as ignored selection flags, not prune intent", async () => {
    marker("claude", "codex", "gemini");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md");
    write("ai-coding/adapters/gemini.md");

    const actions = await actionsOf({ options: { allTools: true, cli: "claude", detect: true } });
    expect(actions.some((a) => a.kind === "remove")).toBe(false);

    const text = digestText(actions);
    expect(text).toContain("--cli");
    expect(text).toContain("--all-tools");
    expect(text).toContain("--detect");
    expect(text).toContain("ignored");
    expect(text).toContain("committed intent only");
    expect(text).toContain("Kept (.aih-config.json): claude, codex, gemini");
  });
});
