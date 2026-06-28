import { describe, expect, it } from "vitest";
import {
  bootloadersFor,
  CLI_REGISTRY,
  entry,
  REGISTRY_IDS,
  SUPPORT_LEVELS,
} from "../../src/internals/cli-registry.js";
import { SUPPORTED_CLIS } from "../../src/internals/clis.js";

describe("CLI registry", () => {
  it("parses (a malformed future edit fails the suite, not production)", () => {
    // The z.record(...).parse(RAW) at module load throws on bad data; reaching here = valid.
    expect(Object.keys(CLI_REGISTRY).length).toBe(SUPPORTED_CLIS.length);
  });

  it("exposes the documented support vocabulary, including fallback", () => {
    expect(SUPPORT_LEVELS).toEqual(["native", "fallback", "absent"]);
  });

  it("stays in lockstep with SUPPORTED_CLIS (same ids, same canonical order)", () => {
    // The single source of truth: detection, reports, and the --detect fallback all
    // depend on this order, so drift between the two lists must fail loudly.
    expect(REGISTRY_IDS).toEqual([...SUPPORTED_CLIS]);
    for (const cli of SUPPORTED_CLIS) expect(entry(cli).id).toBe(cli);
  });

  it("carries the lifted per-CLI MCP facts (Codex = config.toml / mcp_servers / toml)", () => {
    expect(entry("codex").mcp).toMatchObject({
      support: "native", // aih now renders the TOML and writes it as a managed block
      configFormat: "toml",
      configKey: "mcp_servers",
    });
    expect(entry("claude").mcp).toMatchObject({
      support: "native",
      configPath: ".mcp.json",
      configKey: "mcpServers",
      configFormat: "json",
    });
    // Cursor uses the same shape at a different project path → still a native write.
    expect(entry("cursor").mcp).toMatchObject({
      support: "native",
      configPath: ".cursor/mcp.json",
    });
  });

  it("classifies MCP integration as native (aih writes) vs fallback (aih guides)", () => {
    const writes = SUPPORTED_CLIS.filter((c) => entry(c).mcp.support === "native");
    const guides = SUPPORTED_CLIS.filter((c) => entry(c).mcp.support === "fallback");
    // aih now renders every tool's shape (mcp/render.ts) — JSON or TOML, repo or
    // ~/home — so every MCP-capable CLI is a native write; none fall back to guidance.
    expect(writes).toEqual([...SUPPORTED_CLIS]);
    expect(guides).toEqual([]);
    // No tool is `absent` today; every supported CLI exposes some MCP config.
    expect(SUPPORTED_CLIS.every((c) => entry(c).mcp.support !== "absent")).toBe(true);
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
