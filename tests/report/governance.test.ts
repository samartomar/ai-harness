import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectContract } from "../../src/contract/schema.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { governanceRollupDigest } from "../../src/report/governance.js";
import { mcpGovernanceSummary } from "../../src/report/mcp-governance.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-report-governance-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
    posture: "vibe",
    postureSource: "default",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    ...over,
  };
}

const CONTRACT: ProjectContract = {
  schemaVersion: 1,
  contextDir: "ai-coding",
  targets: [],
  languages: ["TypeScript"],
  frameworks: [],
  cloud: [],
  databases: [],
  deployment: [],
  entrypoints: ["../escape"],
  mcpServers: [],
  commands: {},
  scale: { class: "small", isMonorepo: false },
  sensitivePaths: [],
  knownGaps: [],
};

function writeContract(value: ProjectContract): void {
  mkdirSync(join(dir, "ai-coding"), { recursive: true });
  writeFileSync(join(dir, "ai-coding", "project.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function controls(digest: ReturnType<typeof governanceRollupDigest>) {
  return (
    digest.data as {
      controls: Array<{ control: string; verdict: string; detail: string; count?: number }>;
    }
  ).controls;
}

describe("governanceRollupDigest", () => {
  it("omits path-portability when no repo contract is committed", () => {
    const d = governanceRollupDigest(ctx());
    expect(d.describe).toContain("Governance roll-up");
    expect(d.text).toContain("Active posture: vibe");
    expect(controls(d).map((c) => c.control)).not.toContain("path-portability");
  });

  it("grades secrets and contract path-portability under the active posture", () => {
    writeFileSync(join(dir, ".env"), "API_KEY=sk-nope-nope-nope\n");
    writeContract(CONTRACT);
    const d = governanceRollupDigest(ctx({ posture: "team", postureSource: "flag" }));
    const byControl = Object.fromEntries(controls(d).map((c) => [c.control, c.verdict]));

    expect(byControl.secrets).toBe("deny");
    expect(byControl["path-portability"]).toBe("deny");
    expect(d.text).toContain("team");
    expect(d.text).toContain("plaintext");
  });

  it("marks CA trust as enterprise-deny until a trust env var is present", () => {
    const team = governanceRollupDigest(ctx({ posture: "team" }));
    const missing = governanceRollupDigest(ctx({ posture: "enterprise" }));
    const configured = governanceRollupDigest(
      ctx({ posture: "enterprise", env: { NODE_EXTRA_CA_CERTS: "/corp/root.pem" } }),
    );

    const teamCa = controls(team).find((c) => c.control === "ca-trust");
    const missingCa = controls(missing).find((c) => c.control === "ca-trust");
    const configuredCa = controls(configured).find((c) => c.control === "ca-trust");

    expect(teamCa?.verdict).toBe("warn");
    expect(missingCa?.verdict).toBe("deny");
    expect(configuredCa?.verdict).toBe("allow");
  });

  it("does not count unrelated JVM options as CA trust", () => {
    const unrelated = governanceRollupDigest(
      ctx({ posture: "enterprise", env: { JAVA_TOOL_OPTIONS: "-Xmx2g" } }),
    );
    const configured = governanceRollupDigest(
      ctx({
        posture: "enterprise",
        env: { JAVA_TOOL_OPTIONS: "-Djavax.net.ssl.trustStore=/corp/corporate-cacerts.jks" },
      }),
    );

    expect(controls(unrelated).find((c) => c.control === "ca-trust")?.verdict).toBe("deny");
    expect(controls(configured).find((c) => c.control === "ca-trust")?.verdict).toBe("allow");
  });

  it("reuses the MCP governance summary under the active posture", () => {
    const planCtx = ctx({ posture: "enterprise" });
    const summary = mcpGovernanceSummary(planCtx, "enterprise");
    const mcp = controls(governanceRollupDigest(planCtx)).find((c) => c.control === "mcp");

    expect(mcp?.verdict).toBe("deny");
    expect(mcp?.detail).toContain(
      `${summary.counts.allowed} allowed, ${summary.counts.warned} warn, ${summary.counts.denied} denied under enterprise`,
    );
    expect(mcp?.count).toBe(summary.counts.allowed + summary.counts.warned + summary.counts.denied);
  });

  it("uses org-policy MCP egress and disabled-server rules in the summary", () => {
    writeFileSync(
      join(dir, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: { incumbentHosts: [], disabledServers: ["context7"] },
      }),
    );

    const summary = mcpGovernanceSummary(ctx({ posture: "enterprise" }), "enterprise");

    expect(summary.denied.map((p) => p.name)).toContain("github");
    expect(summary.denied).toContainEqual(
      expect.objectContaining({
        name: "context7",
        reason: expect.stringContaining("disabled by org policy"),
      }),
    );
    expect(summary.allowed).not.toContain("github");
  });

  it("uses org-policy MCP approval evidence in the summary", () => {
    writeFileSync(
      join(dir, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          allowedServers: ["context7", "github"],
          approvals: [
            {
              server: "context7",
              acceptEgress: true,
              reason: "legal approved hosted docs lookup",
              reviewer: "security-platform",
              approvedAt: "2026-07-05T00:00:00.000Z",
            },
          ],
          incumbentHosts: ["api.githubcopilot.com"],
        },
      }),
    );

    const summary = mcpGovernanceSummary(ctx({ posture: "enterprise" }), "enterprise");

    expect(summary.warned).toContainEqual(
      expect.objectContaining({
        name: "context7",
        reason: expect.stringContaining("legal approved hosted docs lookup"),
      }),
    );
    expect(summary.denied).not.toContainEqual(expect.objectContaining({ name: "context7" }));
  });

  it("reports disabled GitHub without consulting invalid ambient GITHUB_HOST", () => {
    writeFileSync(
      join(dir, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: { disabledServers: ["github"] },
      }),
    );

    const summary = mcpGovernanceSummary(
      ctx({ posture: "enterprise", env: { GITHUB_HOST: "github.internal.example" } }),
      "enterprise",
    );

    expect(summary.denied).not.toContainEqual(expect.objectContaining({ name: "catalog" }));
    expect(summary.denied).toContainEqual(
      expect.objectContaining({
        name: "github",
        reason: expect.stringContaining("disabled by org policy"),
      }),
    );
  });

  it("fails closed instead of falling back when the MCP catalog cannot be built", () => {
    const summary = mcpGovernanceSummary(
      ctx({ posture: "enterprise", env: { GITHUB_HOST: "github.internal.example" } }),
      "enterprise",
    );

    expect(summary.allowed).not.toContain("github");
    expect(summary.denied).toContainEqual(
      expect.objectContaining({
        name: "catalog",
      }),
    );
  });

  it("keeps command policy posture-graded while risk gates stay warn", () => {
    const vibe = Object.fromEntries(
      controls(governanceRollupDigest(ctx({ posture: "vibe" }))).map((c) => [c.control, c.verdict]),
    );
    const enterprise = Object.fromEntries(
      controls(governanceRollupDigest(ctx({ posture: "enterprise" }))).map((c) => [
        c.control,
        c.verdict,
      ]),
    );

    expect(vibe["command-policy"]).toBe("warn");
    expect(vibe["risk-gates"]).toBe("warn");
    expect(enterprise["command-policy"]).toBe("deny");
    expect(enterprise["risk-gates"]).toBe("warn");
  });
});
