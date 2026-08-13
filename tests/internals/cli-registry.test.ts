import { describe, expect, it } from "vitest";
import {
  bootloadersFor,
  CLI_REGISTRY,
  entry,
  loadedDirsFor,
  REGISTRY_IDS,
  SUPPORT_LEVELS,
} from "../../src/internals/cli-registry.js";
import { SUPPORTED_CLIS } from "../../src/internals/clis.js";

describe("CLI registry", () => {
  it("parses (a malformed future edit fails the suite, not production)", () => {
    // The z.record(...).parse(RAW) at module load throws on bad data; reaching here = valid.
    expect(Object.keys(CLI_REGISTRY).length).toBe(SUPPORTED_CLIS.length);
  });

  it("keeps reviewed runtime TLS origins in the CLI registry", () => {
    const origins = entry("kiro").tlsOrigins ?? [];
    expect(origins.length).toBeGreaterThan(0);
    for (const origin of origins) {
      const url = new URL(origin);
      expect(url.protocol).toBe("https:");
      expect(url.username).toBe("");
      expect(url.password).toBe("");
      expect(url.pathname).toBe("/");
    }
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

  it("keeps the Kiro runtime contract exact for case-sensitive filesystems", () => {
    expect(entry("kiro")).toMatchObject({
      binaries: ["kiro-cli"],
      configDirs: [".kiro"],
      loadsDirectory: ".kiro/steering",
      mcp: {
        support: "native",
        configPath: ".kiro/settings/mcp.json",
        configKey: "mcpServers",
        configFormat: "json",
      },
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
    // `kiro` can be an optional IDE/CLI command router; `kiro-cli` is the
    // documented executable that unambiguously proves the CLI is installed.
    expect(entry("kiro").binaries).toEqual(["kiro-cli"]);
  });

  it("bootloadersFor dedupes the AGENTS.md convention (codex/opencode/zed/kimi)", () => {
    expect(bootloadersFor(["codex", "opencode", "zed", "kimi"])).toEqual(["AGENTS.md"]);
    expect(bootloadersFor(["antigravity"])).toEqual(["AGENTS.md", "GEMINI.md"]);
    expect(bootloadersFor(["claude"])).toEqual(["CLAUDE.md"]);
  });

  it("declares the directory-loading targets so no consumer hardcodes them", () => {
    // Cursor and Kiro both load a whole rule tree, not just the bootloader aih writes.
    // Before this field, `report/bloat.ts` hardcoded ".cursor/rules" and never walked
    // `.kiro/steering` — the same hand-kept-list class of bug as #553.
    expect(entry("cursor").loadsDirectory).toBe(".cursor/rules");
    expect(entry("kiro").loadsDirectory).toBe(".kiro/steering");
    // A root bootloader is a single file, never a directory load — `CLAUDE.md`'s parent
    // is the repo root, so a dirname-derived value would swallow the entire tree.
    expect(entry("claude").loadsDirectory).toBeUndefined();
    // `.github` holds workflows and far more than agent context; Copilot's instruction
    // file is a file load, so the directory stays undeclared rather than guessed.
    expect(entry("copilot").loadsDirectory).toBeUndefined();
  });

  it("keeps every declared loadsDirectory the parent of that CLI's own bootloader", () => {
    // Structural invariant: the declared tree must actually be the one aih writes into,
    // so a typo ('.cursor/rule') fails here instead of silently measuring nothing.
    const declared = REGISTRY_IDS.filter((id) => entry(id).loadsDirectory !== undefined);
    expect(declared.length).toBeGreaterThan(0); // guard the guard
    for (const id of declared) {
      const dir = entry(id).loadsDirectory as string;
      expect(dir).not.toMatch(/\/$/); // no trailing slash — paths join predictably
      expect(entry(id).bootloaders.some((b) => b.startsWith(`${dir}/`))).toBe(true);
    }
  });

  it("loadedDirsFor dedupes and preserves canonical order, skipping file-only targets", () => {
    expect(loadedDirsFor(["claude", "codex"])).toEqual([]); // neither loads a tree
    expect(loadedDirsFor(["kiro", "cursor"])).toEqual([".kiro/steering", ".cursor/rules"]);
    expect(loadedDirsFor(["cursor", "claude", "cursor"])).toEqual([".cursor/rules"]);
  });

  it("throws on an unknown CLI id", () => {
    expect(() => entry("nope")).toThrow();
  });
});
