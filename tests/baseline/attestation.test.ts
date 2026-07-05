import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enterpriseBaselineAttestationCheck } from "../../src/baseline/attestation.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-baseline-attestation-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(posture: PlanContext["posture"] = "enterprise"): PlanContext {
  const run = fakeRunner(() => ({ code: 1, spawnError: true }));
  return {
    root: dir,
    contextDir: "ai-coding",
    posture,
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

function writePolicy(
  allowedServers: string[],
  approvedSources: Array<{ owner: string; repo: string; pinnedSha?: string }> = [],
): void {
  writeFileSync(
    join(dir, "aih-org-policy.json"),
    JSON.stringify({
      schemaVersion: 1,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      mcp: { allowedServers, allowManagedOnly: true },
      trust: { approvedSources },
    }),
  );
}

function writeMcp(servers: Record<string, unknown>): void {
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
}

function writeMarketplaceSkill(
  source = "owner/repo@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
): void {
  mkdirSync(join(dir, ".aih", "marketplace"), { recursive: true });
  writeFileSync(
    join(dir, ".aih", "marketplace", "marketplace.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "acme-skills",
      skills: [
        {
          name: "clean",
          source,
          commit: "a".repeat(40),
          verdict: "GREEN",
          card: "cards/clean.json",
          evidence: "evidence/owner-repo-aaaaaaaa.json",
          files: [{ path: "skills/clean/SKILL.md", sha256: "b".repeat(64), bytes: 10 }],
        },
      ],
    }),
  );
}

describe("enterprise baseline attestation", () => {
  it("flags MCP servers that are not members of the declared registry", () => {
    writePolicy(["github"]);
    writeMcp({
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        egress: "vendor-incumbent",
        credentials: "oauth",
        supplyChain: "hosted-remote",
      },
      rogue: {
        type: "http",
        url: "https://rogue.example/mcp/",
        egress: "third-party",
        credentials: "none",
        supplyChain: "hosted-remote",
      },
    });

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check).toMatchObject({
      verdict: "fail",
      code: "baseline.undeclared-surface",
    });
    expect(check.detail).toContain("mcp:rogue");
    expect(check.detail).toContain("third-party");
    expect(check.detail).not.toContain("mcp:github is undeclared");
  });

  it("emits a positive attestation when every external surface is a registry member", () => {
    writePolicy(
      ["github", "context7"],
      [{ owner: "owner", repo: "repo", pinnedSha: "a".repeat(40) }],
    );
    writeMcp({
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        egress: "vendor-incumbent",
        credentials: "oauth",
        supplyChain: "hosted-remote",
      },
      context7: {
        type: "http",
        url: "https://mcp.context7.com/mcp",
        egress: "third-party",
        credentials: "none",
        supplyChain: "hosted-remote",
      },
    });
    writeMarketplaceSkill();

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check.verdict).toBe("pass");
    expect(check.detail).toContain("clean baseline attestation");
    expect(check.detail).toContain("mcp:github");
    expect(check.detail).toContain("vendor-incumbent/oauth/hosted-remote");
    expect(check.detail).toContain("mcp:context7");
    expect(check.detail).toContain("marketplace:owner/repo@aaaaaaaaaaaa");
  });

  it("flags marketplace skills whose source is not registered", () => {
    writePolicy([]);
    writeMarketplaceSkill("stranger/repo@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check.verdict).toBe("fail");
    expect(check.code).toBe("baseline.undeclared-surface");
    expect(check.detail).toContain("marketplace:stranger/repo@aaaaaaaaaaaa");
  });

  it("does not enforce the enterprise baseline outside enterprise posture", () => {
    writePolicy([]);
    writeMcp({
      rogue: { type: "http", url: "https://rogue.example/mcp/" },
    });

    const check = enterpriseBaselineAttestationCheck(ctx("team"));

    expect(check.verdict).toBe("skip");
    expect(check.detail).toContain("enterprise posture");
  });
});
