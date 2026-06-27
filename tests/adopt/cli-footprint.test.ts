import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliFootprint } from "../../src/adopt/cli-footprint.js";

const DIR = "ai-coding";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-adopt-fp-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function put(rel: string, contents: string): void {
  const full = join(tmp, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function find(rel: string, root = tmp) {
  return cliFootprint(root, DIR).artifacts.find((a) => a.path === rel);
}

describe("cliFootprint", () => {
  it("empty repo → no artifacts, no import candidates", () => {
    const fp = cliFootprint(tmp, DIR);
    expect(fp.artifacts).toHaveLength(0);
    expect(fp.importCandidates).toBe(0);
  });

  it("classifies a canon-referencing .cursorrules as a pointer (leave alone)", () => {
    // The real ai-os-product/.cursorrules shape: a thin pointer to the canon.
    put(
      ".cursorrules",
      "# Cursor bootloader\n\nActive rules live under `ai-coding/`. Read `ai-coding/RULE_ROUTER.md`.\n",
    );
    const a = find(".cursorrules");
    expect(a?.kind).toBe("pointer");
    expect(cliFootprint(tmp, DIR).importCandidates).toBe(0);
  });

  it("classifies a content-only .cursorrules as tool-owned-content (import candidate)", () => {
    put(".cursorrules", "# My cursor rules\n\n- Always use tabs.\n- Prefer composition.\n");
    const a = find(".cursorrules");
    expect(a?.kind).toBe("tool-owned-content");
    expect(cliFootprint(tmp, DIR).importCandidates).toBe(1);
  });

  it("counts a tool-owned agents dir (syntegris/.claude/agents shape)", () => {
    put(".claude/agents/security-audit.md", "# security audit agent\n");
    put(".claude/agents/sr-code-review.md", "# code review agent\n");
    const a = find(".claude/agents");
    expect(a?.kind).toBe("tool-owned-content");
    expect(a?.detail).toContain("2 agents");
  });

  it("a rule DIR is a pointer only if EVERY file references the canon", () => {
    // syntegris/.claude/rules: bridge files point to canon, but one is real content.
    put(".claude/rules/00-index.md", "Read `ai-coding/RULE_ROUTER.md` — this is a bridge.\n");
    put(".claude/rules/bridge.md", "Canonical rules live under `ai-coding/`.\n");
    let a = find(".claude/rules");
    expect(a?.kind).toBe("pointer");

    put(".claude/rules/ux-design.md", "# UX system\n\n- 8px grid.\n"); // real content, no canon ref
    a = find(".claude/rules");
    expect(a?.kind).toBe("tool-owned-content");
    expect(a?.detail).toMatch(/importable/);
  });

  it("flags settings/launch as runtime-config (not an import candidate)", () => {
    put(".claude/settings.json", "{}\n");
    put(".claude/launch.json", "{}\n");
    const fp = cliFootprint(tmp, DIR);
    expect(find(".claude/settings.json")?.kind).toBe("runtime-config");
    expect(find(".claude/launch.json")?.kind).toBe("runtime-config");
    expect(fp.importCandidates).toBe(0);
  });

  it("does NOT report empty tool dirs", () => {
    mkdirSync(join(tmp, ".claude", "agents"), { recursive: true });
    expect(find(".claude/agents")).toBeUndefined();
  });

  it("inventories Kiro steering (rules) vs hooks (runtime) distinctly", () => {
    put(".kiro/steering/product.md", "# product steering\n\n- ship weekly\n");
    put(".kiro/hooks/test.kiro.hook", "{}\n");
    expect(find(".kiro/steering")?.kind).toBe("tool-owned-content");
    expect(find(".kiro/hooks")?.kind).toBe("runtime-config");
  });
});
