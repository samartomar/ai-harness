import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CISCO_MCP_SCANNER_VERSION,
  CISCO_SKILL_SCANNER_VERSION,
  SEMGREP_VERSION,
  SNYK_AGENT_SCAN_VERSION,
} from "../../src/baseline-evidence/analyzer-profile.js";
import { CHECKOUT_ACTION_PIN } from "../../src/guardrails/sca.js";
import { BASELINE_SOURCES } from "../../src/internals/baseline-sources.js";
import { mcpServers, type StdioServer } from "../../src/mcp/servers.js";
import type { RepoStack } from "../../src/profile/scan.js";
import { SKILLSPECTOR_IMAGE_DIGEST, SKILLSPECTOR_SOURCE_REVISION } from "../../src/trust/images.js";

interface LedgerEntry {
  surface: string;
  identity: string;
  version?: string;
  commit?: string;
  integrity?: string;
  disposition: "active" | "retained" | "blocked";
  reason?: string;
}

const root = resolve(import.meta.dirname, "../..");
const ledger = JSON.parse(
  readFileSync(resolve(root, "src/internals/external-pin-ledger.json"), "utf8"),
) as {
  schemaVersion: number;
  verifiedAt: string;
  historicalEvidencePolicy: string;
  entries: LedgerEntry[];
};

function entry(surface: string): LedgerEntry {
  const found = ledger.entries.find((candidate) => candidate.surface === surface);
  if (found === undefined) throw new Error(`missing external-pin ledger entry: ${surface}`);
  return found;
}

function toolingPlan(): {
  pins: {
    serena: { package: string };
    tokenOptimizer: { tag: string; commit: string };
    tokenSavior: { package: string };
  };
} {
  return JSON.parse(
    execFileSync(process.execPath, ["tools/repo-ai-tools.mjs", "plan"], {
      cwd: root,
      encoding: "utf8",
    }),
  ) as ReturnType<typeof toolingPlan>;
}

function stdioArg(servers: ReturnType<typeof mcpServers>, name: string, prefix: string): string {
  const server = servers[name];
  if (server?.type !== "stdio") throw new Error(`missing stdio MCP server: ${name}`);
  const value = server.args.find((candidate) => candidate.startsWith(prefix));
  if (value === undefined) throw new Error(`missing ${prefix} argument for MCP server: ${name}`);
  return value;
}

function versionFromSpec(spec: string): string {
  const match = spec.match(/(?:@|==)(v?\d[^@=]*)$/);
  if (match?.[1] === undefined) throw new Error(`missing exact version in package spec: ${spec}`);
  return match[1];
}

function workflowActionPin(workflow: string, action: string): { commit: string; version: string } {
  const escaped = action.replace("/", "\\/");
  const match = workflow.match(new RegExp(`${escaped}@([0-9a-f]{40})\\s+#\\s+(v\\S+)`));
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`missing exact ${action} action pin`);
  }
  return { commit: match[1], version: match[2] };
}

const webStack: RepoStack = {
  languages: ["TypeScript"],
  frameworks: ["React"],
  cloud: [],
  databases: [],
  deployment: [],
  hasTypeScript: true,
  scripts: {},
  entryPoints: [],
  browserTest: false,
  isMonorepo: false,
};

describe("active external-pin ledger", () => {
  it("matches the approved baseline source identities used by the product", () => {
    const baseline = BASELINE_SOURCES.find((candidate) => candidate.id === "ecc");
    if (baseline === undefined) throw new Error("missing ECC baseline source");

    const ecc = baseline.sources.find(
      (source) => source.owner === "affaan-m" && source.repo.toLowerCase() === "ecc",
    );
    const superpowers = baseline.sources.find(
      (source) => source.owner === "obra" && source.repo.toLowerCase() === "superpowers",
    );

    expect(entry("ecc").commit).toBe(ecc?.pinnedSha);
    expect(entry("superpowers").commit).toBe(superpowers?.pinnedSha);
  });

  it("binds refreshed MCP and repo-tool runtimes to production generators", () => {
    expect(ledger.schemaVersion).toBe(1);
    expect(ledger.verifiedAt).toBe("2026-08-14");
    expect(ledger.historicalEvidencePolicy).toMatch(/immutable history/i);

    // The ECC pin is 32 untagged commits past v2.1.0, which is still ECC's
    // newest tag, so the entry must not claim a release it is not.
    expect(entry("ecc")).toMatchObject({
      identity: "affaan-m/ECC",
      version: "untagged, 32 commits past v2.1.0",
      commit: "623f2c020f052319657674e4e6c29ab5d0ad566b",
      disposition: "active",
    });
    expect(entry("superpowers")).toMatchObject({
      identity: "obra/Superpowers",
      commit: "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9",
      disposition: "active",
    });
    // The previous reconciliation deliberately did NOT promote the refresh
    // candidate; this one does, so the recorded reason has to say so.
    expect(entry("superpowers").reason).toMatch(/rebound from v6\.1\.1 to the v6\.2\.0/i);
    const servers = mcpServers("standard", webStack, { selfHost: true });
    expect(entry("code-review-graph").version).toBe(
      versionFromSpec(stdioArg(servers, "code-review-graph", "code-review-graph@")),
    );
    expect(entry("codebase-memory-mcp").version).toBe(
      versionFromSpec(stdioArg(servers, "codebase-memory-mcp", "codebase-memory-mcp@")),
    );
    expect(entry("sequential-thinking").version).toBe(
      versionFromSpec(
        stdioArg(
          servers,
          "sequential-thinking",
          "@modelcontextprotocol/server-sequential-thinking@",
        ),
      ),
    );
    expect(entry("sequential-thinking").reason).toMatch(
      /initialize online.*offline cache.*server version 0\.2\.0/i,
    );
    expect(entry("playwright-mcp").version).toBe(
      versionFromSpec(stdioArg(servers, "playwright", "@playwright/mcp@")),
    );
    expect(entry("playwright-mcp").reason).toMatch(
      /initialize online.*offline cache.*Playwright build 1\.63\.0-alpha-2026-08-05/i,
    );

    const github = servers.github as StdioServer;
    const githubImage = github.args.find((candidate) => candidate.startsWith("ghcr.io/github/"));
    expect(githubImage).toBeDefined();
    expect(entry("github-mcp-container").integrity).toBe(githubImage?.split("@")[1]);

    const plan = toolingPlan();
    expect(entry("serena").version).toBe(versionFromSpec(plan.pins.serena.package));
    expect(entry("token-savior").version).toBe(versionFromSpec(plan.pins.tokenSavior.package));
    expect(entry("token-optimizer")).toMatchObject({
      version: plan.pins.tokenOptimizer.tag,
      commit: plan.pins.tokenOptimizer.commit,
    });
  });

  it("binds refreshed build and workflow identities to production sources", () => {
    expect(entry("skillspector")).toMatchObject({
      commit: SKILLSPECTOR_SOURCE_REVISION,
      integrity: SKILLSPECTOR_IMAGE_DIGEST,
    });

    const skillspectorDockerfile = readFileSync(
      resolve(root, "tools/skillspector.Dockerfile"),
      "utf8",
    );
    const pythonBase = skillspectorDockerfile.match(
      /^ARG PYTHON_IMAGE=python:([^@\s]+)@(sha256:[0-9a-f]{64})$/m,
    );
    expect(entry("skillspector-python-base")).toMatchObject({
      version: pythonBase?.[1],
      integrity: pythonBase?.[2],
    });
    expect(entry("uv").version).toBe(
      skillspectorDockerfile.match(/pip install --no-cache-dir uv==([^\s]+)/)?.[1],
    );
    expect(skillspectorDockerfile).toContain(
      `LABEL org.opencontainers.image.revision="${SKILLSPECTOR_SOURCE_REVISION}"`,
    );

    const checkout = CHECKOUT_ACTION_PIN.match(/^actions\/checkout@([0-9a-f]{40}) # (v\S+)$/);
    if (checkout?.[1] === undefined || checkout[2] === undefined) {
      throw new Error(`invalid generated checkout action pin: ${CHECKOUT_ACTION_PIN}`);
    }
    expect(entry("actions-checkout")).toMatchObject({
      version: checkout[2],
      commit: checkout[1],
    });

    const claudeWorkflow = readFileSync(resolve(root, ".github/workflows/claude.yml"), "utf8");
    const claude = claudeWorkflow.match(/anthropics\/claude-code-action@([0-9a-f]{40})/);
    expect(entry("claude-code-action")).toMatchObject({
      commit: claude?.[1],
    });
    expect(entry("claude-code-action").version).toBe("v1.0.191");

    const baselineWorkflow = readFileSync(
      resolve(root, ".github/workflows/baseline-evidence.yml"),
      "utf8",
    );
    expect(entry("setup-python-action")).toMatchObject(
      workflowActionPin(baselineWorkflow, "actions/setup-python"),
    );
  });

  it("binds the release provenance action to the governed external pin ledger", () => {
    const releaseWorkflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
    expect(entry("attest-build-provenance-action")).toMatchObject({
      ...workflowActionPin(releaseWorkflow, "actions/attest-build-provenance"),
      disposition: "active",
    });
  });

  it("binds every CodeQL workflow action to one governed ledger identity", () => {
    const workflows = [
      readFileSync(resolve(root, ".github/workflows/codeql.yml"), "utf8"),
      readFileSync(resolve(root, ".github/workflows/scorecard.yml"), "utf8"),
    ].join("\n");
    const pins = [
      ...workflows.matchAll(
        /github\/codeql-action\/(?:init|analyze|upload-sarif)@([0-9a-f]{40}) # (v\S+)/g,
      ),
    ];

    expect(pins).toHaveLength(3);
    for (const pin of pins) {
      expect(entry("codeql-action")).toMatchObject({
        commit: pin[1],
        version: pin[2],
      });
    }
  });

  it("records governed scanner identities and fails closed on AgentShield provenance", () => {
    expect(entry("cisco-skill-scanner")).toMatchObject({
      version: CISCO_SKILL_SCANNER_VERSION,
      integrity: "sha256:d81fde291d60b6f8134375c33b49a2f41f5bb3072b74153dafea4774d627a837",
      disposition: "active",
    });
    expect(entry("cisco-mcp-scanner")).toMatchObject({
      version: CISCO_MCP_SCANNER_VERSION,
      integrity: "sha256:ee96cc8e7d4641a5b96047552c426a9a7d6d2736a65a4bcbd77797f2f1add202",
      disposition: "active",
    });
    expect(entry("snyk-agent-scan")).toMatchObject({
      version: SNYK_AGENT_SCAN_VERSION,
      integrity: "sha256:4983e6d54168fc10237677478255826ab7d474e934e88c6bbb5c8d8928127017",
      disposition: "blocked",
    });
    expect(entry("semgrep")).toMatchObject({
      version: SEMGREP_VERSION,
      disposition: "active",
    });
    expect(entry("agentshield")).toMatchObject({
      version: "0.1.2",
      disposition: "blocked",
    });
    expect(entry("agentshield").reason).toMatch(/advertised.*404/i);
    expect(entry("aws-core-mcp-server")).toMatchObject({
      identity: "awslabs.core-mcp-server",
      version: "1.0.27",
      disposition: "blocked",
    });
    expect(entry("aws-core-mcp-server").reason).toMatch(/diagram.*yanked.*Agent Toolkit/i);
    expect(entry("setup-python-action")).toMatchObject({
      identity: "actions/setup-python",
      version: "v7.0.0",
      commit: "5fda3b95a4ea91299a34e894583c3862153e4b97",
      disposition: "active",
    });
    expect(entry("serena").reason).toMatch(/Python 3\.13.*no-memories.*symbol overview/i);
    expect(entry("token-savior").reason).toMatch(
      /Python 3\.13.*memory and shell hooks disabled.*entry-point/i,
    );
    expect(entry("token-optimizer").reason).toMatch(
      /PolyForm Noncommercial.*Codex and Claude.*rollback/i,
    );
  });

  it("documents explicit retained and qualified-runner decisions", () => {
    expect(entry("skillspector")).toMatchObject({
      commit: "0562b964ec5ceac67ee15c163738e5404f14a908",
      integrity: "sha256:108b707cb98cb418680782f9745942b1d3904104a45d8f6fd62f102672285d55",
      disposition: "active",
    });
    expect(entry("skillspector").reason).toMatch(/two clean cache-disabled OCI exports/i);
    expect(entry("anthropic-skills-guide")).toMatchObject({
      commit: "9d2f1ae187231d8199c64b5b762e1bdf2244733d",
      disposition: "retained",
    });
    expect(entry("anthropic-skills").reason).toMatch(
      /RED, degraded.*201 failing.*Cisco and Semgrep completed.*SkillSpector timed out.*Snyk/i,
    );
    expect(entry("ui-ux-pro-max-skill-guide")).toMatchObject({
      commit: "12b486b22e67f5d887962ef8351c1ac863bfaeb9",
      disposition: "retained",
    });
    expect(entry("ui-ux-pro-max-skill").reason).toMatch(
      /RED, degraded.*186 failing.*Cisco and Semgrep completed.*SkillSpector timed out.*Snyk/i,
    );
    expect(entry("aws-mcp-guide-source").reason).toMatch(/Agent Toolkit for AWS/i);
  });
});
