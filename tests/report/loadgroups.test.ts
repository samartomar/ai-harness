import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanLoadGroups } from "../../src/report/loadgroups.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-loadgroups-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a file of `bytes` bytes (so tokens = ceil(bytes/4)). */
function put(rel: string, bytes: number): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "x".repeat(bytes), "utf8");
}

function groupFor(model: ReturnType<typeof scanLoadGroups>, cli: string) {
  return model.groups.find((g) => g.clis.includes(cli as never));
}

describe("scanLoadGroups", () => {
  it("collapses CLIs that share a bootloader into one group", () => {
    put("AGENTS.md", 400); // 100 tok
    const model = scanLoadGroups(dir, "ai-coding", 40_000);
    const agents = groupFor(model, "codex");
    expect(agents?.clis).toEqual(expect.arrayContaining(["codex", "opencode", "zed", "kimi"]));
    // antigravity loads AGENTS.md + GEMINI.md → its own group, not the AGENTS-only one.
    expect(agents?.clis).not.toContain("antigravity");
  });

  it("estimates tokens at ceil(bytes/4)", () => {
    put("CLAUDE.md", 400);
    expect(groupFor(scanLoadGroups(dir, "ai-coding", 40_000), "claude")?.tokens).toBe(100);
  });

  it("worst-case is the heaviest PRESENT group, not the sum", () => {
    put("CLAUDE.md", 1600); // 400 tok
    put(".github/copilot-instructions.md", 3600); // 900 tok
    const model = scanLoadGroups(dir, "ai-coding", 40_000);
    // Sum would be 1300; the real per-turn worst is copilot's 900.
    expect(model.worstTokens).toBe(900);
    expect(model.worst?.clis).toContain("copilot");
  });

  it("excludes absent groups from the worst-case", () => {
    put("CLAUDE.md", 400); // only Claude present
    const model = scanLoadGroups(dir, "ai-coding", 40_000);
    expect(model.worst?.clis).toContain("claude");
    expect(groupFor(model, "cursor")?.present).toBe(false);
    expect(groupFor(model, "windsurf")?.present).toBe(false);
  });

  it("gates on the worst tool, not the sum (the whole point)", () => {
    put("CLAUDE.md", 1600); // 400 tok
    put(".github/copilot-instructions.md", 3600); // 900 tok
    put(".windsurfrules", 3200); // 800 tok  → sum 2100, max 900
    // Budget 1000: summing (2100) would falsely fail; max (900) is within budget.
    expect(scanLoadGroups(dir, "ai-coding", 1000).overBudget).toBe(false);
    expect(scanLoadGroups(dir, "ai-coding", 800).overBudget).toBe(true); // 900 > 800
  });

  it("puts the canon tree in the on-demand bucket, never a load group", () => {
    put("CLAUDE.md", 400);
    put("ai-coding/RULE_ROUTER.md", 2000); // 500 tok, loaded via pointer
    const model = scanLoadGroups(dir, "ai-coding", 40_000);
    expect(model.onDemandFiles.map((f) => f.path)).toContain("ai-coding/RULE_ROUTER.md");
    expect(model.onDemandTokens).toBe(500);
    // The on-demand canon is NOT folded into any group's per-turn footprint.
    for (const g of model.groups) {
      expect(g.files.map((f) => f.path)).not.toContain("ai-coding/RULE_ROUTER.md");
    }
  });

  it("is empty-safe: no bootloaders → worst null, 0 tokens, not over budget", () => {
    const model = scanLoadGroups(dir, "ai-coding", 40_000);
    expect(model.worst).toBeNull();
    expect(model.worstTokens).toBe(0);
    expect(model.overBudget).toBe(false);
  });
});
