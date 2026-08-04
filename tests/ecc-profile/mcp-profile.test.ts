import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildEccMcpProfileProjection,
  CONTEXT7_SUBJECT_SHA256,
  evaluateEccMcpHealth,
  filterSerenaToolsList,
  guardSerenaToolCall,
  mergeEccMcpServers,
  SERENA_ALLOWED_TOOLS,
  SERENA_REQUIRED_TOOLS,
  SERENA_RUNTIME_PIN,
  SerenaMcpPolicyGuard,
} from "../../src/ecc-profile/mcp-profile.js";

const SHA = "a".repeat(64);
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function input(client: "claude" | "codex" = "claude") {
  const root = mkdtempSync(join(tmpdir(), "aih-ecc-mcp-"));
  roots.push(root);
  return {
    client,
    canonicalWorktree: join(root, "project"),
    serenaHome: join(root, "serena-home"),
    serenaRuntimeRoot: join(root, "serena-runtime"),
    wrapperCommand: join(
      root,
      process.platform === "win32" ? "aih-mcp-wrapper.exe" : "aih-mcp-wrapper",
    ),
    wrapperSha256: "c".repeat(64),
    serenaDependencyLockSha256: SHA,
    context7Attestation: {
      endpoint: "https://mcp.context7.com/mcp",
      subjectSha256: CONTEXT7_SUBJECT_SHA256,
      reviewedAt: "2026-08-03T00:00:00.000Z",
    },
  } as const;
}

describe("ECC MCP profile projection", () => {
  it("projects exactly the selected profile identities and leaves defaults disabled", () => {
    const projection = buildEccMcpProfileProjection(input());

    expect(Object.keys(projection.servers)).toEqual([
      "code-review-graph",
      "codebase-memory-mcp",
      "context7",
      "serena",
    ]);
    expect(projection.disabled).toEqual([
      "ecc-memory-mcp",
      "github",
      "sequential-thinking",
      "token-savior",
    ]);
    expect(JSON.stringify(projection)).not.toContain("server-sequential-thinking");
  });

  it("renders deterministic native Claude JSON and Codex TOML without registering it", () => {
    const claude = buildEccMcpProfileProjection(input("claude"));
    const codexInput = input("codex");
    const codexA = buildEccMcpProfileProjection(codexInput);
    const codexB = buildEccMcpProfileProjection(codexInput);

    expect(claude.activation).toBe("prepared-not-registered");
    expect(claude.native.kind).toBe("claude-json");
    expect(claude.native.body).toContain('"mcpServers"');
    expect(codexA.native.kind).toBe("codex-toml");
    expect(codexA.native.body).toContain('[mcp_servers."serena"]');
    expect(codexA.native.body).toBe(codexB.native.body);
  });

  it("binds Serena to the reviewed package, source, wheel, dependency lock, and isolated roots", () => {
    const request = input("codex");
    const projection = buildEccMcpProfileProjection(request);
    const serena = projection.servers.serena;

    expect(SERENA_RUNTIME_PIN).toEqual({
      package: "serena-agent==1.6.1",
      sourceCommit: "bcac0969fb8685783ea6d0f2642468fcc47e6395",
      wheelSha256: "04ddd985bd3feb25598ab8732bf3a998f961d5b46dce271b816126c0a68a91e1",
      metadataSha256: "4c95007465c14bed34e4d0022cc9382e826feafb9212eb6c9a1888ea2548bd7d",
    });
    expect(serena?.type).toBe("stdio");
    if (serena?.type !== "stdio") throw new Error("expected stdio Serena server");
    expect(serena.command).toBe(request.wrapperCommand);
    expect(isAbsolute(serena.command)).toBe(true);
    expect(serena.args).toEqual([
      "serena",
      "--package",
      SERENA_RUNTIME_PIN.package,
      "--dependency-lock-sha256",
      SHA,
      "--lock-root",
      request.serenaRuntimeRoot,
      "--context",
      "codex",
      "--mode",
      "no-memories",
      "--project",
      request.canonicalWorktree,
    ]);
    expect(serena.env).toEqual({
      SERENA_HOME: request.serenaHome,
      SERENA_USAGE_REPORTING: "false",
    });
    expect(projection.provenance.serena.wrapperSha256).toBe("c".repeat(64));
    expect(projection.serenaConfig).toContain("web_dashboard_open_on_launch: false");
    expect(projection.serenaConfig).toContain("web_dashboard_interface: browser");
    expect(projection.serenaConfig).toContain("fixed_tools:");
    for (const tool of SERENA_ALLOWED_TOOLS)
      expect(projection.serenaConfig).toContain(`  - ${tool}`);
  });

  it("fails closed on malformed trust evidence or unsafe/ambiguous roots", () => {
    expect(() =>
      buildEccMcpProfileProjection({ ...input(), serenaDependencyLockSha256: "AAAA" }),
    ).toThrow(/dependency lock/i);
    expect(() =>
      buildEccMcpProfileProjection({ ...input(), wrapperCommand: "aih-wrapper" }),
    ).toThrow(/absolute/i);
    expect(() =>
      buildEccMcpProfileProjection({ ...input(), wrapperSha256: "d".repeat(63) }),
    ).toThrow(/wrapper/i);
    expect(() =>
      buildEccMcpProfileProjection({ ...input(), canonicalWorktree: "../project" }),
    ).toThrow(/absolute/i);
    expect(() =>
      buildEccMcpProfileProjection({
        ...input(),
        canonicalWorktree: `${input().canonicalWorktree}\ninvalid`,
      }),
    ).toThrow(/control character/i);
    const traversal = input();
    expect(() =>
      buildEccMcpProfileProjection({
        ...traversal,
        canonicalWorktree: `${traversal.canonicalWorktree}\\..\\other`,
      }),
    ).toThrow(/traversal|normalized/i);
    const nestedState = input();
    expect(() =>
      buildEccMcpProfileProjection({
        ...nestedState,
        serenaHome: join(nestedState.canonicalWorktree, ".serena-state"),
      }),
    ).toThrow(/outside/i);
    expect(() =>
      buildEccMcpProfileProjection({
        ...input(),
        context7Attestation: { ...input().context7Attestation, endpoint: "http://example.test" },
      }),
    ).toThrow(/Context7/i);
    expect(() =>
      buildEccMcpProfileProjection({ ...input(), context7Attestation: undefined }),
    ).toThrow(/attestation/i);
    expect(() =>
      buildEccMcpProfileProjection({
        ...input(),
        context7Attestation: {
          ...input().context7Attestation,
          reviewedAt: "August 3, 2026",
        },
      }),
    ).toThrow(/ISO timestamp/i);
  });

  it("enforces the Serena tool boundary even when a client filter is absent", () => {
    const upstream = {
      tools: [
        ...SERENA_ALLOWED_TOOLS.map((name) => ({ name, description: name })),
        { name: "activate_project", description: "unsafe" },
        { name: "execute_shell_command", description: "unsafe" },
        { name: "write_memory", description: "unsafe" },
        { name: "open_dashboard", description: "overlap" },
      ],
    };

    expect(filterSerenaToolsList(upstream).tools.map((tool) => tool.name)).toEqual(
      SERENA_ALLOWED_TOOLS,
    );
    expect(guardSerenaToolCall("find_symbol")).toEqual({ allowed: true });
    expect(guardSerenaToolCall("activate_project")).toEqual({
      allowed: false,
      code: -32601,
      message: "Serena tool 'activate_project' is disabled by the AIH ECC profile",
    });
    expect(() =>
      filterSerenaToolsList({ tools: [{ name: "find_symbol" }, { name: "find_symbol" }] }),
    ).toThrow(/duplicate/i);
    expect(() => filterSerenaToolsList(null)).toThrow(/malformed/i);
    expect(() => filterSerenaToolsList({ tools: [null] })).toThrow(/malformed tool/i);
    expect(() =>
      filterSerenaToolsList({
        tools: SERENA_ALLOWED_TOOLS.filter((name) => name !== "find_implementations").map(
          (name) => ({ name }),
        ),
      }),
    ).toThrow(/missing reviewed tools/i);
    expect(SERENA_REQUIRED_TOOLS).toContain("find_implementations");
  });

  it("enforces the hard policy on JSON-RPC calls and returned discovery", () => {
    const guard = new SerenaMcpPolicyGuard();
    expect(
      guard.inspectClientRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "execute_shell_command", arguments: {} },
      }),
    ).toEqual({
      forward: false,
      response: {
        jsonrpc: "2.0",
        id: 7,
        error: {
          code: -32601,
          message: "Serena tool 'execute_shell_command' is disabled by the AIH ECC profile",
        },
      },
    });
    expect(
      guard.inspectClientRequest({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "find_symbol", arguments: {} },
      }),
    ).toEqual({ forward: true });
    expect(guard.inspectClientRequest({ jsonrpc: "2.0", id: 10, method: "tools/list" })).toEqual({
      forward: true,
    });
    expect(() =>
      guard.inspectClientRequest({ jsonrpc: "2.0", id: 9, method: "tools/call", params: {} }),
    ).toThrow(/malformed/i);
    expect(() => guard.inspectClientRequest([])).toThrow(/malformed/i);
    expect(() =>
      guard.inspectClientRequest({
        jsonrpc: "2.0",
        id: { ambiguous: true },
        method: "tools/call",
        params: { name: "find_symbol" },
      }),
    ).toThrow(/request id/i);
  });

  it("merge-preserves unrelated operator servers and rejects selected-name conflicts", () => {
    const projection = buildEccMcpProfileProjection(input());
    const operator = {
      "operator-owned": {
        type: "http" as const,
        url: "https://operator.example/mcp",
        description: "operator",
        classification: "third-party-hosted" as const,
        egress: "third-party" as const,
        credentials: "oauth" as const,
        supplyChain: "hosted-remote" as const,
      },
    };

    expect(Object.keys(mergeEccMcpServers(operator, projection.servers))).toEqual([
      "operator-owned",
      "code-review-graph",
      "codebase-memory-mcp",
      "context7",
      "serena",
    ]);
    expect(() =>
      mergeEccMcpServers({ ...operator, serena: operator["operator-owned"] }, projection.servers),
    ).toThrow(/conflict/i);
  });

  it("keeps ordinary startup advisory while setup acceptance fails closed", () => {
    const partial = {
      "code-review-graph": true,
      "codebase-memory-mcp": true,
      context7: false,
      serena: false,
    };
    expect(evaluateEccMcpHealth("ordinary", partial)).toEqual({
      mode: "ordinary",
      status: "advisory",
      failedServers: ["context7", "serena"],
    });
    expect(evaluateEccMcpHealth("setup-acceptance", partial)).toEqual({
      mode: "setup-acceptance",
      status: "blocked",
      failedServers: ["context7", "serena"],
    });
  });
});
