import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedBlock } from "../../src/bootstrap-ai/canon.js";
import { mergeManagedBlock } from "../../src/internals/markers.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  type CliCoverageModel,
  cliCoverageDigest,
  scanCliCoverage,
} from "../../src/report/cli-coverage.js";

let dir: string; // repo root
let home: string; // fake home for CLI installed-detection
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-cov-"));
  home = mkdtempSync(join(tmpdir(), "aih-cov-home-"));
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

/** Write a repo `.aih-config.json` marker selecting `targets`. */
function marker(...targets: string[]): void {
  writeFileSync(
    join(dir, ".aih-config.json"),
    JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets }),
  );
}

/** Write a bootloader file carrying the in-sync shared canonical block. */
function writeWiredBootloader(rel: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, mergeManagedBlock(undefined, sharedBlock("ai-coding"), "# preamble"));
}

/** Write a file into the fake home (for external/global tool MCP configs). */
function writeHomeFile(rel: string, content: string): void {
  const path = join(home, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Scaffold the canon the loadability router-chain check resolves to. */
function scaffoldCanon(): void {
  mkdirSync(join(dir, "ai-coding", "rules"), { recursive: true });
  writeFileSync(join(dir, "ai-coding", "RULE_ROUTER.md"), "# router\n");
  writeFileSync(join(dir, "ai-coding", "rules", "agent-behavior-core.md"), "# core\n");
}

/** Write a populated MCP JSON for a writable tool's config path. */
function writeMcp(rel: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers: { x: { command: "y" } } }));
}

function row(model: CliCoverageModel, cli: string) {
  const r = model.rows.find((x) => x.cli === cli);
  if (!r) throw new Error(`no row for ${cli}`);
  return r;
}

describe("target scoping", () => {
  it("reads the committed marker and reports its source", () => {
    marker("kiro");
    const m = scanCliCoverage(ctx());
    expect(m.targetSource).toBe("marker");
    expect(m.targeted).toEqual(["kiro"]);
  });

  it("defaults to claude (source default-claude) when no marker/flags", () => {
    const m = scanCliCoverage(ctx());
    expect(m.targetSource).toBe("default-claude");
    expect(m.targeted).toEqual(["claude"]);
  });

  it("infers wired CLIs from on-disk adapters when no marker (source 'wired')", () => {
    // No marker/flags, but the repo carries per-CLI adapter notes — what
    // `aih bootstrap-ai` writes for every targeted CLI under the improved default.
    // The scan grades those CLIs instead of collapsing to the claude default; the
    // non-CLI adapters (_shared-canonical-block, other-tools) are ignored.
    mkdirSync(join(dir, "ai-coding", "adapters"), { recursive: true });
    for (const f of ["claude", "codex", "gemini", "_shared-canonical-block", "other-tools"]) {
      writeFileSync(join(dir, "ai-coding", "adapters", `${f}.md`), "# adapter\n");
    }
    const m = scanCliCoverage(ctx());
    expect(m.targetSource).toBe("wired");
    expect(m.targeted).toEqual(["claude", "codex", "gemini"]);
  });
});

describe("bootloader cell", () => {
  it("false-negative fixed: a Windsurf-only repo wired for windsurf scores 100", () => {
    marker("windsurf");
    writeWiredBootloader(".windsurfrules");
    // windsurf MCP is a global (~/home) native write now — wire it in the fake home.
    writeHomeFile(
      ".codeium/windsurf/mcp_config.json",
      JSON.stringify({ mcpServers: { x: { command: "y" } } }),
    );
    const m = scanCliCoverage(ctx());
    const r = row(m, "windsurf");
    expect(r.bootloader.state).toBe("wired");
    expect(r.mcp.state).toBe("wired");
    expect(r.mcp.detail).toMatch(/global/);
    expect(r.settings.state).toBe("na");
    expect(m.score).toBe(100);
    expect(m.structurallyConfigured).toBe(1);
  });

  it("false-positive fixed: a stray CLAUDE.md doesn't help a kiro-targeted repo", () => {
    marker("kiro");
    writeWiredBootloader("CLAUDE.md");
    const m = scanCliCoverage(ctx());
    // claude is neither targeted nor installed → no claude row at all
    expect(m.rows.some((r) => r.cli === "claude")).toBe(false);
    expect(row(m, "kiro").bootloader.state).toBe("missing");
    expect(m.score).toBe(0);
    expect(m.structurallyConfigured).toBe(0);
  });

  it("flags a present-but-drifted bootloader as missing, not silently wired", () => {
    marker("claude");
    writeFileSync(join(dir, "CLAUDE.md"), "# hand-written, no managed block, RULE_ROUTER.md");
    const r = row(scanCliCoverage(ctx()), "claude");
    expect(r.bootloader.state).toBe("missing");
    expect(r.bootloader.detail).toMatch(/drift/);
  });
});

describe("mcp cell — content check + manual model", () => {
  it("writable: an empty {} is missing; a populated map is wired", () => {
    marker("claude");
    writeFileSync(join(dir, ".mcp.json"), "{}");
    expect(row(scanCliCoverage(ctx()), "claude").mcp.state).toBe("missing");
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { x: { command: "y" } } }));
    expect(row(scanCliCoverage(ctx()), "claude").mcp.state).toBe("wired");
  });

  it("native global TOML tool (codex): missing without config, wired once the TOML has servers", () => {
    marker("codex");
    let r = row(scanCliCoverage(ctx()), "codex");
    expect(r.mcp.state).toBe("missing");
    expect(r.mcp.detail).toMatch(/global/);
    // Codex's config is TOML — server presence is counted from `[mcp_servers.*]` tables.
    writeHomeFile(".codex/config.toml", '[mcp_servers."code-review-graph"]\ncommand = "uvx"\n');
    r = row(scanCliCoverage(ctx()), "codex");
    expect(r.mcp.state).toBe("wired");
    expect(r.mcp.detail).toMatch(/mcp_servers/);
  });

  it("native repo-relative tool (copilot): {} is missing, a populated `servers` map is wired", () => {
    marker("copilot");
    mkdirSync(join(dir, ".vscode"), { recursive: true });
    writeFileSync(join(dir, ".vscode", "mcp.json"), "{}");
    let r = row(scanCliCoverage(ctx()), "copilot");
    expect(r.mcp.state).toBe("missing");
    writeFileSync(
      join(dir, ".vscode", "mcp.json"),
      JSON.stringify({ servers: { x: { type: "stdio", command: "y" } } }),
    );
    r = row(scanCliCoverage(ctx()), "copilot");
    expect(r.mcp.state).toBe("wired");
  });
});

describe("settings cell", () => {
  it("is n/a for tools without a settings profile, gradeable for claude", () => {
    marker("claude", "kiro");
    expect(row(scanCliCoverage(ctx()), "kiro").settings.state).toBe("na");
    expect(row(scanCliCoverage(ctx()), "claude").settings.state).toBe("missing");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{}");
    expect(row(scanCliCoverage(ctx()), "claude").settings.state).toBe("wired");
  });
});

describe("installed-but-untargeted rows", () => {
  it("shows a muted, ungraded row for a CLI installed but not targeted", () => {
    marker("claude");
    mkdirSync(join(home, ".cursor"), { recursive: true }); // installed, not targeted
    const m = scanCliCoverage(ctx());
    expect(m.rows.find((r) => r.cli === "cursor")?.targeted).toBe(false);
    expect(m.totalTargeted).toBe(1);
  });
});

describe("loadability in the coverage model (Phase 1.5)", () => {
  it("present-but-won't-load: cells all green, but the Cursor .mdc lost its activation", () => {
    marker("cursor");
    scaffoldCanon();
    // wired shared block (no frontmatter) → bootloader wired, but no alwaysApply
    writeWiredBootloader(".cursor/rules/00-canon.mdc");
    writeMcp(".cursor/mcp.json");
    const m = scanCliCoverage(ctx());
    const r = row(m, "cursor");
    expect(r.bootloader.state).toBe("wired"); // file present + in sync
    expect(r.mcp.state).toBe("wired");
    expect(r.load.verdict).toBe("wontLoad"); // ...yet it won't auto-load
    expect(m.structurallyConfigured).toBe(1); // no missing cell
    expect(m.provenLoadable).toBe(0); // but not proven loadable — the silent gap
  });

  it("a fully wired + activated tool is both configured and proven loadable", () => {
    marker("claude");
    scaffoldCanon();
    writeWiredBootloader("CLAUDE.md"); // CLAUDE.md is inherently always-on
    writeMcp(".mcp.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{}");
    const m = scanCliCoverage(ctx());
    expect(row(m, "claude").load.verdict).toBe("loads");
    expect(m.structurallyConfigured).toBe(1);
    expect(m.provenLoadable).toBe(1);
  });
});

describe("cliCoverageDigest", () => {
  it("uses the stable 'AI CLI wiring' describe prefix and echoes the model", () => {
    marker("claude");
    const d = cliCoverageDigest(ctx());
    expect(d.kind).toBe("digest");
    expect(d.describe.startsWith("AI CLI wiring")).toBe(true);
    expect(d.text).toContain("Target source: .aih-config.json");
    expect((d.data as { targeted: string[] }).targeted).toEqual(["claude"]);
  });
});
