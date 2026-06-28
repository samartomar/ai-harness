import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/report/index.js";
import {
  configPanel,
  economyPanel,
  localPanels,
  machineToolingPanel,
} from "../../src/report/local.js";

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
  it("counts present REPO-GLOBAL artifacts (per-CLI facts live in the wiring matrix)", () => {
    writeFileSync(join(dir, ".gitleaks.toml"), "title = 'x'\n");
    writeFileSync(join(dir, ".pre-commit-config.yaml"), "repos: []\n");
    const d = configPanel(ctx());
    expect(d.kind).toBe("digest");
    expect(d.describe).toMatch(/Configuration — 2 of \d+ artifacts present/);
    expect(d.text).toContain("✓ gitleaks");
    expect(d.text).toContain("✓ pre-commit");
    expect(d.text).toContain("aih doctor"); // pointer to fail-closed verification
    expect(d.data).toMatchObject({ present: expect.arrayContaining(["gitleaks", "pre-commit"]) });
    // per-CLI artifacts are NOT in the global config panel anymore
    expect(d.text).not.toContain("CLAUDE.md");
  });

  it("reports zero present for an empty repo", () => {
    expect(configPanel(ctx()).describe).toMatch(/Configuration — 0 of/);
  });
});

describe("machineToolingPanel", () => {
  /** A runner that reports the given binaries as resolvable on PATH (which/where). */
  const pathRunner = (...bins: string[]) =>
    fakeRunner((argv) => {
      const name = argv[0] === "which" || argv[0] === "where" ? argv[1] : undefined;
      return name && bins.includes(name) ? { code: 0, stdout: `/usr/bin/${name}` } : undefined;
    });

  it("flags a config dir with NO binary on PATH as config-only (may be stale), not installed", async () => {
    // The real `~/.codeium/windsurf`-leftover case: dir present, binary absent.
    mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
    const d = await machineToolingPanel(ctx());
    expect(d.describe).toMatch(/Machine tooling — 0 runnable · 1 config-only/);
    expect(d.text).toContain("◐ windsurf");
    expect(d.text).toContain("may be stale");
    expect(d.data).toMatchObject({ present: [], configOnly: ["windsurf"] });
  });

  it("counts a tool as runnable only when its binary is on PATH", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const d = await machineToolingPanel(ctx({ run: pathRunner("claude") }));
    expect(d.describe).toMatch(/Machine tooling — 1 runnable/);
    expect(d.text).toContain("✓ claude");
    expect(d.data).toMatchObject({ present: ["claude"] });
  });

  it("reports none for a bare home with nothing on PATH", async () => {
    const d = await machineToolingPanel(ctx());
    expect(d.describe).toMatch(/Machine tooling — 0 runnable of/);
    expect(d.data).toMatchObject({ present: [], configOnly: [], absent: expect.anything() });
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
    expect(describes.some((s) => s.startsWith("AI CLI wiring"))).toBe(true);
    expect(describes.some((s) => s.startsWith("Configuration"))).toBe(true);
    expect(describes.some((s) => s.startsWith("Machine tooling"))).toBe(true);
    expect(describes.some((s) => s.includes("no local data source"))).toBe(true);
  });

  it("localPanels returns the always-on panels; git/usage-gated panels omit off-repo", async () => {
    const panels = await localPanels(ctx());
    // Non-repo, no-usage fixture: velocity (2), AI events, test-ratio, and repo-info all
    // return undefined and are filtered out — leaving the 8 unconditional panels:
    // repo-status, trends, usage, ai-cli-wiring, config, machine-tooling, economy, tools-installed.
    expect(panels).toHaveLength(8);
    const prefixes = panels.map((p) => (p.kind === "digest" ? p.describe : ""));
    expect(prefixes.some((s) => s.startsWith("Tools installed"))).toBe(true);
    expect(prefixes.some((s) => s.startsWith("Repo status"))).toBe(true);
    expect(prefixes.some((s) => s.startsWith("AI CLI wiring"))).toBe(true);
  });
});
