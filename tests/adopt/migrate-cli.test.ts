import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliFootprint } from "../../src/adopt/cli-footprint.js";
import { command } from "../../src/adopt/index.js";
import { migrateCliActions } from "../../src/adopt/migrate-cli.js";
import { readAihConfig } from "../../src/config/marker.js";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const DIR = "ai-coding";
let tmp: string;
let extraRoots: string[];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-migrate-"));
  extraRoots = [];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const root of extraRoots) rmSync(root, { recursive: true, force: true });
});

function put(rel: string, contents: string): void {
  const full = join(tmp, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}
function read(rel: string): string {
  return readFileSync(join(tmp, rel), "utf8");
}
function makeCtx(
  options: Record<string, unknown> = {},
  apply = false,
  contextDir = DIR,
): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: tmp,
    contextDir,
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { HOME: tmp } }),
    env: { HOME: tmp },
    options,
  };
}
function writePaths(actions: Action[]): string[] {
  return actions
    .filter((a): a is WriteAction => a.kind === "write")
    .map((a) => a.path.replace(/\\/g, "/"));
}

describe("migrateCliActions — what migrates, what doesn't", () => {
  it("rule file → canon copy + pointer-convert of the original", () => {
    put(".cursorrules", "# My cursor rules\n\n- Use tabs.\n");
    const actions = migrateCliActions(tmp, cliFootprint(tmp, DIR), DIR);
    const paths = writePaths(actions);
    expect(paths).toContain("ai-coding/rules/from-cursorrules.md"); // additive copy
    expect(paths).toContain(".cursorrules"); // pointer-convert (executor backs it up)
  });

  it("content dir → copies each file into canon, leaves the originals", () => {
    put(".claude/agents/security.md", "# security agent\n");
    put(".claude/agents/review.md", "# review agent\n");
    const paths = writePaths(migrateCliActions(tmp, cliFootprint(tmp, DIR), DIR));
    expect(paths).toContain("ai-coding/agents/security.md");
    expect(paths).toContain("ai-coding/agents/review.md");
    // No pointer-conversion of a directory's files — originals are never rewritten.
    expect(paths).not.toContain(".claude/agents/security.md");
  });

  it("rule dirs are namespaced by source so duplicate filenames cannot overwrite each other", () => {
    put(".claude/rules/security.md", "# Claude security\n");
    put(".cursor/rules/security.md", "# Cursor security\n");
    const paths = writePaths(migrateCliActions(tmp, cliFootprint(tmp, DIR), DIR));
    expect(paths).toContain("ai-coding/rules/from-claude/security.md");
    expect(paths).toContain("ai-coding/rules/from-cursor/security.md");
    expect(paths).not.toContain("ai-coding/rules/security.md");
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("ignores symlinked CLI-native directories that escape the repo root", () => {
    const outside = mkdtempSync(join(tmpdir(), "aih-migrate-outside-"));
    extraRoots.push(outside);
    writeFileSync(join(outside, "external-note.md"), "# outside root\n", "utf8");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    try {
      symlinkSync(
        outside,
        join(tmp, ".claude", "agents"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      return;
    }

    const fp = cliFootprint(tmp, DIR);
    expect(fp.artifacts.find((a) => a.path === ".claude/agents")).toBeUndefined();
    const paths = writePaths(migrateCliActions(tmp, fp, DIR));
    expect(paths).not.toContain("ai-coding/agents/external-note.md");
  });

  it("leaves memory and tool config untouched (skipped)", () => {
    put(".claude/memory/note.md", "# personal memory\n");
    put(".codex/config.toml", "x=1\n");
    expect(migrateCliActions(tmp, cliFootprint(tmp, DIR), DIR)).toHaveLength(0);
  });

  it("never migrates a pointer or an acknowledged/personal artifact", () => {
    put(".cursorrules", "Read `ai-coding/RULE_ROUTER.md`\n"); // already a pointer (wired)
    expect(migrateCliActions(tmp, cliFootprint(tmp, DIR), DIR)).toHaveLength(0);

    put(".claude/agents/x.md", "# agent\n");
    const ackFp = cliFootprint(tmp, DIR, {
      committed: new Set([".claude/agents/x.md"]),
      acknowledged: new Set([".claude/agents"]),
    });
    expect(migrateCliActions(tmp, ackFp, DIR)).toHaveLength(0);
  });
});

describe("aih adopt --migrate-cli --apply — execution", () => {
  it("folds a rule file into the canon and leaves a pointer (backed up)", async () => {
    put(".cursorrules", "# My cursor rules\n\n- Prefer composition.\n");
    const ctx = makeCtx({ migrateCli: true }, true);
    await executePlan(await command.plan(ctx), ctx);

    // Content is now canonical...
    expect(read("ai-coding/rules/from-cursorrules.md")).toContain("Prefer composition.");
    // ...the original is a thin pointer...
    expect(read(".cursorrules")).toContain("ai-coding/rules/from-cursorrules.md");
    expect(read(".cursorrules")).toContain("migrated");
    // ...and the executor preserved the original in a backup.
    expect(existsSync(join(tmp, ".cursorrules.aih.bak"))).toBe(true);
    expect(readFileSync(join(tmp, ".cursorrules.aih.bak"), "utf8")).toContain(
      "Prefer composition.",
    );
  });

  it("is idempotent — a second --migrate-cli run writes nothing new for the pointer", async () => {
    put(".cursorrules", "# rules\n\n- x\n");
    const ctx = makeCtx({ migrateCli: true }, true);
    await executePlan(await command.plan(ctx), ctx);
    // Now .cursorrules is a pointer → a fresh plan produces no migrate write for it.
    const second = writePaths((await command.plan(makeCtx({ migrateCli: true }))).actions);
    expect(second).not.toContain(".cursorrules");
  });

  it("uses the active context dir in the --migrate-cli preview", async () => {
    put(".cursorrules", "# rules\n");
    const actions = (await command.plan(makeCtx({ migrateCli: true }, false, ".ai-context")))
      .actions;
    const digest = actions.find((a) => a.kind === "digest");
    expect(digest?.kind === "digest" ? digest.text : "").toContain(
      "[migrate] .cursorrules → .ai-context/",
    );
    expect(digest?.kind === "digest" ? digest.text : "").not.toContain(
      "[migrate] .cursorrules → ai-coding/",
    );
  });

  it("does not list skipped tool config as a migrated target", async () => {
    put(".codex/config.toml", 'model = "gpt-5"\n');
    const actions = (await command.plan(makeCtx({ migrateCli: true }))).actions;
    const digest = actions.find((a) => a.kind === "digest");
    const text = digest?.kind === "digest" ? (digest.text ?? "") : "";
    expect(text).toContain("--migrate-cli: no migratable import candidates to migrate.");
    expect(text).toContain("Left untouched (review manually): .codex");
    expect(text).not.toContain("[migrate] .codex");
  });
});

describe("aih adopt --ack — acknowledge writer", () => {
  it("records the path in .aih-config.json and the footprint then reads it as [kept]", async () => {
    put(".claude/agents/x.md", "# agent\n");
    // Seed an existing marker so the merge has a base.
    put(
      ".aih-config.json",
      JSON.stringify({ schemaVersion: 1, contextDir: DIR, targets: ["claude"] }),
    );

    const ctx = makeCtx({ ack: ".claude\\agents/" }, true);
    await executePlan(await command.plan(ctx), ctx);

    const cfg = readAihConfig(tmp);
    expect(cfg?.adopt?.acknowledged).toContain(".claude/agents");
    expect(cfg?.adopt?.acknowledged).not.toContain(".claude\\agents/");
    // Re-derive the footprint with the persisted acknowledge list → [kept], not [import].
    const fp = cliFootprint(tmp, DIR, {
      committed: new Set([".claude/agents/x.md"]),
      acknowledged: new Set(cfg?.adopt?.acknowledged ?? []),
    });
    expect(fp.artifacts.find((a) => a.path === ".claude/agents")?.disposition).toBe("kept");
    expect(fp.importCandidates).toBe(0);
  });

  it("rejects unknown --ack paths instead of writing a non-matching marker", async () => {
    put(".claude/agents/x.md", "# agent\n");
    await expect(command.plan(makeCtx({ ack: ".claude/agentz/" }))).rejects.toThrow(
      /not a detected CLI-native artifact/,
    );
  });
});
