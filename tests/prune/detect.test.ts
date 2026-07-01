import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Cli } from "../../src/internals/clis.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { stalePruneSet } from "../../src/prune/detect.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-prune-"));
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

function marker(...targets: string[]): void {
  writeFileSync(
    join(dir, ".aih-config.json"),
    JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets }),
  );
}

function write(rel: string, content = "x"): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Write the per-CLI adapter note — the on-disk membership signal prune diffs against. */
function adapter(cli: Cli): void {
  write(`ai-coding/adapters/${cli}.md`, `# ${cli} adapter\n`);
}

const paths = (set: ReturnType<typeof stalePruneSet>): string[] => set.artifacts.map((a) => a.path);

describe("stalePruneSet — committed intent only", () => {
  it("reports nothing when there is no marker (never infers deletions)", () => {
    adapter("codex"); // on disk but no committed intent
    const set = stalePruneSet(ctx());
    expect(set.source).toBe("none");
    expect(set.dropped).toEqual([]);
    expect(set.artifacts).toEqual([]);
  });

  it("reports nothing when every on-disk CLI is still targeted", () => {
    marker("claude", "codex");
    adapter("claude");
    adapter("codex");
    const set = stalePruneSet(ctx());
    expect(set.source).toBe("marker");
    expect(set.dropped).toEqual([]);
    expect(set.artifacts).toEqual([]);
  });

  it("resolves committed intent from threaded ctx.targets when there is no marker", () => {
    adapter("claude");
    adapter("codex");
    const set = stalePruneSet(ctx({ targets: ["claude"] }));
    expect(set.source).toBe("ctx");
    expect(set.dropped).toEqual(["codex"]);
  });
});

describe("stalePruneSet — dropped CLI artifacts", () => {
  it("flags the adapter note of a dropped CLI as a clean file removal", () => {
    marker("claude");
    adapter("claude");
    adapter("cursor");
    write(".cursor/rules/00-canon.mdc"); // cursor's exclusive bootloader
    const set = stalePruneSet(ctx());
    expect(set.dropped).toEqual(["cursor"]);
    const adapterArtifact = set.artifacts.find((a) => a.kind === "adapter");
    expect(adapterArtifact).toMatchObject({
      path: "ai-coding/adapters/cursor.md",
      disposition: "file",
      clis: ["cursor"],
    });
    // cursor's bootloader is exclusive to cursor → block-subtract disposition.
    expect(set.artifacts.find((a) => a.kind === "bootloader")).toMatchObject({
      path: ".cursor/rules/00-canon.mdc",
      disposition: "block",
    });
  });

  it("only flags an existing artifact on disk (no phantom paths)", () => {
    marker("claude");
    adapter("claude");
    adapter("cursor"); // adapter exists, but no bootloader file written
    const set = stalePruneSet(ctx());
    expect(paths(set)).toEqual(["ai-coding/adapters/cursor.md"]);
  });
});

describe("stalePruneSet — shared bootloader rule", () => {
  it("keeps a shared bootloader while ANY declaring CLI is still targeted", () => {
    // AGENTS.md is shared by codex, opencode, zed, kimi. Keep codex, drop opencode.
    marker("codex");
    adapter("codex");
    adapter("opencode");
    write("AGENTS.md");
    const set = stalePruneSet(ctx());
    expect(set.dropped).toEqual(["opencode"]);
    // AGENTS.md is still needed by codex → not pruned; only opencode's adapter is.
    expect(paths(set)).toEqual(["ai-coding/adapters/opencode.md"]);
  });

  it("prunes a shared bootloader only when EVERY declaring CLI is dropped", () => {
    marker("claude");
    adapter("claude");
    adapter("codex");
    adapter("opencode");
    write("AGENTS.md");
    const set = stalePruneSet(ctx());
    expect(set.dropped).toEqual(["codex", "opencode"]);
    const boot = set.artifacts.find((a) => a.kind === "bootloader");
    expect(boot?.path).toBe("AGENTS.md");
    // Both dropped CLIs that declare AGENTS.md are listed as owners.
    expect(boot?.clis.sort()).toEqual(["codex", "opencode"]);
  });
});

describe("stalePruneSet — never-prune invariants", () => {
  it("never flags a global ~/home MCP config (codex reads ~/.codex/config.toml)", () => {
    marker("claude");
    adapter("claude");
    adapter("codex");
    write("AGENTS.md");
    const set = stalePruneSet(ctx());
    // codex's only extra artifact beyond its adapter+bootloader is a GLOBAL toml → excluded.
    expect(paths(set).some((p) => p.includes(".codex"))).toBe(false);
  });

  it("flags a repo-scoped MCP config but leaves shared canon untouched", () => {
    marker("codex"); // keep codex (shared AGENTS.md stays)
    adapter("codex");
    adapter("cursor");
    write(".cursor/rules/00-canon.mdc");
    write(".cursor/mcp.json", JSON.stringify({ mcpServers: {} }));
    const set = stalePruneSet(ctx());
    const mcp = set.artifacts.find((a) => a.kind === "mcp");
    expect(mcp).toMatchObject({ path: ".cursor/mcp.json", disposition: "block", clis: ["cursor"] });
    // The shared canonical block source / router are never in the prune set.
    expect(paths(set).some((p) => p.includes("_shared-canonical-block"))).toBe(false);
    expect(paths(set).some((p) => p.includes("RULE_ROUTER"))).toBe(false);
  });

  it("only flags aih-namespaced Kiro hooks, never user/team hooks", () => {
    marker("claude");
    adapter("claude");
    adapter("kiro");
    write(".kiro/steering/00-canon.md"); // kiro's exclusive bootloader
    write(".kiro/steering/agent-tools.md"); // aih-generated steering extra
    write(".kiro/hooks/aih-tests-on-edit.kiro.hook"); // aih-owned
    write(".kiro/hooks/team-custom.kiro.hook"); // NOT aih-owned
    const p = paths(stalePruneSet(ctx()));
    expect(p).toContain(".kiro/hooks/aih-tests-on-edit.kiro.hook");
    expect(p).toContain(".kiro/steering/agent-tools.md");
    expect(p).not.toContain(".kiro/hooks/team-custom.kiro.hook");
  });
});
