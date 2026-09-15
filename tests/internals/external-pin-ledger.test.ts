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
import {
  CODE_REVIEW_GRAPH_RUNTIME_PIN,
  CODEBASE_MEMORY_RUNTIME_PIN,
  DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
  DEFAULT_MCP_RUNTIME_PYPROJECT_SHA256,
  DEFAULT_MCP_RUNTIME_UV_LOCK_SHA256,
} from "../../src/ecc-profile/default-mcp-runtime-lock.js";
import { CHECKOUT_ACTION_PIN } from "../../src/guardrails/sca.js";
import { BASELINE_SOURCES } from "../../src/internals/baseline-sources.js";
import { mcpServers, type StdioServer } from "../../src/mcp/servers.js";
import type { RepoStack } from "../../src/profile/scan.js";
import { TOKEN_OPTIMIZER_PIN } from "../../src/tools/token-optimizer-runtime.js";
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
    tokenOptimizer: { tag: string; commit: string; tree: string };
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
      (source) => source.owner === "affaan-m" && source.repo === "ECC",
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

    // Canonical upstream retains the same exact v2.2.0 descendant.
    expect(entry("ecc")).toMatchObject({
      identity: "affaan-m/ECC",
      version: "v2.2.0-1-g5caf398a",
      commit: "5caf398a91599029a176ca6d806409b00d1052c4",
      disposition: "active",
    });
    expect(entry("ecc").reason).toMatch(/canonical upstream.*unchanged/i);
    expect(entry("ecc-candidate")).toMatchObject({
      identity: "affaan-m/ECC",
      version: "v2.2.0-147-ge04ea0b9",
      commit: "e04ea0b9cc8248686edf5ac751cadff550e162b8",
      disposition: "blocked",
    });
    expect(entry("ecc-candidate").reason).toMatch(/OpenCode.*hook-runtime consent/i);
    expect(entry("ecc-candidate").reason).toMatch(/accepts only samartomar\/ECC/i);
    expect(entry("ecc-candidate").reason).toMatch(/nothing was promoted/i);
    expect(entry("superpowers")).toMatchObject({
      identity: "obra/Superpowers",
      commit: "b36e0829c6d0140e93cfef2ca599b1b07d4a7797",
      disposition: "active",
    });
    // The previous reconciliation deliberately did NOT promote the refresh
    // candidate; this one does, so the recorded reason has to say so.
    expect(entry("superpowers").reason).toMatch(/rebound from v6\.2\.0 to v6\.3\.0/i);
    const servers = mcpServers("standard", webStack, { selfHost: true });
    expect(entry("code-review-graph").version).toBe(
      versionFromSpec(stdioArg(servers, "code-review-graph", "code-review-graph@")),
    );
    expect(entry("code-review-graph").reason).toMatch(
      /raw repository-agnostic fallback only.*2\.3\.8 raw candidate.*hold.*ambient.*CRG_OPENAI.*silent.*egress/i,
    );
    expect(entry("codebase-memory-mcp").version).toBe(
      versionFromSpec(stdioArg(servers, "codebase-memory-mcp", "codebase-memory-mcp@")),
    );
    expect(entry("codebase-memory-mcp").reason).toMatch(
      /raw repository-agnostic fallback only.*0\.10\.5.*native.*0\.10\.8.*separate/i,
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
      /Initialize.*bounded thought succeeded.*serverInfo reports sequential-thinking-server 2026\.8\.31/i,
    );
    expect(entry("playwright-mcp").version).toBe(
      versionFromSpec(stdioArg(servers, "playwright", "@playwright/mcp@")),
    );
    expect(entry("playwright-mcp").reason).toMatch(
      /Initialize.*isolated headless.*serverInfo reports Playwright 1\.64\.0-alpha-2026-09-14/i,
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
    expect(entry("ecc-codex-chrome-devtools-mcp-candidate")).toMatchObject({
      version: "1.9.0",
      commit: "1cec9cd1a3bbf1895c98fa4b4e0e2da5a36e4075",
      disposition: "blocked",
    });
    expect(entry("ecc-codex-chrome-devtools-mcp-candidate").reason).toMatch(
      /detached update-check.*usage statistics default on.*new_page.*list_pages.*blocked/i,
    );
    expect(entry("ecc-codex-chrome-devtools-mcp-candidate").reason).toMatch(
      /--executablePath.*same installed Chrome binary.*new_page.*captured owned Node\/Chrome tree was empty/i,
    );

    const github = servers.github as StdioServer;
    const githubImage = github.args.find((candidate) => candidate.startsWith("ghcr.io/github/"));
    expect(githubImage).toBeDefined();
    expect(entry("github-mcp-container").integrity).toBe(githubImage?.split("@")[1]);
    expect(entry("github-mcp-container")).toMatchObject({
      version: "v1.12.1",
      commit: "7d13a7ad6f2a17f351a6d77ce280c85ae1821f4d",
      disposition: "active",
    });
    expect(entry("github-mcp-container").reason).toMatch(
      /Optional self-host.*44 default tool names are identical.*Docker was unavailable/i,
    );

    const plan = toolingPlan();
    expect(entry("serena").version).toBe(versionFromSpec(plan.pins.serena.package));
    expect(entry("token-savior").version).toBe(versionFromSpec(plan.pins.tokenSavior.package));
    expect(entry("token-optimizer")).toMatchObject({
      version: plan.pins.tokenOptimizer.tag,
      commit: plan.pins.tokenOptimizer.commit,
    });
  });

  it("keeps raw MCP fallbacks distinct from authenticated native defaults", () => {
    const graph = entry("code-review-graph-native-default");
    expect(graph).toMatchObject({
      identity: "code-review-graph",
      version: versionFromSpec(CODE_REVIEW_GRAPH_RUNTIME_PIN.package),
      commit: CODE_REVIEW_GRAPH_RUNTIME_PIN.sourceCommit,
      integrity: `sha256:${CODE_REVIEW_GRAPH_RUNTIME_PIN.wheelSha256}`,
      disposition: "active",
    });
    for (const lock of [
      DEFAULT_MCP_RUNTIME_PYPROJECT_SHA256,
      DEFAULT_MCP_RUNTIME_UV_LOCK_SHA256,
      DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
    ]) {
      expect(graph.reason).toContain(`sha256:${lock}`);
    }
    expect(graph.reason).toMatch(
      /guarded native default.*installed Linux Node 20.*five guarded operations.*per-host.*macOS.*unverified/i,
    );

    const memory = entry("codebase-memory-mcp-native-default");
    expect(memory).toMatchObject({
      identity: "codebase-memory-mcp",
      version: versionFromSpec(CODEBASE_MEMORY_RUNTIME_PIN.package),
      commit: CODEBASE_MEMORY_RUNTIME_PIN.sourceCommit,
      integrity: `sha256:${CODEBASE_MEMORY_RUNTIME_PIN.releaseManifestSha256}`,
      disposition: "active",
    });
    expect(memory.integrityCovers).toBeUndefined();
    for (const lock of [
      DEFAULT_MCP_RUNTIME_PYPROJECT_SHA256,
      DEFAULT_MCP_RUNTIME_UV_LOCK_SHA256,
      DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
      CODEBASE_MEMORY_RUNTIME_PIN.wheelSha256,
    ]) {
      expect(memory.reason).toContain(`sha256:${lock}`);
    }
    for (const archive of Object.values(CODEBASE_MEMORY_RUNTIME_PIN.archives)) {
      expect(memory.reason).toContain(`${archive.name} sha256:${archive.sha256}`);
    }
    expect(memory.reason).toMatch(
      /guarded native default.*selected platform archive.*installed Linux Node 20.*A-B-A.*per-host.*macOS.*unverified/i,
    );
  });

  it("binds Core and its repository helper to one Token Optimizer source identity", () => {
    const active = entry("token-optimizer");
    expect(active).toMatchObject({
      identity: TOKEN_OPTIMIZER_PIN.repository,
      version: TOKEN_OPTIMIZER_PIN.tag,
      commit: TOKEN_OPTIMIZER_PIN.commit,
      disposition: "active",
    });
    expect(active.reason).toContain(`tree ${TOKEN_OPTIMIZER_PIN.tree}`);
    expect(active.reason).toContain(`manifest sha256:${TOKEN_OPTIMIZER_PIN.manifestSha256}`);
    expect(active.reason).toMatch(/all 158.*canonical Git blobs/i);
    expect(active.reason).toMatch(/quiet and balanced.*receipt ownership.*policy exclusions/i);
    expect(toolingPlan().pins.tokenOptimizer).toMatchObject({
      tag: TOKEN_OPTIMIZER_PIN.tag,
      commit: TOKEN_OPTIMIZER_PIN.commit,
      tree: TOKEN_OPTIMIZER_PIN.tree,
    });

    const historical = entry("token-optimizer-candidate");
    expect(historical).toMatchObject({
      identity: TOKEN_OPTIMIZER_PIN.repository,
      version: "v5.13.12",
      commit: "35d047b32af64b2c8bb7ef8d83d90396abc223c9",
      integrity: "sha256:69e4704da1c003529c157ffa061a31756997073b849759e231434a080e15a601",
      disposition: "retained",
    });
    expect(historical.reason).toMatch(/historical candidate.*superseded/i);
    expect(historical.reason).toMatch(/all 154.*canonical Git blobs/i);
    expect(historical.reason).toMatch(/checksum hold was disproved.*no upstream repair/i);
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
    expect(entry("skillspector-build-uv")).toMatchObject({
      identity: "uv",
      version: "0.12.8",
      commit: "68209e5c61ce4b76c2e685bea7913876bc929dc9",
      disposition: "retained",
    });
    expect(entry("skillspector-build-uv").version).toBe(
      skillspectorDockerfile.match(/pip install --no-cache-dir uv==([^\s]+)/)?.[1],
    );
    expect(entry("uv")).toMatchObject({
      version: "0.12.13",
      commit: "0ebbd9274a55a8a53a13970be3b97e4209598e17",
      disposition: "active",
    });
    expect(entry("uv").reason).toMatch(/five committed locks.*byte-identical/i);
    expect(entry("uv").reason).not.toMatch(/SkillSpector build/i);
    expect(entry("uv").reason).toContain(
      "a86c9dc7bad9b03f388583b7187c05fe9951c2e0d392217e8fd43d97787f6ec2",
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
    expect(entry("claude-code-action").version).toBe("v1.0.223");

    const snykQualificationWorkflow = readFileSync(
      resolve(root, ".github/workflows/snyk-agent-qualification.yml"),
      "utf8",
    );
    expect(entry("setup-python-action")).toMatchObject(
      workflowActionPin(snykQualificationWorkflow, "actions/setup-python"),
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
    expect(entry("codeql-action").version).toBe("v4.38.0");
    expect(entry("codeql-action").reason).toMatch(/codeql-bundle-v2\.27\.0/i);
  });

  it("records governed scanner identities and fails closed on AgentShield provenance", () => {
    expect(entry("cisco-skill-scanner")).toMatchObject({
      version: CISCO_SKILL_SCANNER_VERSION,
      commit: "a49c8d9f7555dd99a9f5e4430c3bb8d4fe4a9371",
      integrity: "sha256:30b5c8a5108307981e0299e6cde0da869be64deb5da0ca66cf9f0022c3c48fc2",
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
    expect(entry("aws-core-mcp-server").reason).toMatch(
      /2026-09-14T15:44:37\.728Z.*both exact artifacts remain yanked.*wheel.*sdist/i,
    );
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
      /PolyForm Noncommercial 1\.0\.0.*explicit acceptance/i,
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
    const anthropicCandidate = entry("anthropic-skills-candidate-2026-09-14");
    expect(anthropicCandidate).toMatchObject({
      identity: "anthropics/skills",
      commit: "34040c9c568585f6929bedeaad110ad08f079624",
      integrity: "sha256:bbda9be7b3cba505db10e6e61e38133a05ab17799bd4f8e155704c6900ffb914",
      disposition: "blocked",
    });
    expect(anthropicCandidate.reason).toMatch(
      /request sha256:5b14bb5835c795538498275ffa8feaa67f02fcbd6499eccbbc53c4b2aacd8437.*publication sha256:bbda9be7b3cba505db10e6e61e38133a05ab17799bd4f8e155704c6900ffb914.*receipt sha256:1b25f8425f484b08ae6732804c275ea7ea179d3323e64680803ae592072df78a/i,
    );
    const uiUxCandidate = entry("ui-ux-pro-max-skill-candidate-2026-09-14");
    expect(uiUxCandidate).toMatchObject({
      identity: "nextlevelbuilder/ui-ux-pro-max-skill",
      version: "v2.15.0",
      commit: "a38d04c3d5c298c851dbe5e6ee1965ee3de42cb5",
      integrity: "sha256:3a2c67b989fd9def7db7b3f75e4223744ef33e59475d149224f847ae244fa123",
      disposition: "blocked",
    });
    expect(uiUxCandidate.reason).toMatch(
      /request sha256:55c071fd4aa39254d3743527cb78095c0b04e4d73c5b7f6cb9c80f6e126b2eac.*publication sha256:3a2c67b989fd9def7db7b3f75e4223744ef33e59475d149224f847ae244fa123.*receipt sha256:d5a88a98ecac41543397943a60e7e7b5487fcc4709290cd1f17c86b0a93e6186/i,
    );
    for (const candidate of [anthropicCandidate, uiUxCandidate]) {
      expect(candidate.reason).toMatch(
        /all requested fixed analyzer executions succeeded.*no missing or failed analyzer.*coverage warnings remain preserved/i,
      );
      expect(candidate.reason).toMatch(
        /8101b9790ef18136a99d7e4cc481c01a5d63ee6c.*15 review-only rows.*176 generated files.*243 mapped findings.*empty executable capability arrays.*installation false.*authority none.*organization admission not-authoritative.*unresolved content, license, or execution findings.*cannot promote the maintained Core guide pin/i,
      );
    }
    expect(entry("anthropic-skills-guide").reason).toMatch(
      /34040c9c568585f6929bedeaad110ad08f079624.*held.*not Core guide approval/i,
    );
    expect(entry("ui-ux-pro-max-skill-guide").reason).toMatch(
      /v2\.15\.0 candidate a38d04c3d5c298c851dbe5e6ee1965ee3de42cb5.*held.*not Core guide approval/i,
    );
    expect(entry("anthropic-skills")).toMatchObject({
      commit: "b29e7cf65e5cb78a5ac33d582270551bc74a14eb",
      disposition: "blocked",
    });
    expect(entry("ui-ux-pro-max-skill")).toMatchObject({
      version: "v2.11.3",
      commit: "4857a2c5ef989794751a0f66b8545a4a49566286",
      disposition: "blocked",
    });
    expect(entry("aws-mcp-guide-source").reason).toMatch(/Agent Toolkit for AWS/i);

    // The ECC candidate is recorded blocked WITHOUT moving the active pin, so the
    // two entries must keep disagreeing on commit: a candidate that silently
    // matched baseline-sources would mean the rotation happened.
    expect(entry("ecc-candidate")).toMatchObject({
      identity: "affaan-m/ECC",
      version: "v2.2.0-147-ge04ea0b9",
      commit: "e04ea0b9cc8248686edf5ac751cadff550e162b8",
      disposition: "blocked",
    });
    expect(entry("ecc-candidate").commit).not.toBe(entry("ecc").commit);
    expect(entry("ecc-candidate").reason).toMatch(
      /ECC_OPENCODE_HOOK_CONSENT_AND_FULL_VET_UNQUALIFIED/,
    );
    // Live exact-SHA state, the local evidence boundary, and the consent defect
    // are all load-bearing. Losing any one would make the HOLD unauditable.
    expect(entry("ecc-candidate").reason).toMatch(
      /GitHub-verified signature.*46 of 46 check runs/i,
    );
    expect(entry("ecc-candidate").reason).toMatch(
      /hook-consent\.js gates only the hooks-runtime module/i,
    );
    expect(entry("ecc-candidate").reason).toMatch(
      /platform-configs.*\.opencode\/plugins\/ecc-hooks\.ts/i,
    );
    expect(entry("ecc-candidate").reason).toMatch(/no single choke point/i);
    expect(entry("ecc-candidate").reason).toMatch(/No Scanner publication was requested/i);
    expect(entry("ecc-candidate").reason).toMatch(/not a categorical block/i);
    expect(entry("ecc-candidate").reason).toMatch(/production lock.*unchanged/i);
    expect(entry("ecc-candidate").reason).toMatch(/dcbf95bf.*immutable history/i);
  });
});
