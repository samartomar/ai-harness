import { describe, expect, it } from "vitest";
import {
  bootloadersFor,
  CLI_REGISTRY,
  entry,
  REGISTRY_IDS,
} from "../../src/internals/cli-registry.js";
import { SUPPORTED_CLIS } from "../../src/internals/clis.js";

describe("CLI registry", () => {
  it("parses (a malformed future edit fails the suite, not production)", () => {
    // The z.record(...).parse(RAW) at module load throws on bad data; reaching here = valid.
    expect(Object.keys(CLI_REGISTRY).length).toBe(SUPPORTED_CLIS.length);
  });

  it("stays in lockstep with SUPPORTED_CLIS (same ids, same canonical order)", () => {
    // The single source of truth: detection, reports, and the --detect fallback all
    // depend on this order, so drift between the two lists must fail loudly.
    expect(REGISTRY_IDS).toEqual([...SUPPORTED_CLIS]);
    for (const cli of SUPPORTED_CLIS) expect(entry(cli).id).toBe(cli);
  });

  it("carries the lifted per-CLI MCP facts (Codex = config.toml / mcp_servers / toml)", () => {
    expect(entry("codex").mcp).toMatchObject({
      support: "native",
      configFormat: "toml",
      configKey: "mcp_servers",
      writable: false, // TOML / global → guidance, not a write
    });
    expect(entry("claude").mcp).toMatchObject({
      configPath: ".mcp.json",
      configKey: "mcpServers",
      configFormat: "json",
      writable: true,
    });
    // Cursor uses the same shape at a different project path → writable.
    expect(entry("cursor").mcp).toMatchObject({ configPath: ".cursor/mcp.json", writable: true });
  });

  it("preserves the detection signals migrated from cli-detect SIGNALS", () => {
    expect(entry("claude").configDirs).toEqual([".claude"]);
    expect(entry("claude").binaries).toEqual(["claude"]);
    expect(entry("antigravity").configDirs).toContain(".antigravity");
    expect(entry("windsurf").configDirs).toContain(".codeium/windsurf");
  });

  it("bootloadersFor dedupes the AGENTS.md convention (codex/opencode/zed/kimi)", () => {
    expect(bootloadersFor(["codex", "opencode", "zed", "kimi"])).toEqual(["AGENTS.md"]);
    expect(bootloadersFor(["antigravity"])).toEqual(["AGENTS.md", "GEMINI.md"]);
    expect(bootloadersFor(["claude"])).toEqual(["CLAUDE.md"]);
  });

  it("throws on an unknown CLI id", () => {
    expect(() => entry("nope")).toThrow();
  });
});
