import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MARKITDOWN_MCP_PIN, optionalMarkItDownMcpServer } from "../../src/mcp/markitdown.js";
import { mcpResolverPinState, uvxPrimaryPin } from "../../src/mcp/pins.js";
import { MARKITDOWN_RUNTIME_PIN } from "../../src/tools/markitdown-runtime.js";

describe("optional MarkItDown MCP", () => {
  it("binds the CLI and optional adapter ledger to their shared converter version", () => {
    const ledger = JSON.parse(
      readFileSync(
        new URL("../../src/internals/external-pin-ledger.json", import.meta.url),
        "utf8",
      ),
    );
    const entries = ledger.entries as {
      surface: string;
      version: string;
      commit?: string;
      integrity: string;
    }[];
    expect(entries.find((entry) => entry.surface === "markitdown-cli")).toMatchObject({
      version: MARKITDOWN_RUNTIME_PIN.version,
      commit: MARKITDOWN_RUNTIME_PIN.sourceCommit,
      integrity: `sha256:${MARKITDOWN_RUNTIME_PIN.wheelSha256}`,
    });
    expect(entries.find((entry) => entry.surface === "markitdown-mcp")).toMatchObject({
      version: MARKITDOWN_MCP_PIN.package.split("==")[1],
      integrity: `sha256:${MARKITDOWN_MCP_PIN.wheelSha256}`,
    });
    expect(MARKITDOWN_MCP_PIN.converterPackage).toBe(
      `markitdown[all]==${MARKITDOWN_RUNTIME_PIN.version}`,
    );
  });
  it("pins the official adapter and converter including the exact Python prerelease", () => {
    const server = optionalMarkItDownMcpServer();
    if (server.type !== "stdio") throw new Error("expected stdio");
    expect(mcpResolverPinState(server.command, server.args)).toBe("pinned");
    expect(uvxPrimaryPin(server.args)?.version).toBe("0.0.1a7");
    expect(server.args).toContain("markitdown[all]==0.1.8");
    expect(server.args).not.toContain("--http");
    expect(server.egress).toBe("third-party");
  });

  it.each(["0.0.1a", "0.0.1a*", ">=0.0.1a7", "0.0.1a7;extra"])(
    "does not treat %s as an immutable version",
    (version) => {
      expect(mcpResolverPinState("uvx", [`markitdown-mcp==${version}`])).toBe("unpinned");
    },
  );
});
