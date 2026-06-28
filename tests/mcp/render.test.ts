import { describe, expect, it } from "vitest";
import { upsertTextBlock } from "../../src/internals/envfile.js";
import {
  existingMcpTomlNames,
  isExternalMcp,
  mcpConfigAbs,
  mcpEntries,
  mcpEntryFor,
  mcpTomlBody,
  tomlServerCount,
} from "../../src/mcp/render.js";
import type { McpServer } from "../../src/mcp/servers.js";

const stdio: McpServer = {
  type: "stdio",
  command: "uvx",
  args: ["code-review-graph@2.3.6", "serve"],
  description: "graph",
  classification: "local",
};
const http: McpServer = {
  type: "http",
  url: "https://better-email-mcp.n24q02m.com/mcp",
  description: "email",
  classification: "third-party-hosted",
};

describe("mcpEntryFor — per-tool server shapes (verified against each tool's docs)", () => {
  it("claude/cursor/kiro/kimi keep the canonical aih shape (golden-preserving identity)", () => {
    for (const cli of ["claude", "cursor", "kiro", "kimi"] as const) {
      expect(mcpEntryFor(cli, stdio)).toBe(stdio); // same object — unchanged
    }
  });

  it("opencode: command+args collapse into ONE array, with type:local + enabled", () => {
    expect(mcpEntryFor("opencode", stdio)).toEqual({
      type: "local",
      command: ["uvx", "code-review-graph@2.3.6", "serve"],
      enabled: true,
    });
    expect(mcpEntryFor("opencode", http)).toEqual({
      type: "remote",
      url: "https://better-email-mcp.n24q02m.com/mcp",
      enabled: true,
    });
  });

  it("copilot (.vscode/mcp.json): keeps the type discriminator, strips aih metadata", () => {
    expect(mcpEntryFor("copilot", stdio)).toEqual({
      type: "stdio",
      command: "uvx",
      args: ["code-review-graph@2.3.6", "serve"],
    });
    expect(mcpEntryFor("copilot", http)).toEqual({
      type: "http",
      url: http.type === "http" ? http.url : "",
    });
  });

  it("gemini uses httpUrl for remote; windsurf uses serverUrl; zed/antigravity use url", () => {
    expect(mcpEntryFor("gemini", stdio)).toEqual({ command: "uvx", args: stdio.args });
    expect(mcpEntryFor("gemini", http)).toEqual({
      httpUrl: "https://better-email-mcp.n24q02m.com/mcp",
    });
    expect(mcpEntryFor("windsurf", http)).toEqual({
      serverUrl: "https://better-email-mcp.n24q02m.com/mcp",
    });
    expect(mcpEntryFor("zed", stdio)).toEqual({ command: "uvx", args: stdio.args });
    expect(mcpEntryFor("zed", http)).toEqual({ url: "https://better-email-mcp.n24q02m.com/mcp" });
    expect(mcpEntryFor("antigravity", stdio)).toEqual({ command: "uvx", args: stdio.args });
  });

  it("the transformed (non-native-claude) entries never leak aih's description/classification", () => {
    for (const cli of [
      "gemini",
      "windsurf",
      "zed",
      "opencode",
      "copilot",
      "antigravity",
    ] as const) {
      const blob = JSON.stringify(mcpEntryFor(cli, stdio));
      expect(blob).not.toContain("classification");
      expect(blob).not.toContain("description");
    }
  });

  it("mcpEntries renders the whole map", () => {
    expect(mcpEntries("gemini", { graph: stdio })).toEqual({
      graph: { command: "uvx", args: stdio.args },
    });
  });
});

describe("mcpTomlBody — Codex config.toml [mcp_servers.*] tables", () => {
  it("emits a quoted-name table with command + args", () => {
    expect(mcpTomlBody({ "code-review-graph": stdio })).toBe(
      '[mcp_servers."code-review-graph"]\ncommand = "uvx"\nargs = ["code-review-graph@2.3.6", "serve"]',
    );
  });

  it("quotes a DOTTED server name so it stays ONE table (not nested)", () => {
    const body = mcpTomlBody({ "awslabs.core-mcp-server": stdio });
    expect(body).toContain('[mcp_servers."awslabs.core-mcp-server"]');
    expect(body).not.toContain("[mcp_servers.awslabs.core");
  });

  it("renders an http server as a url table (no command/args)", () => {
    const body = mcpTomlBody({ email: http });
    expect(body).toBe('[mcp_servers."email"]\nurl = "https://better-email-mcp.n24q02m.com/mcp"');
  });

  it("tomlServerCount counts [mcp_servers.*] tables", () => {
    const body = mcpTomlBody({ a: stdio, b: http });
    expect(tomlServerCount(body)).toBe(2);
    expect(tomlServerCount('# no servers here\nmodel = "gpt-5"\n')).toBe(0);
  });
});

describe("Codex TOML managed-block merge preserves the user's config", () => {
  it("folds the [mcp_servers.*] block in, leaving other config untouched + idempotent", () => {
    const existing = 'model = "o4-mini"\n\n[profiles.work]\napproval = "on-request"\n';
    const once = upsertTextBlock(existing, "mcp", mcpTomlBody({ "code-review-graph": stdio }));
    // User config survives...
    expect(once).toContain('model = "o4-mini"');
    expect(once).toContain("[profiles.work]");
    // ...alongside the aih-managed MCP region.
    expect(once).toContain("aih managed (mcp)");
    expect(once).toContain('[mcp_servers."code-review-graph"]');
    // Re-applying the same block is byte-identical (idempotent).
    expect(upsertTextBlock(once, "mcp", mcpTomlBody({ "code-review-graph": stdio }))).toBe(once);
  });
});

describe("existingMcpTomlNames — collision avoidance (no duplicate [mcp_servers.X])", () => {
  it("lists the user's top-level server names, ignoring `.env` sub-tables", () => {
    const cfg =
      '[mcp_servers.github]\ncommand = "x"\n\n[mcp_servers."ai-os"]\ncommand = "y"\n\n[mcp_servers."ai-os".env]\nA = "1"\n';
    expect(existingMcpTomlNames(cfg, "mcp")).toEqual(new Set(["github", "ai-os"]));
  });

  it("ignores names inside aih's OWN managed region (those are replaced each run)", () => {
    const withBlock = upsertTextBlock(
      '[mcp_servers.github]\ncommand = "x"\n',
      "mcp",
      mcpTomlBody({ "code-review-graph": stdio }),
    );
    // code-review-graph lives in aih's block → it is NOT a "user" name.
    expect(existingMcpTomlNames(withBlock, "mcp")).toEqual(new Set(["github"]));
  });

  it("filtering the blueprint against existing names yields exactly ONE playwright table", () => {
    // Reproduces the real hazard: a user whose Codex config already has `playwright`.
    const userCfg =
      '[mcp_servers.playwright]\ncommand = "npx"\nargs = ["@playwright/mcp@latest"]\n';
    const have = existingMcpTomlNames(userCfg, "mcp");
    const blueprint = { "code-review-graph": stdio, playwright: stdio };
    const fresh = Object.fromEntries(Object.entries(blueprint).filter(([n]) => !have.has(n)));
    expect(Object.keys(fresh)).toEqual(["code-review-graph"]); // playwright skipped — user's wins
    const merged = upsertTextBlock(userCfg, "mcp", mcpTomlBody(fresh));
    expect((merged.match(/\[mcp_servers\."?playwright"?\]/g) ?? []).length).toBe(1);
    expect(merged).toContain('[mcp_servers."code-review-graph"]');
  });
});

describe("path helpers", () => {
  it("isExternalMcp flags ~/home and absolute paths, not repo-relative", () => {
    expect(isExternalMcp("~/.codex/config.toml")).toBe(true);
    expect(isExternalMcp("/etc/x")).toBe(true);
    expect(isExternalMcp(".vscode/mcp.json")).toBe(false);
    expect(isExternalMcp("opencode.json")).toBe(false);
  });

  it("mcpConfigAbs expands a leading ~ against the given home", () => {
    expect(mcpConfigAbs("/home/me", "~/.codex/config.toml").replace(/\\/g, "/")).toBe(
      "/home/me/.codex/config.toml",
    );
    expect(mcpConfigAbs("/home/me", "/abs/path")).toBe("/abs/path");
  });
});
