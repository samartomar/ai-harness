import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/report/index.js";
import { configPanel, economyPanel, localPanels, toolingPanel } from "../../src/report/local.js";

let dir: string; // repo root
let home: string; // fake home for CLI config-dir detection
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-report-local-"));
  home = mkdtempSync(join(tmpdir(), "aih-report-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
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
    env: { HOME: home, USERPROFILE: home },
    options: {},
    ...over,
  };
}

describe("configPanel", () => {
  it("counts present artifacts and lists them via the shared status inventory", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "x");
    writeFileSync(join(dir, ".mcp.json"), "{}");
    const d = configPanel(ctx());
    expect(d.kind).toBe("digest");
    expect(d.describe).toMatch(/Configuration — 2 of \d+ artifacts present/);
    expect(d.text).toContain("✓ CLAUDE.md");
    expect(d.text).toContain("✓ mcp");
    expect(d.text).toContain("aih doctor"); // pointer to fail-closed verification
    expect(d.data).toMatchObject({ present: expect.arrayContaining(["CLAUDE.md", "mcp"]) });
  });

  it("reports zero present for an empty repo", () => {
    expect(configPanel(ctx()).describe).toMatch(/Configuration — 0 of/);
  });
});

describe("toolingPanel", () => {
  it("detects an AI CLI by its home config dir", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const d = toolingPanel(ctx());
    expect(d.describe).toMatch(/Tooling — 1 of \d+ AI CLIs configured here/);
    expect(d.text).toContain("✓ claude");
    expect(d.data).toMatchObject({ present: ["claude"] });
  });

  it("reports none configured for a bare home (hermetic — no PATH probe)", () => {
    const d = toolingPanel(ctx());
    expect(d.describe).toMatch(/Tooling — 0 of/);
    expect(d.data).toMatchObject({ present: [] });
  });
});

describe("economyPanel", () => {
  it("is an explicit no-data stub that points at the org digest", () => {
    const d = economyPanel();
    expect(d.describe).toContain("no local data source yet");
    expect(d.text).toContain("aih report --org");
    expect(d.data).toEqual({ available: false });
  });
});

describe("report local scope — composed panels", () => {
  it("emits context footprint first, then configuration, tooling, and economy", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(40));
    const actions = (await command.plan(ctx())).actions;
    expect(actions.every((a) => a.kind === "digest")).toBe(true);
    const describes = actions.map((a) => (a.kind === "digest" ? a.describe : ""));
    expect(describes[0]).toContain("Context footprint");
    expect(describes.some((s) => s.startsWith("Configuration"))).toBe(true);
    expect(describes.some((s) => s.startsWith("Tooling"))).toBe(true);
    expect(describes.some((s) => s.includes("no local data source"))).toBe(true);
  });

  it("localPanels returns the five local panels (repo, trends, config, tooling, economy)", async () => {
    expect(await localPanels(ctx())).toHaveLength(5);
  });
});
