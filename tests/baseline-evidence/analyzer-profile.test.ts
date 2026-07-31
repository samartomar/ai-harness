import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  baselineAnalyzerVersions,
  CISCO_MCP_SCANNER_LOCK,
  CISCO_MCP_SCANNER_PROJECT,
  CISCO_MCP_SCANNER_VERSION,
  CISCO_SKILL_SCANNER_LOCK,
  CISCO_SKILL_SCANNER_PROJECT,
  CISCO_SKILL_SCANNER_VERSION,
  preflightRequiredBaselineAnalyzers,
  requiredBaselineAnalyzersForComponent,
  requiredBaselineDetectorsForComponent,
  SEMGREP_LOCK,
  SEMGREP_PROJECT,
  SEMGREP_VERSION,
  SNYK_AGENT_SCAN_LOCK,
  SNYK_AGENT_SCAN_PROJECT,
  SNYK_AGENT_SCAN_VERSION,
} from "../../src/baseline-evidence/analyzer-profile.js";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { fakeRunner, missingToolRunner } from "../../src/internals/proc.js";
import { checkDetectorsAvailable } from "../../src/trust/detectors.js";

function component(id: string, paths: string[]) {
  const [first] = defineBaselineCatalog({
    id: "fixture",
    owner: "owner",
    repo: "repo",
    pinnedSha: "a".repeat(40),
    components: [{ id, paths }],
  }).components;
  if (first === undefined) throw new Error("fixture catalog did not contain a component");
  return first;
}

describe("required baseline analyzer applicability", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ["runtime:ecc-installer", ["package.json", "scripts/lib"], false],
    ["agent:reviewer", ["agents/reviewer.md"], false],
    ["module:docs", ["docs/en"], false],
    ["skill:tdd", ["skills/tdd-workflow"], true],
    ["module:quality", ["scripts/check.js", "skills/verification-loop"], true],
  ])(
    "requires Semgrep everywhere and Cisco only for declared skill content in %s",
    (id, paths, includesCisco) => {
      const required = requiredBaselineAnalyzersForComponent(component(id, paths));
      expect(required).toEqual(
        includesCisco
          ? ["aih-native", "skillspector@docker", "semgrep@uv:1.172.0", "cisco@uvx"]
          : ["aih-native", "skillspector@docker", "semgrep@uv:1.172.0"],
      );
      expect(requiredBaselineDetectorsForComponent(component(id, paths))).toEqual(
        includesCisco ? ["skillspector", "semgrep", "cisco"] : ["skillspector", "semgrep"],
      );
    },
  );

  it("requires Cisco when a declared harness root contains SKILL.md content", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-analyzer-profile-"));
    roots.push(root);
    mkdirSync(join(root, ".kiro", "skills", "reviewer"), { recursive: true });
    writeFileSync(join(root, ".kiro", "skills", "reviewer", "SKILL.md"), "# Reviewer\n");
    const nested = component("runtime:ecc-kiro", [".kiro"]);

    expect(requiredBaselineAnalyzersForComponent(nested, root)).toEqual([
      "aih-native",
      "skillspector@docker",
      "semgrep@uv:1.172.0",
      "cisco@uvx",
    ]);
    expect(requiredBaselineDetectorsForComponent(nested, root)).toEqual([
      "skillspector",
      "semgrep",
      "cisco",
    ]);
  });

  it("does not infer skill content from a missing declared harness path", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-analyzer-profile-missing-"));
    roots.push(root);
    const nested = component("runtime:ecc-kiro", [".kiro"]);

    expect(requiredBaselineAnalyzersForComponent(nested, root)).toEqual([
      "aih-native",
      "skillspector@docker",
      "semgrep@uv:1.172.0",
    ]);
    expect(requiredBaselineDetectorsForComponent(nested, root)).toEqual([
      "skillspector",
      "semgrep",
    ]);
  });

  it("binds the Cisco analyzer receipt identity to the committed uv lock", () => {
    const digest = createHash("sha256")
      .update(readFileSync(CISCO_SKILL_SCANNER_LOCK))
      .digest("hex")
      .slice(0, 12);
    expect(baselineAnalyzerVersions()["cisco@uvx"]).toBe(
      `${CISCO_SKILL_SCANNER_VERSION}+uvlock.${digest}`,
    );
  });

  it.each([
    ["mcp-scanner@uv:4.8.1", CISCO_MCP_SCANNER_VERSION, CISCO_MCP_SCANNER_LOCK],
    ["semgrep@uv:1.172.0", SEMGREP_VERSION, SEMGREP_LOCK],
    ["snyk-agent-scan@uv:0.5.15", SNYK_AGENT_SCAN_VERSION, SNYK_AGENT_SCAN_LOCK],
  ])("binds optional analyzer %s to its committed uv lock", (label, version, lock) => {
    const digest = createHash("sha256").update(readFileSync(lock)).digest("hex").slice(0, 12);
    expect(baselineAnalyzerVersions()[label]).toBe(`${version}+uvlock.${digest}`);
  });

  it.each([
    [CISCO_SKILL_SCANNER_PROJECT, "cisco-ai-skill-scanner", CISCO_SKILL_SCANNER_VERSION],
    [CISCO_MCP_SCANNER_PROJECT, "cisco-ai-mcp-scanner", CISCO_MCP_SCANNER_VERSION],
    [SEMGREP_PROJECT, "semgrep", SEMGREP_VERSION],
    [SNYK_AGENT_SCAN_PROJECT, "snyk-agent-scan", SNYK_AGENT_SCAN_VERSION],
  ])("matches %s project and lock to %s==%s", (project, dependency, version) => {
    expect(readFileSync(join(project, "pyproject.toml"), "utf8")).toContain(
      `"${dependency}==${version}"`,
    );
    expect(readFileSync(join(project, "uv.lock"), "utf8")).toContain(
      `name = "${dependency}"\nversion = "${version}"`,
    );
  });
});

describe("checkDetectorsAvailable", () => {
  it("reports Cisco unavailable with the underlying offline uv reason", async () => {
    const run = fakeRunner((argv) =>
      argv.includes("--version")
        ? { code: 1, stderr: "cisco-ai-skill-scanner was not found in the cache" }
        : undefined,
    );
    const probes = await checkDetectorsAvailable(["cisco"], { run, platform: "linux", env: {} });
    expect(probes).toEqual([
      {
        name: "cisco",
        analyzerLabel: "cisco@uvx",
        reason: expect.stringContaining("not found in the cache"),
      },
    ]);
  });

  it("returns no probe when Cisco resolves offline", async () => {
    const run = fakeRunner((argv) =>
      argv.includes("--version") ? { code: 0, stdout: "skill-scanner 2.0.12" } : undefined,
    );
    expect(await checkDetectorsAvailable(["cisco"], { run, platform: "linux", env: {} })).toEqual(
      [],
    );
  });

  it("rejects an inexact Cisco version and empty Snyk help output", async () => {
    const run = fakeRunner((argv) => {
      if (argv.includes("--version")) return { code: 0, stdout: "skill-scanner 2.0.13" };
      if (argv.includes("--help")) return { code: 0, stdout: "" };
      return undefined;
    });

    const probes = await checkDetectorsAvailable(["cisco", "snyk-agent-scan"], {
      run,
      platform: "linux",
      env: { SNYK_TOKEN: "fixture-token" },
    });

    expect(probes).toEqual([
      {
        name: "cisco",
        analyzerLabel: "cisco@uvx",
        reason: expect.stringContaining("does not match 2.0.12"),
      },
      {
        name: "snyk-agent-scan",
        analyzerLabel: "snyk-agent-scan@uv:0.5.15",
        reason: "snyk-agent-scan help check emitted no output",
      },
    ]);
  });

  it("rejects a different Semgrep version that merely mentions the pinned version", async () => {
    const run = fakeRunner((argv) =>
      argv.includes("--version") ? { code: 0, stdout: "9.9.9\nupgrade from 1.172.0\n" } : undefined,
    );
    const probes = await checkDetectorsAvailable(["semgrep"], {
      run,
      platform: "linux",
      env: {},
    });

    expect(probes).toEqual([
      {
        name: "semgrep",
        analyzerLabel: "semgrep@uv:1.172.0",
        reason: expect.stringContaining("does not match 1.172.0"),
      },
    ]);
  });
});

describe("preflightRequiredBaselineAnalyzers", () => {
  it("fails closed with an actionable provisioning hint when a required analyzer is unprovisioned", async () => {
    await expect(
      preflightRequiredBaselineAnalyzers({ run: missingToolRunner, platform: "linux", env: {} }),
    ).rejects.toThrow(
      /preflight: required analyzer\(s\) not provisioned.*cisco@uvx unavailable.*uv run --project tools\/cisco-skill-scanner --locked/is,
    );
  });
});
