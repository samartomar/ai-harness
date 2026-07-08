import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enterpriseBaselineAttestationCheck } from "../../src/baseline/attestation.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { spanningMcp } from "../../src/workspace/templates.js";

let dir: string;
const A_SHA = "a".repeat(40);
const B_SHA = "b".repeat(40);
const CODE_REVIEW_GRAPH_ARGS = [
  "--offline",
  "--no-python-downloads",
  "--no-env-file",
  "code-review-graph@2.3.6",
  "serve",
] as const;

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

function writeJson(rel: string, value: unknown): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function writeText(rel: string, value: string): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}

function writeMcp(servers: Record<string, unknown>): void {
  writeMcpConfig(".mcp.json", { mcpServers: servers });
}

function writeMcpConfig(rel: string, config: unknown): void {
  writeJson(rel, config);
}

function writeWorkspaceManifest(repos: string[]): void {
  writeFileSync(
    join(dir, ".aih-workspace.json"),
    JSON.stringify({
      schemaVersion: 1,
      workspaceType: "multi-repo",
      graphScope: "combined-child-repos",
      contextDir: "ai-coding",
      repos,
      generatedBy: "aih workspace",
    }),
  );
}

function writeMarketplaceSkill(
  source = `owner/repo@${A_SHA}`,
  commit = A_SHA,
  name = "clean",
): void {
  mkdirSync(join(dir, ".aih", "marketplace"), { recursive: true });
  writeFileSync(
    join(dir, ".aih", "marketplace", "marketplace.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "acme-skills",
      skills: [
        {
          name,
          source,
          commit,
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
  it("fails closed when external surfaces exist without a declared registry", () => {
    writeMcp({
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
      },
    });

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check).toMatchObject({
      verdict: "fail",
      code: "baseline.registry-missing",
    });
    expect(check.detail).toContain("mcp:github");
    expect(check.detail).toContain("aih-org-policy.json");
  });

  it("fails closed when an MCP config is malformed JSON", () => {
    writeText(".mcp.json", "{not-json");

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check).toMatchObject({
      verdict: "fail",
      code: "baseline.registry-invalid",
    });
    expect(check.detail).toContain(".mcp.json is not valid JSON");
  });

  it("fails closed when the marketplace manifest is malformed", () => {
    writeText(".aih/marketplace/marketplace.json", "{not-json");

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check).toMatchObject({
      verdict: "fail",
      code: "baseline.registry-invalid",
    });
    expect(check.detail).toContain("marketplace artifact cannot be parsed");
  });

  it("fails closed when marketplace attestation would read through a linked path", () => {
    const outside = mkdtempSync(join(tmpdir(), "aih-baseline-marketplace-outside-"));
    try {
      mkdirSync(join(dir, ".aih"), { recursive: true });
      symlinkSync(
        outside,
        join(dir, ".aih", "marketplace"),
        process.platform === "win32" ? "junction" : "dir",
      );
      writeFileSync(join(outside, "marketplace.json"), JSON.stringify({ schemaVersion: 1 }));

      const check = enterpriseBaselineAttestationCheck(ctx());

      expect(check).toMatchObject({
        verdict: "fail",
        code: "baseline.registry-invalid",
      });
      expect(check.detail).toContain("contained regular file");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("fails closed when the declared registry cannot be read", () => {
    writeText("aih-org-policy.json", "{not-json");
    writeMcp({
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
      },
    });

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check).toMatchObject({
      verdict: "fail",
      code: "baseline.registry-invalid",
    });
    expect(check.detail).toContain("declared capability registry cannot be read");
  });

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

  it("attests MCP surfaces from non-root config files", () => {
    writePolicy([]);
    writeMcpConfig(".cursor/mcp.json", {
      mcpServers: {
        rogue: {
          type: "http",
          url: "https://rogue.example/mcp/",
        },
      },
    });

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check).toMatchObject({
      verdict: "fail",
      code: "baseline.undeclared-surface",
    });
    expect(check.detail).toContain("mcp:rogue @ .cursor/mcp.json");
  });

  it("fails closed when MCP attestation would read through a linked config path", () => {
    const outside = mkdtempSync(join(tmpdir(), "aih-baseline-mcp-outside-"));
    try {
      symlinkSync(outside, join(dir, ".cursor"), process.platform === "win32" ? "junction" : "dir");
      writeFileSync(
        join(outside, "mcp.json"),
        JSON.stringify({ mcpServers: { rogue: { type: "http", url: "https://rogue.example" } } }),
      );

      const check = enterpriseBaselineAttestationCheck(ctx());

      expect(check).toMatchObject({
        verdict: "fail",
        code: "baseline.registry-invalid",
      });
      expect(check.detail).toContain(".cursor/mcp.json must be a contained regular file");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("attests OpenCode MCP maps by their normalized command and remote shapes", () => {
    writePolicy(["code-review-graph", "context7"]);
    writeMcpConfig("opencode.json", {
      mcp: {
        "code-review-graph": {
          type: "local",
          command: ["uvx", ...CODE_REVIEW_GRAPH_ARGS],
          enabled: true,
        },
        context7: {
          type: "remote",
          url: "https://mcp.context7.com/mcp",
          enabled: true,
        },
      },
    });

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check.verdict).toBe("pass");
    expect(check.detail).toContain("mcp:code-review-graph @ opencode.json");
    expect(check.detail).toContain("mcp:context7 @ opencode.json");
  });

  it("rejects name-only MCP declarations when the configured endpoint drifts", () => {
    writePolicy(["github"]);
    writeMcp({
      github: {
        type: "http",
        url: "https://evil.example/mcp/",
      },
    });

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check).toMatchObject({
      verdict: "fail",
      code: "baseline.undeclared-surface",
    });
    expect(check.detail).toContain("mcp:github @ .mcp.json");
  });

  it("uses catalog authority instead of self-reported MCP risk metadata", () => {
    writePolicy(["github"]);
    writeMcp({
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        egress: "none",
        credentials: "none",
        supplyChain: "pinned",
      },
    });

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check.verdict).toBe("pass");
    expect(check.detail).toContain("mcp:github @ .mcp.json");
    expect(check.detail).toContain("third-party/oauth/hosted-remote");
    expect(check.detail).not.toContain("none/none/pinned");
  });

  it("accepts generated token-auth GitHub MCP shape when declared", () => {
    writePolicy(["github"]);
    writeMcp({
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: {
          Authorization: "Bearer $" + "{GITHUB_PERSONAL_ACCESS_TOKEN}",
        },
      },
    });

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check.verdict).toBe("pass");
    expect(check.detail).toContain("mcp:github @ .mcp.json");
    expect(check.detail).toContain("third-party/token/hosted-remote");
  });

  it("accepts generated self-host GitHub MCP shape when declared", () => {
    writePolicy(["github"]);
    writeMcp({
      github: {
        type: "stdio",
        command: "docker",
        args: [
          "run",
          "-i",
          "--rm",
          "-e",
          "GITHUB_PERSONAL_ACCESS_TOKEN",
          "ghcr.io/github/github-mcp-server:v1.5.0",
        ],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$" + "{GITHUB_PERSONAL_ACCESS_TOKEN}" },
      },
    });

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check.verdict).toBe("pass");
    expect(check.detail).toContain("mcp:github @ .mcp.json");
    expect(check.detail).toContain("vendor-incumbent/token/pinned");
  });

  it("accepts generated remote-scope MCP servers when declared", () => {
    writePolicy(["better-email"]);
    writeMcp({
      "better-email": {
        type: "http",
        url: "https://better-email-mcp.n24q02m.com/mcp",
      },
    });

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check.verdict).toBe("pass");
    expect(check.detail).toContain("mcp:better-email @ .mcp.json");
    expect(check.detail).toContain("third-party/oauth/hosted-remote");
  });

  it("emits a positive attestation when every external surface is a registry member", () => {
    writePolicy(["github", "context7"], [{ owner: "owner", repo: "repo", pinnedSha: A_SHA }]);
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
    expect(check.detail).toContain("third-party/oauth/hosted-remote");
    expect(check.detail).toContain("mcp:context7");
    expect(check.detail).toContain("marketplace:owner/repo@aaaaaaaaaaaa");
  });

  it("flags marketplace skills whose source is not registered", () => {
    writePolicy([]);
    writeMarketplaceSkill(`stranger/repo@${A_SHA}`);

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check.verdict).toBe("fail");
    expect(check.code).toBe("baseline.undeclared-surface");
    expect(check.detail).toContain("marketplace:stranger/repo@aaaaaaaaaaaa");
  });

  it("sanitizes unsafe marketplace source labels before reporting them", () => {
    writePolicy([]);
    writeMarketplaceSkill(`owner/repo\u001b[31m@${A_SHA}`);

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check.verdict).toBe("fail");
    expect(check.code).toBe("baseline.undeclared-surface");
    expect(check.detail).toContain("marketplace:");
    expect(check.detail).not.toContain("\u001b");
  });

  it("sanitizes marketplace skill names before reporting metadata", () => {
    writePolicy([]);
    writeMarketplaceSkill(`stranger/repo@${A_SHA}`, A_SHA, "clean name");

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check.verdict).toBe("fail");
    expect(check.code).toBe("baseline.undeclared-surface");
    expect(check.detail).toContain("clean-name/GREEN");
    expect(check.detail).not.toContain("clean name/GREEN");
  });

  it("fails closed when a marketplace source pin disagrees with the packaged commit", () => {
    writePolicy([], [{ owner: "owner", repo: "repo", pinnedSha: B_SHA }]);
    writeMarketplaceSkill(`owner/repo@${A_SHA}`, B_SHA);

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check).toMatchObject({
      verdict: "fail",
      code: "baseline.registry-invalid",
    });
    expect(check.detail).toContain("source pin must match");
  });

  it("matches marketplace approved sources case-insensitively by owner and repo", () => {
    writePolicy([], [{ owner: "Owner", repo: "Repo", pinnedSha: A_SHA }]);
    writeMarketplaceSkill(`owner/repo@${A_SHA}`);

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check.verdict).toBe("pass");
    expect(check.detail).toContain("marketplace:owner/repo@aaaaaaaaaaaa");
  });

  it("does not treat unpinned marketplace approved sources as declared", () => {
    writePolicy([], [{ owner: "owner", repo: "repo" }]);
    writeMarketplaceSkill(`owner/repo@${A_SHA}`);

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check).toMatchObject({
      verdict: "fail",
      code: "baseline.undeclared-surface",
    });
    expect(check.detail).toContain("marketplace:owner/repo@aaaaaaaaaaaa");
  });

  it("fails closed on unsafe MCP names instead of matching their sanitized label", () => {
    writePolicy(["github"]);
    writeMcp({
      "github!": {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
      },
    });

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check.verdict).toBe("fail");
    expect(check.code).toBe("baseline.registry-invalid");
    expect(check.detail).toContain("safe registry identity");
  });

  it("ignores generated workspace graph MCP only when scoped to a declared child repo", () => {
    mkdirSync(join(dir, "ui"));
    writeWorkspaceManifest(["ui"]);
    writeMcp(spanningMcp(dir, ["ui"]).mcpServers);

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check.verdict).toBe("pass");
    expect(check.detail).toContain("no external capability surfaces discovered");
  });

  it("flags workspace graph MCP residue when the generated shape is tampered", () => {
    mkdirSync(join(dir, "ui"));
    writeWorkspaceManifest(["ui"]);
    writePolicy([]);
    const generated = spanningMcp(dir, ["ui"]).mcpServers["aih-workspace-graph-ui"] as Record<
      string,
      unknown
    >;
    writeMcp({
      "aih-workspace-graph-ui": {
        ...generated,
        env: { NODE_OPTIONS: "--require ./hook.js" },
      },
    });

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check.verdict).toBe("fail");
    expect(check.code).toBe("baseline.undeclared-surface");
    expect(check.detail).toContain("mcp:aih-workspace-graph-ui");
  });

  it("flags workspace graph MCP residue when the scoped repo is not declared", () => {
    mkdirSync(join(dir, "ui"));
    mkdirSync(join(dir, "rogue"));
    writeWorkspaceManifest(["ui"]);
    writePolicy([]);
    writeMcp({
      "aih-workspace-graph-rogue": {
        command: "uvx",
        args: [
          "--offline",
          "--no-python-downloads",
          "--no-env-file",
          "code-review-graph@2.3.6",
          "serve",
          "--repo",
          resolve(dir, "rogue"),
        ],
      },
    });

    const check = enterpriseBaselineAttestationCheck(ctx());

    expect(check.verdict).toBe("fail");
    expect(check.code).toBe("baseline.undeclared-surface");
    expect(check.detail).toContain("mcp:aih-workspace-graph-rogue");
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
