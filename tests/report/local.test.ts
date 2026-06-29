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
import { mcpGovernanceDigest } from "../../src/report/mcp-governance.js";
import { leakPreventionsDigest } from "../../src/report/security.js";
import { toolsInstalledDigest } from "../../src/report/tools.js";
import { usagePanel } from "../../src/report/usage.js";
import { scaleSafetyDigest } from "../../src/scale-safety.js";

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
    expect(d.describe).toMatch(/Configuration — 2 of \d+ config files present/);
    expect(d.text).toContain("✓ gitleaks");
    expect(d.text).toContain("✓ pre-commit");
    // The FILE is shown so "gitleaks" can't be mistaken for the gitleaks binary.
    expect(d.text).toContain(".gitleaks.toml");
    expect(d.text).toContain("whether a tool is installed");
    expect(d.text).toContain("aih doctor"); // pointer to fail-closed verification
    expect(d.data).toMatchObject({
      present: expect.arrayContaining(["gitleaks", "pre-commit"]),
      files: expect.objectContaining({ gitleaks: ".gitleaks.toml" }),
    });
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

describe("usagePanel", () => {
  it("distinguishes capture installed from no events captured yet", () => {
    mkdirSync(join(dir, ".aih"), { recursive: true });
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".aih", "usage-record.mjs"), "x\n");
    writeFileSync(join(dir, ".git", "hooks", "post-commit"), "node .aih/usage-record.mjs\n");
    const d = usagePanel(ctx());
    expect(d.describe).toContain("capture installed");
    expect(d.text).toContain("waiting for the first real event");
    expect(d.data).toMatchObject({ events: 0, installed: true });
  });
});

describe("leakPreventionsDigest", () => {
  it("counts scan-derived secret findings without exposing secret values", () => {
    writeFileSync(join(dir, ".env"), "API_KEY=sk-should-never-render\n");
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { gh: { env: { GITHUB_TOKEN: `ghp_${"a".repeat(36)}` } } },
      }),
    );

    const d = leakPreventionsDigest(ctx());
    if (d === undefined) throw new Error("expected leak-preventions digest");

    expect(d.describe).toContain("2 finding");
    expect(d.text).toContain(".env");
    expect(d.text).toContain(".mcp.json");
    expect(d.text).not.toContain("sk-should-never-render");
    expect(d.text).not.toContain(`ghp_${"a".repeat(36)}`);
    expect(d.data).toMatchObject({
      total: 2,
      plaintext: 1,
      mcpHardcoded: 1,
      codes: ["secrets.plaintext-detected", "mcp.hardcoded-secret"],
    });
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
    // return undefined and are filtered out — leaving the 9 unconditional panels:
    // repo-status, trends, usage, ai-cli-wiring, mcp-governance, config, machine-tooling,
    // economy, tools-installed.
    expect(panels).toHaveLength(9);
    const prefixes = panels.map((p) => (p.kind === "digest" ? p.describe : ""));
    expect(prefixes.some((s) => s.startsWith("Tools installed"))).toBe(true);
    expect(prefixes.some((s) => s.startsWith("Repo status"))).toBe(true);
    expect(prefixes.some((s) => s.startsWith("AI CLI wiring"))).toBe(true);
    expect(prefixes.some((s) => s.startsWith("MCP governance"))).toBe(true);
  });

  it("mcpGovernanceDigest denies context7 (third-party egress) under the enterprise posture", () => {
    const d = mcpGovernanceDigest(ctx());
    expect(d.describe).toContain("MCP governance");
    const data = d.data as { denied: { name: string }[]; allowed: string[] };
    expect(data.denied.map((x) => x.name)).toContain("context7");
    // The secret-free defaults are enterprise-clean: GitHub (vendor-incumbent + OAuth)
    // and the local servers pass.
    expect(data.allowed).toContain("github");
    expect(data.allowed).toContain("code-review-graph");
  });
});

describe("toolsInstalledDigest — core vs optional", () => {
  const pathRunner = (...bins: string[]) =>
    fakeRunner((argv) => {
      const name = argv[0] === "which" || argv[0] === "where" ? argv[1] : undefined;
      return name && bins.includes(name) ? { code: 0, stdout: `/usr/bin/${name}` } : undefined;
    });

  it("counts CORE on PATH and marks missing OPTIONAL as fine, not a shortfall", async () => {
    // rg/fd/jq present (core), sg/comby absent (optional) — the real personal-PC case.
    const d = await toolsInstalledDigest(ctx({ run: pathRunner("rg", "fd", "jq") }));
    expect(d.describe).toMatch(/Tools installed — 3\/3 core/);
    expect(d.text).toContain("· sg  (optional)");
    expect(d.text).toContain("· comby  (optional)");
    expect(d.data).toMatchObject({ coreMissing: [] });
  });

  it("flags a MISSING core tool as a real gap (✗)", async () => {
    const d = await toolsInstalledDigest(ctx({ run: pathRunner("rg", "jq") })); // fd missing
    expect(d.describe).toMatch(/Tools installed — 2\/3 core/);
    expect(d.text).toContain("✗ fd");
    expect(d.data).toMatchObject({ coreMissing: ["fd"] });
  });
});

describe("scaleSafetyDigest", () => {
  const largeRepoRunner = (...bins: string[]) =>
    fakeRunner((argv) => {
      if (argv[0] === "git" && argv.slice(3).join(" ") === "ls-files") {
        return {
          code: 0,
          stdout: Array.from({ length: 1000 }, (_, i) => `src/file-${i}.ts`).join("\n"),
        };
      }
      const name = argv[0] === "which" || argv[0] === "where" ? argv[1] : undefined;
      return name && bins.includes(name) ? { code: 0, stdout: `/usr/bin/${name}` } : undefined;
    });

  it("emits a large-repo risk panel when code-review-graph is unavailable", async () => {
    const d = await scaleSafetyDigest(ctx({ run: largeRepoRunner() }));
    expect(d?.describe).toContain("graph missing");
    expect(d?.text).toContain("burning the context budget");
    expect(d?.data).toMatchObject({ ok: false, code: "scale.code-review-graph-missing" });
  });

  it("emits a positive large-repo panel when repo MCP graph plus uv is available", async () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "code-review-graph": { command: "uvx" } } }),
    );
    const d = await scaleSafetyDigest(ctx({ run: largeRepoRunner("uv") }));
    expect(d?.describe).toContain("graph available");
    expect(d?.data).toMatchObject({ ok: true });
  });
});
