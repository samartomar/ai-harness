import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { POINTER_SENTENCE } from "../../src/scaffold/adapters.js";
import { command } from "../../src/scaffold/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-scaffold-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: ".ai-context",
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

/** All write actions, keyed by their (root-relative) path. */
function writesByPath(actions: Action[]): Map<string, WriteAction> {
  const m = new Map<string, WriteAction>();
  for (const a of actions) {
    if (a.kind === "write") m.set(a.path.replace(/\\/g, "/"), a);
  }
  return m;
}

/** The four plain pointer adapters (filename → root-relative path). */
const THIN_ADAPTERS = [
  "CLAUDE.md",
  "AGENTS.md",
  ".windsurfrules",
  ".github/copilot-instructions.md",
  ".cursor/rules/00-index.mdc",
];

describe("scaffold command surface", () => {
  it("keeps the scaffold name and an empty option set", () => {
    expect(command.name).toBe("scaffold");
    expect(command.options).toEqual([]);
  });
});

describe("scaffold plan (dry-run shape)", () => {
  it("plans only local writes plus one doc — no exec, no probe, no remote action", async () => {
    const p = await command.plan(ctx());
    const kinds = p.actions.map((a) => a.kind);
    expect(kinds).toContain("write");
    expect(kinds).toContain("doc");
    expect(kinds).not.toContain("exec");
    expect(kinds).not.toContain("probe");
    // Exactly one doc action: the opt-in hooks wiring (guidance, not executed).
    expect(kinds.filter((k) => k === "doc")).toHaveLength(1);
  });

  it("writes the canonical context dir: INDEX, three skeletons, example skill", async () => {
    const w = writesByPath((await command.plan(ctx())).actions);
    expect(w.has(".ai-context/INDEX.md")).toBe(true);
    expect(w.has(".ai-context/architecture.md")).toBe(true);
    expect(w.has(".ai-context/conventions.md")).toBe(true);
    expect(w.has(".ai-context/tasks.md")).toBe(true);
    expect(w.has(".ai-context/skills/example-skill/SKILL.md")).toBe(true);
  });

  it("emits every thin IDE adapter", async () => {
    const w = writesByPath((await command.plan(ctx())).actions);
    for (const path of THIN_ADAPTERS) {
      expect(w.has(path)).toBe(true);
    }
  });
});

describe("thin adapters (pointer contract)", () => {
  it("each adapter is < 30 lines, opens the pointer sentence, and routes to contextDir", async () => {
    const w = writesByPath((await command.plan(ctx())).actions);
    for (const path of THIN_ADAPTERS) {
      const contents = w.get(path)?.contents ?? "";
      const lineCount = contents.replace(/\n$/, "").split("\n").length;
      expect(lineCount, `${path} should be < 30 lines`).toBeLessThan(30);
      expect(contents, `${path} must contain the pointer sentence`).toContain(POINTER_SENTENCE);
      expect(contents, `${path} must reference the context dir`).toContain(".ai-context");
    }
  });

  it("the cursor adapter carries MDC frontmatter with alwaysApply + glob", async () => {
    const w = writesByPath((await command.plan(ctx())).actions);
    const mdc = w.get(".cursor/rules/00-index.mdc")?.contents ?? "";
    expect(mdc.startsWith("---\n")).toBe(true);
    expect(mdc).toContain("alwaysApply: true");
    expect(mdc).toContain('globs: ["**/*"]');
    expect(mdc).toContain("description:");
  });
});

describe("custom context dir override", () => {
  it("lands context files under ai-coding and points adapters there", async () => {
    const p = await command.plan(ctx({ contextDir: "ai-coding" }));
    const w = writesByPath(p.actions);
    // Context files moved.
    expect(w.has("ai-coding/INDEX.md")).toBe(true);
    expect(w.has("ai-coding/skills/example-skill/SKILL.md")).toBe(true);
    expect(w.has(".ai-context/INDEX.md")).toBe(false);
    // Adapters now reference the custom dir, not the default.
    for (const path of THIN_ADAPTERS) {
      const contents = w.get(path)?.contents ?? "";
      expect(contents, `${path} should reference ai-coding`).toContain("ai-coding");
      expect(contents).not.toContain(".ai-context");
    }
  });

  it("the context skeleton docs themselves reference the override, never the default", async () => {
    const w = writesByPath((await command.plan(ctx({ contextDir: "ai-coding" }))).actions);
    // INDEX + skeletons interpolate contextDir in their own bodies; a hardcoded
    // ".ai-context" here would pass the adapter-only assertions above.
    for (const file of ["INDEX.md", "architecture.md", "conventions.md", "tasks.md"]) {
      const contents = w.get(`ai-coding/${file}`)?.contents ?? "";
      expect(contents, `${file} should reference ai-coding`).toContain("ai-coding");
      expect(contents, `${file} must not leak the default dir`).not.toContain(".ai-context");
    }
  });
});

describe("INDEX routing content", () => {
  it("lists each context file with a when-to-load hint (progressive disclosure)", async () => {
    const w = writesByPath((await command.plan(ctx())).actions);
    const index = w.get(".ai-context/INDEX.md")?.contents ?? "";
    expect(index).toContain("architecture.md");
    expect(index).toContain("conventions.md");
    expect(index).toContain("tasks.md");
    expect(index).toContain("skills/");
    expect(index.toLowerCase()).toContain("load");
  });
});

describe("example skill (INDEX/SKILL pattern)", () => {
  it("opens with name/description frontmatter and has numbered steps", async () => {
    const w = writesByPath((await command.plan(ctx())).actions);
    const skill = w.get(".ai-context/skills/example-skill/SKILL.md")?.contents ?? "";
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toContain("name: example-skill");
    expect(skill).toContain("description:");
    expect(skill).toMatch(/^1\. /m);
    expect(skill).toMatch(/^2\. /m);
  });
});

describe("local guardrails", () => {
  it("merges .claude/settings.json deny rules without clobbering user keys", async () => {
    const w = writesByPath((await command.plan(ctx())).actions);
    const settings = w.get(".claude/settings.json");
    expect(settings?.merge).toBe(true);
    expect(settings?.json).toEqual({
      permissions: { deny: ["Read(./.env*)", "Read(./secrets/**)"] },
    });
  });

  it("writes an executable pre-commit hook and DOCS the wiring (never execs it)", async () => {
    const p = await command.plan(ctx());
    const w = writesByPath(p.actions);
    const hook = w.get(".githooks/pre-commit");
    expect(hook?.mode).toBe(0o755);
    expect(hook?.contents).toContain("#!/bin/sh");
    expect(hook?.contents?.toLowerCase()).toContain("lint");
    expect(hook?.contents?.toLowerCase()).toContain("test");

    const docs = p.actions.filter((a) => a.kind === "doc");
    expect(docs).toHaveLength(1);
    expect(docs[0]?.kind === "doc" && docs[0].text).toContain(
      "git config core.hooksPath .githooks",
    );
  });
});

describe("apply (executor integration)", () => {
  it("materializes context dir, adapters, settings, and hook on disk", async () => {
    const applied = ctx({ apply: true });
    const built = await command.plan(applied);
    const res = await executePlan(built, applied);

    const written = res.writes.map((x) => x.path.replace(/\\/g, "/"));
    expect(written).toContain(".ai-context/INDEX.md");
    expect(written).toContain("CLAUDE.md");
    expect(written).toContain(".claude/settings.json");
    expect(written).toContain(".githooks/pre-commit");

    const index = readFileSync(join(dir, ".ai-context/INDEX.md"), "utf8");
    expect(index.endsWith("\n")).toBe(true);
    const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    expect(settings.permissions.deny).toContain("Read(./secrets/**)");
  });

  it("is idempotent: merge preserves a user key and dedupes an overlapping deny rule", async () => {
    // Seed a user-authored settings.json with an unrelated key + one overlapping deny rule.
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude/settings.json"),
      JSON.stringify({ permissions: { deny: ["Read(./.env*)"] }, telemetry: false }, null, 2),
    );

    // Apply twice; the deny union must stay deduped and the user key must survive.
    const a1 = ctx({ apply: true });
    await executePlan(await command.plan(a1), a1);
    const a2 = ctx({ apply: true });
    await executePlan(await command.plan(a2), a2);

    const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    expect(settings.permissions.deny).toEqual(["Read(./.env*)", "Read(./secrets/**)"]);
    expect(settings.telemetry).toBe(false);
  });
});
