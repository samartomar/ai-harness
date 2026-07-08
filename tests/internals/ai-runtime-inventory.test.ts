import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAiRuntimeInventory,
  hasExactPackagePin,
} from "../../src/internals/ai-runtime-inventory.js";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "aih-runtime-inventory-"));
}

describe("AI runtime inventory", () => {
  it("accepts exact package pins and rejects mutable package specs", () => {
    expect(hasExactPackagePin("@modelcontextprotocol/server-sequential-thinking@2025.12.18")).toBe(
      true,
    );
    expect(hasExactPackagePin("code-review-graph@2.3.6")).toBe(true);
    expect(hasExactPackagePin("@modelcontextprotocol/server-sequential-thinking")).toBe(false);
    expect(hasExactPackagePin("@modelcontextprotocol/server-sequential-thinking@latest")).toBe(
      false,
    );
    expect(hasExactPackagePin("ecc-universal@^1.0.0")).toBe(false);
    expect(hasExactPackagePin("code-review-graph@2")).toBe(false);
    expect(hasExactPackagePin("code-review-graph@2-latest")).toBe(false);
    expect(hasExactPackagePin("code-review-graph@2026")).toBe(false);
    expect(hasExactPackagePin("code-review-graph@2.3")).toBe(false);
    expect(hasExactPackagePin("code-review-graph@2.3.6-rc.1")).toBe(true);
  });

  it("fails closed on unpinned MCP npx launchers", () => {
    const root = tempRepo();
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          floating: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
            egress: "none",
            credentials: "none",
            supplyChain: "unpinned",
          },
        },
      }),
    );

    const inventory = buildAiRuntimeInventory(root);

    expect(inventory.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ai-runtime.npx-unpinned", severity: "fail" }),
      ]),
    );
  });

  it("passes pinned MCP npx and hardened uvx launchers", () => {
    const root = tempRepo();
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          thinking: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2025.12.18"],
            egress: "none",
            credentials: "none",
            supplyChain: "pinned",
          },
          graph: {
            type: "stdio",
            command: "uvx",
            args: [
              "--offline",
              "--no-python-downloads",
              "--no-env-file",
              "code-review-graph@2.3.6",
            ],
            egress: "none",
            credentials: "none",
            supplyChain: "pinned",
          },
        },
      }),
    );

    const inventory = buildAiRuntimeInventory(root);

    expect(inventory.findings.filter((finding) => finding.severity === "fail")).toEqual([]);
    expect(inventory.mcp.servers.map((server) => server.name)).toEqual(["thinking", "graph"]);
  });

  it("fails closed when uvx only pins an auxiliary dependency", () => {
    const root = tempRepo();
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          graph: {
            type: "stdio",
            command: "uvx",
            args: [
              "--offline",
              "--no-env-file",
              "--with",
              "helper-package@1.0.0",
              "code-review-graph",
            ],
            egress: "none",
            credentials: "none",
            supplyChain: "unpinned",
          },
        },
      }),
    );

    const inventory = buildAiRuntimeInventory(root);

    expect(inventory.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ai-runtime.uvx-unpinned", severity: "fail" }),
      ]),
    );
  });

  it("accepts uvx launchers that pin the executable package through --from", () => {
    const root = tempRepo();
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          graph: {
            type: "stdio",
            command: "uvx",
            args: [
              "--offline",
              "--no-env-file",
              "--with",
              "helper-package@1.0.0",
              "--from",
              "code-review-graph@2.3.6",
              "code-review-graph",
            ],
            egress: "none",
            credentials: "none",
            supplyChain: "pinned",
          },
        },
      }),
    );

    const inventory = buildAiRuntimeInventory(root);

    expect(inventory.findings.filter((finding) => finding.severity === "fail")).toEqual([]);
  });

  it("fails closed when .mcp.json is not a regular file", () => {
    const root = tempRepo();
    mkdirSync(join(root, ".mcp.json"));

    const inventory = buildAiRuntimeInventory(root);

    expect(inventory.mcp.config).toBe("unsafe");
    expect(inventory.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ai-runtime.mcp-config-unsafe", severity: "fail" }),
      ]),
    );
  });

  it("warns on mutable npx launchers in workflows without failing the gate", () => {
    const root = tempRepo();
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github", "workflows", "nightly.yml"),
      "jobs:\n  test:\n    steps:\n      - run: npx some-tool@latest --check\n",
    );

    const inventory = buildAiRuntimeInventory(root);

    expect(inventory.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ai-runtime.workflow-mutable-npx", severity: "warn" }),
      ]),
    );
    expect(inventory.findings.some((finding) => finding.severity === "fail")).toBe(false);
  });

  it("fails closed when the workflow root is not a contained directory", () => {
    const root = tempRepo();
    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, ".github", "workflows"), "not a directory");

    const inventory = buildAiRuntimeInventory(root);

    expect(inventory.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ai-runtime.workflow-root-unsafe",
          severity: "fail",
        }),
      ]),
    );
  });
});
