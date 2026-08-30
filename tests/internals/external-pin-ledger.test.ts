import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CISCO_MCP_SCANNER_VERSION,
  CISCO_SKILL_SCANNER_VERSION,
  SEMGREP_VERSION,
} from "../../src/baseline-evidence/analyzer-profile.js";
import { coreOwnedEccCodexMcpServers } from "../../src/ecc/codex.js";
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
  /**
   * Set only when `integrity` does NOT cover the artifact that executes — the
   * distributed package is a launcher that fetches its real payload at run time.
   * Absent is the normal case: the hash covers what runs.
   */
  integrityCovers?: "launcher-only";
  disposition: "active" | "retained" | "blocked";
  reason?: string;
}

/**
 * Ledger surfaces that back a pinned MCP catalog server, mapped to the catalog key
 * (they differ: `playwright-mcp` is generated as `playwright`). These are the
 * launches whose integrity-coverage claim has to agree with their declared egress.
 */
const PINNED_MCP_SURFACES: Readonly<Record<string, string>> = {
  "code-review-graph": "code-review-graph",
  "codebase-memory-mcp": "codebase-memory-mcp",
  "sequential-thinking": "sequential-thinking",
  "playwright-mcp": "playwright",
};

const root = resolve(import.meta.dirname, "../..");
const ledger = JSON.parse(
  readFileSync(resolve(root, "src/internals/external-pin-ledger.json"), "utf8"),
) as {
  schemaVersion: number;
  verifiedAt: string;
  verifiedAtPolicy: string;
  historicalEvidencePolicy: string;
  integrityCoveragePolicy: string;
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
      (source) => source.owner === "samartomar" && source.repo === "ECC",
    );
    const superpowers = baseline.sources.find(
      (source) => source.owner === "obra" && source.repo.toLowerCase() === "superpowers",
    );

    expect(entry("ecc").commit).toBe(ecc?.pinnedSha);
    expect(entry("superpowers").commit).toBe(superpowers?.pinnedSha);
  });

  it("binds refreshed MCP and repo-tool runtimes to production generators", () => {
    expect(ledger.schemaVersion).toBe(1);
    // Scope, not staleness: `verifiedAt` dates the last reconciliation that covered
    // EVERY entry, so a single-surface re-vet records its date in that entry's reason
    // and leaves this pinned (see #716/#723, which did exactly that). The policy string
    // is asserted beside it so the distinction cannot be dropped without a failing test.
    expect(ledger.verifiedAt).toBe("2026-08-14");
    expect(ledger.verifiedAtPolicy).toMatch(/covered EVERY entry/);
    expect(ledger.verifiedAtPolicy).toMatch(/does not move this field/i);
    expect(ledger.historicalEvidencePolicy).toMatch(/immutable history/i);

    // The explicit temporary bridge is exactly one commit past upstream v2.2.0.
    expect(entry("ecc")).toMatchObject({
      identity: "samartomar/ECC",
      version: "v2.2.0-1-g5caf398a",
      commit: "5caf398a91599029a176ca6d806409b00d1052c4",
      disposition: "active",
    });
    expect(entry("ecc").reason).toMatch(/administrator-owned fork.*governed run 33147078833/i);
    expect(entry("ecc-candidate")).toMatchObject({
      identity: "affaan-m/ECC",
      version: "v2.2.0-128-gce64e417",
      commit: "ce64e417fd420a0df98ed0aa00809eea5e74e127",
      disposition: "blocked",
    });
    expect(entry("ecc-candidate").reason).toMatch(/OpenCode.*hook-runtime consent/i);
    expect(entry("ecc-candidate").reason).toMatch(/Docker.*link\.exe/i);
    expect(entry("ecc-candidate").reason).toMatch(/nothing was promoted/i);
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
    expect(entry("ecc-codex-chrome-devtools-mcp")).toMatchObject({
      identity: "chrome-devtools-mcp",
      version: "1.7.0",
      integrity:
        "sha512-6xFW7oiUxTxZuHcfyYBkKQtmttjCbfifKZMSEk5CV8H2FucvKweYiJr8CblddYHtYjA4C14K9VAs1r49906RBA==",
      disposition: "active",
    });
    const chromeDevtools = coreOwnedEccCodexMcpServers()["chrome-devtools"];
    if (chromeDevtools?.type !== "stdio") throw new Error("missing Core-owned Chrome DevTools MCP");
    expect(entry("ecc-codex-chrome-devtools-mcp").version).toBe(
      versionFromSpec(chromeDevtools.args[1] ?? ""),
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

  it("declares launcher-shim pins honestly and never as zero egress", () => {
    const servers = mcpServers("standard", webStack, { selfHost: true });

    // codebase-memory-mcp's PyPI wheel is an ~8 KB launcher: its _cli.py fetches the
    // platform release archive from GitHub on first run and exec's the unpacked ~273 MB
    // binary. The recorded integrity is the WHEEL's, so it cannot cover what executes.
    const memory = entry("codebase-memory-mcp");
    expect(memory.integrityCovers).toBe("launcher-only");
    expect(memory.reason).toMatch(/launcher shim/i);
    expect(memory.reason).toMatch(/does not cover the executed artifact/i);
    // Closing the fail-open checksum step is WHY this pin moved off 0.9.0, so the
    // reason has to keep saying the shipped shim verifies fail-closed. If a future
    // bump ever lands on a fail-open shim again, this assertion is the tripwire.
    expect(memory.reason).toMatch(/_verify_checksum is fail-closed/i);
    expect(memory.reason).toMatch(/--offline governs uv wheel resolution only/i);

    // The invariant the marker exists to enforce: provisioning is real egress, so a
    // launcher-only pin may not also be declared `egress: "none"` in the catalog.
    expect(ledger.integrityCoveragePolicy).toMatch(/launcher-only/);
    for (const [surface, serverName] of Object.entries(PINNED_MCP_SURFACES)) {
      const server = servers[serverName];
      if (server === undefined) throw new Error(`missing catalog MCP server: ${serverName}`);
      if (entry(surface).integrityCovers !== "launcher-only") continue;
      expect(server.egress).not.toBe("none");
    }
    expect(servers["codebase-memory-mcp"]?.egress).toBe("vendor-incumbent");

    // The other pinned MCP packages were re-probed and are NOT launchers: the
    // code-review-graph wheel carries its own 73-file implementation, the
    // sequential-thinking tarball is its whole server, and @playwright/mcp re-exports
    // an exactly-pinned npm dependency rather than fetching code out of band. If a
    // future pin turns into a shim, this list is what forces the decision.
    for (const surface of ["code-review-graph", "sequential-thinking", "playwright-mcp"]) {
      expect(entry(surface).integrityCovers).toBeUndefined();
    }
    expect(servers["code-review-graph"]?.egress).toBe("none");
    expect(servers["sequential-thinking"]?.egress).toBe("none");
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
    expect(entry("uv")).toMatchObject({ version: "0.12.7", disposition: "active" });
    expect(entry("uv").reason).toMatch(/five committed locks.*byte-identical/i);
    expect(entry("uv").reason).toMatch(/Cisco.*link\.exe/i);
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
    expect(entry("claude-code-action").version).toBe("v1.0.210");

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
    expect(entry("sbom-action")).toMatchObject({
      ...workflowActionPin(releaseWorkflow, "anchore/sbom-action"),
      disposition: "active",
    });
    expect(entry("sbom-action").version).toBe("v0.24.2");
    expect(entry("sbom-action").reason).toMatch(/pins.*Syft installer.*release tag/i);
    expect(entry("attest-build-provenance-action")).toMatchObject({
      ...workflowActionPin(releaseWorkflow, "actions/attest-build-provenance"),
      disposition: "active",
    });
  });

  it("binds the vendor evidence download action to the governed external pin ledger", () => {
    const vendorEvidenceWorkflow = readFileSync(
      resolve(root, ".github/workflows/vendor-baseline-evidence.yml"),
      "utf8",
    );
    expect(entry("download-artifact-action")).toMatchObject({
      ...workflowActionPin(vendorEvidenceWorkflow, "actions/download-artifact"),
      disposition: "active",
    });
    expect(entry("download-artifact-action").reason).toMatch(/exact reviewed pin.*v8/i);
    expect(entry("download-artifact-action").reason).toMatch(/digest mismatch.*fail/i);
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
    expect(entry("codeql-action").version).toBe("v4.37.9");
    expect(entry("codeql-action").reason).toMatch(/codeql-bundle-v2\.26\.4/i);
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
    const snyk = entry("snyk-agent-scan");
    expect(snyk).toMatchObject({
      version: "0.5.17",
      integrity: "sha256:ae928b023023fba12fdaaaa31e9da5dad4252c181545dfba72d46534d694b935",
      disposition: "active",
    });
    expect(snyk.reason).toContain(
      "https://github.com/samartomar/ai-harness/actions/runs/31828959167",
    );
    expect(snyk.reason).toContain("b4c76cbc88ff300c1f3e241e9b9c1f25ef921760");
    expect(snyk.reason).toContain("snyk-agent-scan@uv:0.5.17");
    expect(snyk.reason).toContain("status=qualified");
    expect(snyk.reason).toContain(
      "sha256:31259b2a91f04c092a87be560907136d8263861d1f32c8818564a40217bad4d0",
    );
    expect(snyk.reason).toContain(
      "sha256:22e5dc96b689af87589b32f96570a0da407a6562281d7c94021c57b849737daa",
    );
    expect(snyk.reason).toContain("synthetic fixture");
    expect(entry("semgrep")).toMatchObject({
      version: SEMGREP_VERSION,
      commit: "abce3b5391706850837d4339f84bfaa3ec08604b",
      integrity: "sha256:95e504f01bf9ae20c23359a76bf9ada3e10c88906de58964f489e6332753260a",
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
    // The dependency blocker is no longer the only one: 1.0.27's own wheel and
    // sdist are yanked, so the pinned version fails on its own terms even if the
    // diagram constraint were ever satisfiable again. Recording only the
    // dependency would understate why this entry stays blocked.
    expect(entry("aws-core-mcp-server").reason).toMatch(/itself yanked/i);
    expect(entry("aws-core-mcp-server").reason).toMatch(/load individual MCPs/i);
    expect(entry("setup-python-action")).toMatchObject({
      identity: "actions/setup-python",
      version: "v7.0.0",
      commit: "5fda3b95a4ea91299a34e894583c3862153e4b97",
      disposition: "active",
    });
    expect(entry("serena").reason).toMatch(
      /locked Serena 1\.7\.0 version.*offline help.*offline import/i,
    );
    expect(entry("token-savior").reason).toMatch(
      /Python 3\.13.*memory and shell hooks disabled.*entry-point/i,
    );
    expect(entry("token-optimizer").reason).toMatch(
      /PolyForm Noncommercial.*Codex and Claude.*rollback/i,
    );
  });

  it("documents explicit retained and qualified-runner decisions", () => {
    expect(entry("skillspector")).toMatchObject({
      commit: "2d198ab910add401cad658d1087e7c7ba24fd640",
      integrity: "sha256:c5d4a1816419f129ae85ff96b3e366d4a062c1859997e26b7ab87341a43d4800",
      disposition: "active",
    });
    // A rotation is only trustworthy if the method was validated against a known
    // answer first, so the reason must carry that validation, the reproduction
    // count, and the perturbation control that proves the cutoff is load-bearing.
    expect(entry("skillspector").reason).toMatch(
      /method validated against a known answer first.*reproduced its committed\s+sha256:108b707c/i,
    );
    expect(entry("skillspector").reason).toMatch(/reproduced five times/i);
    expect(entry("skillspector").reason).toMatch(
      /cutoff moved 2026-08-07 -> 2026-08-15T00:00:00Z.*perturbation control holds.*sha256:8b13ea26/i,
    );
    // The YR4 carve-out equivalence must be restated at every rotation.
    expect(entry("skillspector").reason).toMatch(
      /all five yara_rules blobs and LICENSE carry identical git\s+SHAs at both tags/i,
    );
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

    // The ECC candidate is recorded blocked WITHOUT moving the active pin, so the
    // two entries must keep disagreeing on commit: a candidate that silently
    // matched baseline-sources would mean the rotation happened.
    expect(entry("ecc-candidate")).toMatchObject({
      identity: "affaan-m/ECC",
      version: "v2.2.0-128-gce64e417",
      commit: "ce64e417fd420a0df98ed0aa00809eea5e74e127",
      disposition: "blocked",
    });
    expect(entry("ecc-candidate").commit).not.toBe(entry("ecc").commit);
    expect(entry("ecc-candidate").reason).toMatch(
      /ECC_OPENCODE_HOOK_CONSENT_AND_FULL_VET_UNQUALIFIED/,
    );
    // Live exact-SHA state, the local evidence boundary, and the consent defect
    // are all load-bearing. Losing any one would make the HOLD unauditable.
    expect(entry("ecc-candidate").reason).toMatch(/33 completed successes, 12 queued.*45/i);
    expect(entry("ecc-candidate").reason).toMatch(/static AIH baseline preflight passed/i);
    expect(entry("ecc-candidate").reason).toMatch(/full vet emitted no evidence/i);
    expect(entry("ecc-candidate").reason).toMatch(/Docker.*link\.exe/i);
    expect(entry("ecc-candidate").reason).toMatch(/opencode\.json auto-loads plugins/i);
    expect(entry("ecc-candidate").reason).toMatch(/not evidence of a categorical block/i);
    expect(entry("ecc-candidate").reason).toMatch(/production lock.*unchanged/i);
    expect(entry("ecc-candidate").reason).toMatch(/dcbf95bf.*immutable history/i);
  });
});
