import { describe, expect, it } from "vitest";
import {
  asPosture,
  deniedServers,
  evaluateMcpPolicy,
  type McpPosture,
  mcpGovernanceDoc,
  type ServerPolicy,
} from "../../src/mcp/policy.js";
import type { McpServer } from "../../src/mcp/servers.js";

/** A minimal valid server with the three risk axes set — the only inputs the policy reads. */
function srv(
  egress: McpServer["egress"],
  supplyChain: McpServer["supplyChain"],
  credentials: McpServer["credentials"] = "none",
): McpServer {
  return {
    type: "stdio",
    command: "uvx",
    args: ["x@1.0.0"],
    description: "d",
    classification: egress === "none" || egress === "local-only" ? "local" : "third-party-hosted",
    egress,
    credentials,
    supplyChain,
  };
}

/** Evaluate a single-server map and return its one verdict (guarded for noUncheckedIndexedAccess). */
function only(servers: Record<string, McpServer>, posture: McpPosture): ServerPolicy {
  const [p] = evaluateMcpPolicy(servers, posture);
  if (!p) throw new Error("expected exactly one policy result");
  return p;
}

describe("evaluateMcpPolicy — enterprise posture (the gate)", () => {
  it("DENIES third-party egress — self-host or remove", () => {
    const p = only({ a: srv("third-party", "hosted-remote") }, "enterprise");
    expect(p.verdict).toBe("deny");
    expect(p.reason).toContain("third-party egress");
  });

  it("DENIES an unpinned supply chain", () => {
    const p = only({ a: srv("none", "unpinned") }, "enterprise");
    expect(p.verdict).toBe("deny");
    expect(p.reason).toContain("unpinned");
  });

  it("WARNS (does not deny) on a token credential when egress + supply chain are clean", () => {
    const p = only({ a: srv("vendor-incumbent", "hosted-remote", "token") }, "enterprise");
    expect(p.verdict).toBe("warn");
    expect(p.reason).toContain("token");
  });

  it("ALLOWS the github shape (vendor-incumbent egress + oauth, no secret in file)", () => {
    const p = only({ a: srv("vendor-incumbent", "hosted-remote", "oauth") }, "enterprise");
    expect(p.verdict).toBe("allow");
  });

  it("ALLOWS zero-egress local and local-only servers", () => {
    expect(only({ a: srv("none", "pinned") }, "enterprise").verdict).toBe("allow");
    expect(only({ a: srv("local-only", "pinned") }, "enterprise").verdict).toBe("allow");
  });
});

describe("evaluateMcpPolicy — community posture (permissive, but eyes-open)", () => {
  it("WARNS on third-party egress but never blocks it", () => {
    expect(only({ a: srv("third-party", "hosted-remote") }, "community").verdict).toBe("warn");
  });

  it("WARNS on an unpinned supply chain", () => {
    expect(only({ a: srv("none", "unpinned") }, "community").verdict).toBe("warn");
  });

  it("ALLOWS clean local servers", () => {
    expect(only({ a: srv("none", "pinned") }, "community").verdict).toBe("allow");
  });

  it("never denies anything — community is permissive", () => {
    const verdicts = evaluateMcpPolicy(
      { a: srv("third-party", "unpinned", "token"), b: srv("none", "pinned") },
      "community",
    ).map((p) => p.verdict);
    expect(verdicts).not.toContain("deny");
  });
});

describe("deniedServers / asPosture / mcpGovernanceDoc", () => {
  it("deniedServers returns only the denied subset (the skipped-with-reason list)", () => {
    const policies = evaluateMcpPolicy(
      { ok: srv("none", "pinned"), bad: srv("third-party", "hosted-remote") },
      "enterprise",
    );
    expect(deniedServers(policies).map((p) => p.name)).toEqual(["bad"]);
  });

  it("asPosture coerces anything but 'enterprise' to community", () => {
    expect(asPosture("enterprise")).toBe("enterprise");
    expect(asPosture("community")).toBe("community");
    expect(asPosture(undefined)).toBe("community");
    expect(asPosture("nonsense")).toBe("community");
  });

  it("the governance doc groups verdicts, names the denied set with reasons, and cites CODEOWNERS", () => {
    const policies = evaluateMcpPolicy(
      { graph: srv("none", "pinned"), context7: srv("third-party", "hosted-remote") },
      "enterprise",
    );
    const text = mcpGovernanceDoc(policies, "enterprise");
    expect(text).toContain("MCP governance — enterprise posture");
    expect(text).toContain("Denied (1)");
    expect(text).toContain("context7");
    expect(text).toContain("Allowed (1)");
    expect(text).toContain("graph");
    expect(text).toContain("CODEOWNERS");
  });
});
