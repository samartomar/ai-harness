import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyIncomingMcp } from "../../src/trust/mcp-classify.js";

function sha256Text(body: string): string {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

describe("classifyIncomingMcp", () => {
  it("carries the stdio env map so an env-only rug-pull invalidates a stale acknowledgement", () => {
    const base = classifyIncomingMcp({
      command: "npx",
      args: ["-y", "widget-mcp-server"],
      env: { WIDGET_TOKEN: "widget-token-ref" },
    });
    if (base.type !== "stdio") throw new Error("expected stdio classification");
    expect(base.env).toEqual({ WIDGET_TOKEN: "widget-token-ref" });

    // Mutating only env must change the classified env — which feeds the
    // content-bound mcp.policy-denied fingerprint — so a prior ack no longer matches.
    const mutated = classifyIncomingMcp({
      command: "npx",
      args: ["-y", "widget-mcp-server"],
      env: { WIDGET_TOKEN: "widget-token-ref", EXTRA: "evil-example" },
    });
    if (mutated.type !== "stdio") throw new Error("expected stdio classification");
    expect(mutated.env).not.toEqual(base.env);

    const stripped = classifyIncomingMcp({
      command: "npx",
      args: ["-y", "widget-mcp-server"],
    });
    if (stripped.type !== "stdio") throw new Error("expected stdio classification");
    expect(stripped.env).toEqual({});
  });

  it("treats floating npx package launches as unpinned local-only servers", () => {
    const server = classifyIncomingMcp({
      command: "npx",
      args: ["-y", "example-tool@latest"],
      description: "floating package",
    });

    expect(server).toMatchObject({
      classification: "local",
      egress: "local-only",
      credentials: "none",
      supplyChain: "unpinned",
    });
  });

  it("does not treat an exact-looking argument to a non-resolver as a package pin", () => {
    const server = classifyIncomingMcp({
      command: "node",
      args: ["@scope/example-tool@1.2.3"],
    });

    expect(server).toMatchObject({
      classification: "local",
      egress: "local-only",
      credentials: "none",
      supplyChain: "unpinned",
    });
  });

  it("does not trust path-qualified resolver lookalikes as package pins", () => {
    for (const command of ["./npx", "NPX"]) {
      const server = classifyIncomingMcp({
        command,
        args: ["@scope/example-tool@1.2.3"],
      });

      expect(server).toMatchObject({
        classification: "local",
        egress: "local-only",
        credentials: "none",
        supplyChain: "unpinned",
      });
    }
  });

  it("does not trust source-changing uvx environment overrides", () => {
    const server = classifyIncomingMcp({
      command: "uvx",
      args: ["--offline", "--no-env-file", "--no-python-downloads", "tool@1.2.3"],
      env: {
        UV_FIND_LINKS: "$" + "{WHEELS}",
        UV_PYTHON: "$" + "{UV_PYTHON}",
      },
    });

    expect(server).toMatchObject({
      classification: "local",
      egress: "local-only",
      credentials: "none",
      supplyChain: "unpinned",
    });
  });

  it("fails closed when a resolver environment contains a non-string override", () => {
    const server = classifyIncomingMcp({
      command: "npx",
      args: ["@scope/example-tool@1.2.3"],
      env: { PATH: 7 },
    });

    expect(server).toMatchObject({
      classification: "local",
      egress: "local-only",
      credentials: "none",
      supplyChain: "unpinned",
    });
  });

  it("recognizes pinned local FastMCP skills-over-MCP servers with manifest evidence", () => {
    const manifest = JSON.stringify({ name: "clean", files: ["SKILL.md"] });
    const server = classifyIncomingMcp({
      command: "uvx",
      args: ["fastmcp==3.2.4", "run", "locked_skills.py"],
      provider: "SkillsDirectoryProvider",
      resources: ["skill://clean/_manifest"],
      _manifest: manifest,
      reload: false,
    });

    expect(server).toMatchObject({
      classification: "local",
      egress: "none",
      credentials: "none",
      supplyChain: "pinned",
      skillsProvider: {
        provider: "SkillsDirectoryProvider",
        serverVersion: "3.2.4",
        manifestSha256: sha256Text(manifest),
        hotReload: false,
      },
    });
  });

  it("treats skills-over-MCP hot reload as unpinned drift risk even with a pinned server", () => {
    const server = classifyIncomingMcp({
      command: "uvx",
      args: ["fastmcp==3.2.4", "run", "locked_skills.py", "--reload"],
      provider: "SkillProvider",
      uri: "skill://clean/_manifest",
      _manifest: "clean manifest",
    });

    expect(server).toMatchObject({
      classification: "local",
      egress: "none",
      supplyChain: "unpinned",
      skillsProvider: {
        provider: "SkillProvider",
        serverVersion: "3.2.4",
        manifestSha256: sha256Text("clean manifest"),
        hotReload: true,
      },
    });
  });

  it("recognizes the plural SkillsProvider spelling from the issue shape", () => {
    const server = classifyIncomingMcp({
      command: "uvx",
      args: ["fastmcp==3.2.4", "run", "locked_skills.py"],
      provider: "SkillsProvider",
      _manifest: "plural provider manifest",
    });

    expect(server).toMatchObject({
      egress: "none",
      supplyChain: "pinned",
      skillsProvider: {
        provider: "SkillsProvider",
        serverVersion: "3.2.4",
        manifestSha256: sha256Text("plural provider manifest"),
        hotReload: false,
      },
    });
  });

  it("treats bundled local node launches as unpinned when provenance is unverifiable", () => {
    const server = classifyIncomingMcp({
      command: "node",
      args: ["server.js"],
    });

    expect(server).toMatchObject({
      classification: "local",
      egress: "local-only",
      credentials: "none",
      supplyChain: "unpinned",
    });
  });

  it("treats bare local binaries as unpinned when provenance is unverifiable", () => {
    const server = classifyIncomingMcp({
      command: "/opt/x/tool",
    });

    expect(server).toMatchObject({
      classification: "local",
      egress: "local-only",
      credentials: "none",
      supplyChain: "unpinned",
    });
  });

  it("treats http URLs as third-party hosted remote servers", () => {
    const server = classifyIncomingMcp({
      url: "https://mcp.vendor.example/mcp",
      description: "remote server",
    });

    expect(server).toMatchObject({
      type: "http",
      url: "https://mcp.vendor.example/mcp",
      classification: "third-party-hosted",
      egress: "third-party",
      credentials: "none",
      supplyChain: "hosted-remote",
    });
  });

  it("carries http headers and treats credential headers as token-backed remote servers", () => {
    const server = classifyIncomingMcp({
      url: "https://mcp.vendor.example/mcp",
      headers: {
        Authorization: "Bearer $" + "{VENDOR_TOKEN}",
        Accept: "application/json",
      },
    });

    expect(server).toMatchObject({
      type: "http",
      url: "https://mcp.vendor.example/mcp",
      headers: {
        Authorization: "Bearer $" + "{VENDOR_TOKEN}",
        Accept: "application/json",
      },
      credentials: "token",
    });
  });

  it("detects literal token-looking values in args and env but ignores env placeholders", () => {
    expect(
      classifyIncomingMcp({
        command: "node",
        args: ["server.js", "--api-key", `sk-${"a".repeat(24)}`],
      }).credentials,
    ).toBe("token");

    expect(
      classifyIncomingMcp({
        command: "node",
        env: { API_KEY: "$" + "{API_KEY}", TOKEN: "$TOKEN", WIN_TOKEN: "%TOKEN%" },
      }).credentials,
    ).toBe("none");
  });

  it("does not classify short GitHub-like strings as literal tokens", () => {
    expect(
      classifyIncomingMcp({
        command: "node",
        args: ["server.js", "--label", `ghp_${"a".repeat(10)}`],
        env: { LABEL: `github_pat_${"b".repeat(12)}` },
      }).credentials,
    ).toBe("none");
  });

  it("fails closed on garbage server shapes without throwing", () => {
    expect(() => classifyIncomingMcp(true)).not.toThrow();
    expect(classifyIncomingMcp(true)).toMatchObject({
      classification: "third-party-hosted",
      egress: "third-party",
      supplyChain: "unpinned",
    });
  });
});
