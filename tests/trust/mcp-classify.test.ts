import { describe, expect, it } from "vitest";
import { classifyIncomingMcp } from "../../src/trust/mcp-classify.js";

describe("classifyIncomingMcp", () => {
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

  it("treats exact-version package launches as pinned when no floating launch tell is present", () => {
    const server = classifyIncomingMcp({
      command: "node",
      args: ["@scope/example-tool@1.2.3"],
    });

    expect(server).toMatchObject({
      classification: "local",
      egress: "local-only",
      credentials: "none",
      supplyChain: "pinned",
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

  it("fails closed on garbage server shapes without throwing", () => {
    expect(() => classifyIncomingMcp(true)).not.toThrow();
    expect(classifyIncomingMcp(true)).toMatchObject({
      classification: "third-party-hosted",
      egress: "third-party",
      supplyChain: "unpinned",
    });
  });
});
