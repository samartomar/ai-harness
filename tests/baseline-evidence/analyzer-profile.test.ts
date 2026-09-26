import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  baselineAnalyzerVersions,
  CISCO_MCP_SCANNER_VERSION,
  CISCO_SKILL_SCANNER_VERSION,
  preflightRequiredBaselineAnalyzers,
  requiredBaselineAnalyzersForComponent,
  requiredBaselineDetectorsForComponent,
  requiredBaselineVetOptions,
  SEMGREP_VERSION,
  SNYK_AGENT_SCAN_VERSION,
  scanBaselineAnalyzerVersionsV1,
} from "../../src/baseline-evidence/analyzer-profile.js";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { ScanPackageRefusalError } from "../../src/scan-package/load-scan-package.js";
import { probeScanDetectorsV1 } from "../../src/trust/detector-availability.js";
import { SKILLSPECTOR_IMAGE, SKILLSPECTOR_SOURCE_REVISION } from "../../src/trust/images.js";

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
          ? ["aih-native", "skillspector@docker", "semgrep@uv:1.178.0", "cisco@uvx"]
          : ["aih-native", "skillspector@docker", "semgrep@uv:1.178.0"],
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
      "semgrep@uv:1.178.0",
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
      "semgrep@uv:1.178.0",
    ]);
    expect(requiredBaselineDetectorsForComponent(nested, root)).toEqual([
      "skillspector",
      "semgrep",
    ]);
  });

  it("pins the analyzer identities committed baseline evidence is checked against", () => {
    expect(baselineAnalyzerVersions()).toEqual({
      "aih-native": "native.014fbd614a5a",
      "skillspector@docker":
        "c7958a3268d9498644b22edb75d0f051bbc8cbfc@sha256:efe47bd7e073064426541381c8cb284162086950748424d1b4633788a2275bc6",
      "semgrep@uv:1.178.0": "1.178.0+uvlock.5fae6a8598f7",
      "cisco@uvx": "2.1.0+uvlock.1e98c5679994",
      "mcp-scanner@uv:4.8.4": "4.8.4+uvlock.b679f3afa519",
      "snyk-agent-scan@uv:0.6.4": "0.6.4+uvlock.c71ffe188e38",
    });
  });

  it("locks cryptography 50.0.0 in the governed Serena runtime", () => {
    expect(readFileSync("src/ecc-profile/serena-runtime/uv.lock", "utf8")).toContain(
      'name = "cryptography"\nversion = "50.0.0"',
    );
  });

  it("pins the Serena runtime to the reviewed 1.7.0 cutoff", () => {
    const manifest = readFileSync("src/ecc-profile/serena-runtime/pyproject.toml", "utf8");
    expect(manifest).toContain('"serena-agent==1.7.0"');
    expect(manifest).toContain('exclude-newer = "2026-08-10T00:00:00Z"');
  });
});

// The locks Core accepts (ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1) under host-process-uv-v1.
const CISCO_LOCK = "1e98c5679994dc56f82c1d88a77528d4c4b076160aff85b4d97ce239360bc210";
const SEMGREP_LOCK = "5fae6a8598f7d5cf4921c0cb5bd1790accd756a2073abfb5c5f104ae64c5b594";
const MCP_LOCK = "b679f3afa51977495cc378cbf7e42ebbe9ef68eda38056d72613e9970bd99c16";
const HOST = { os: "linux", architecture: process.arch === "x64" ? "amd64" : process.arch };
const VERSIONS: Record<string, string> = {
  "detector.cisco": CISCO_SKILL_SCANNER_VERSION,
  "detector.semgrep": SEMGREP_VERSION,
  "detector.cisco-mcp-scanner": CISCO_MCP_SCANNER_VERSION,
  "detector.snyk-agent-scan": SNYK_AGENT_SCAN_VERSION,
};

function uvProfile(sha256?: string) {
  return {
    id: "host-process-uv-v1",
    isolation: "none",
    supportedPlatforms: [HOST],
    ...(sha256 === undefined ? {} : { analyzerLock: { path: "uv.lock", sha256 } }),
  };
}

type FakeCapability = {
  detectorId: string;
  analyzerVersion?: string;
  executionProfiles: unknown[];
};

function capabilities(overrides: Record<string, unknown[]> = {}): FakeCapability[] {
  const declared: Record<string, unknown[]> = {
    "detector.cisco": [uvProfile(CISCO_LOCK)],
    "detector.semgrep": [uvProfile(SEMGREP_LOCK)],
    "detector.cisco-mcp-scanner": [uvProfile(MCP_LOCK)],
    ...overrides,
  };
  return Object.entries(declared).map(([detectorId, executionProfiles]) => ({
    detectorId,
    ...(VERSIONS[detectorId] === undefined ? {} : { analyzerVersion: VERSIONS[detectorId] }),
    executionProfiles,
  }));
}

describe("scanBaselineAnalyzerVersionsV1", () => {
  it("names each uv analyzer by its version and the lock Scan publishes for the profile", () => {
    const identity = scanBaselineAnalyzerVersionsV1(capabilities(), "host-process-uv-v1");
    expect(identity.ciscoLockSha256).toBe(CISCO_LOCK);
    expect(identity.versions).toMatchObject({
      "skillspector@docker": baselineAnalyzerVersions()["skillspector@docker"],
      "cisco@uvx": `${CISCO_SKILL_SCANNER_VERSION}+uvlock.${CISCO_LOCK.slice(0, 12)}`,
      "semgrep@uv:1.178.0": `${SEMGREP_VERSION}+uvlock.${SEMGREP_LOCK.slice(0, 12)}`,
      "mcp-scanner@uv:4.8.4": `${CISCO_MCP_SCANNER_VERSION}+uvlock.${MCP_LOCK.slice(0, 12)}`,
    });
    expect(identity.versions["aih-native"]).toMatch(/^native\.[0-9a-f]{12}$/);
    // Scan declares no Snyk capability here: an optional analyzer is simply not named.
    expect(identity.versions).not.toHaveProperty(`snyk-agent-scan@uv:${SNYK_AGENT_SCAN_VERSION}`);
  });

  it("refuses a vet whose required analyzer lock Scan does not publish", () => {
    expect(() =>
      scanBaselineAnalyzerVersionsV1(
        capabilities({ "detector.cisco": [uvProfile()] }),
        "host-process-uv-v1",
      ),
    ).toThrow(ScanPackageRefusalError);
    expect(() => scanBaselineAnalyzerVersionsV1(capabilities(), "linux-namespace-uv-v1")).toThrow(
      "declares no execution profile linux-namespace-uv-v1",
    );
  });

  it("takes each identity from Core's table and refuses a required lock Scan declares differently", () => {
    const other = "0".repeat(64);
    expect(() =>
      scanBaselineAnalyzerVersionsV1(
        capabilities({ "detector.cisco": [uvProfile(other)] }),
        "host-process-uv-v1",
      ),
    ).toThrow(
      `detector.cisco under host-process-uv-v1 declares analyzer 2.1.0 with uv.lock ${other}; Core accepts 2.1.0 with uv.lock ${CISCO_LOCK}`,
    );
  });

  it("does not name an optional analyzer whose declared identity Core does not accept", () => {
    const identity = scanBaselineAnalyzerVersionsV1(
      capabilities({ "detector.cisco-mcp-scanner": [uvProfile("0".repeat(64))] }),
      "host-process-uv-v1",
    );
    expect(identity.versions).not.toHaveProperty(`mcp-scanner@uv:${CISCO_MCP_SCANNER_VERSION}`);
    expect(identity.versions["semgrep@uv:1.178.0"]).toBe("1.178.0+uvlock.5fae6a8598f7");
  });
});

describe("requiredBaselineVetOptions", () => {
  it("runs the vet through the installed Scan with identities from its capabilities", async () => {
    const listDetectorCapabilitiesV1 = () => capabilities();
    const runDetectorV1 = () => Promise.resolve({ outcome: "refused" });
    const options = await requiredBaselineVetOptions({
      platform: "linux",
      env: { AIH_CISCO_SCAN_CONCURRENCY: "3" },
      importer: () => Promise.resolve({ listDetectorCapabilitiesV1, runDetectorV1 }),
    });
    expect(options.scanOptions?.scanExecution?.runDetectorV1).toBe(runDetectorV1);
    expect(options.scanOptions?.uvExecutionProfileId).toBe("host-process-uv-v1");
    expect(options.analyzerVersions?.["cisco@uvx"]).toBe(
      `${CISCO_SKILL_SCANNER_VERSION}+uvlock.${CISCO_LOCK.slice(0, 12)}`,
    );
    expect(options.sourceWideCisco).toMatchObject({
      analyzerLockSha256: CISCO_LOCK,
      workerConcurrency: 3,
    });
    expect(options.sourceWideScan).toBe(true);
  });

  it("refuses when @aihq/scan is not installed", async () => {
    await expect(
      requiredBaselineVetOptions({
        platform: "linux",
        env: {},
        importer: () =>
          Promise.reject(Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" })),
      }),
    ).rejects.toBeInstanceOf(ScanPackageRefusalError);
  });
});

function probeModule(
  answer: (request: Record<string, unknown>) => unknown,
  overrides: Record<string, unknown[]> = {},
) {
  const requests: Record<string, unknown>[] = [];
  const module = {
    listDetectorCapabilitiesV1: () =>
      capabilities({
        "detector.skillspector": [
          {
            id: "docker-host-local-skillspector-v1",
            isolation: "container",
            supportedPlatforms: [HOST],
          },
        ],
        "detector.snyk-agent-scan": [uvProfile("a".repeat(64))],
        ...overrides,
      }),
    probeDetectorAvailabilityV1: async (request: Record<string, unknown>) => {
      requests.push(request);
      return answer(request);
    },
  };
  return { importer: () => Promise.resolve(module), requests };
}

describe("probeScanDetectorsV1", () => {
  it("asks Scan about each detector under the profile Core would run it with", async () => {
    const scan = probeModule(() => ({ available: true, analyzerVersion: "x" }));
    const unavailable = await probeScanDetectorsV1(["skillspector", "cisco", "snyk-agent-scan"], {
      platform: "linux",
      env: { SNYK_TOKEN: " token ", PATH: "/usr/bin" },
      skillspectorImageApprovals: [
        {
          imageTag: SKILLSPECTOR_IMAGE,
          imageDigest: `sha256:${"b".repeat(64)}`,
          sourceRevision: SKILLSPECTOR_SOURCE_REVISION,
        },
      ],
      importer: scan.importer,
    });
    expect(unavailable).toEqual([]);
    expect(scan.requests).toEqual([
      {
        detectorId: "detector.skillspector",
        executionProfileId: "docker-host-local-skillspector-v1",
        acceptedImageDigests: [`sha256:${"b".repeat(64)}`],
      },
      { detectorId: "detector.cisco", executionProfileId: "host-process-uv-v1" },
      {
        detectorId: "detector.snyk-agent-scan",
        executionProfileId: "host-process-uv-v1",
        env: { SNYK_TOKEN: "token" },
      },
    ]);
  });

  it("reports Scan's reason, an undeclared profile and an undeclared detector", async () => {
    const scan = probeModule(
      (request) =>
        request.detectorId === "detector.cisco"
          ? { available: false, reason: "availability-failed", detail: "uv cache miss" }
          : { available: true },
      { "detector.semgrep": [] },
    );
    const unavailable = await probeScanDetectorsV1(["cisco", "semgrep", "skillspector"], {
      platform: "linux",
      env: {},
      importer: () =>
        scan.importer().then((module) => ({
          ...module,
          listDetectorCapabilitiesV1: () =>
            module
              .listDetectorCapabilitiesV1()
              .filter((capability) => capability.detectorId !== "detector.skillspector"),
        })),
    });
    expect(unavailable).toEqual([
      {
        detector: "cisco",
        analyzerLabel: "cisco@uvx",
        reason: "availability-failed: uv cache miss",
      },
      {
        detector: "semgrep",
        analyzerLabel: "semgrep@uv:1.178.0",
        reason: expect.stringContaining("does not declare host-process-uv-v1"),
      },
      {
        detector: "skillspector",
        analyzerLabel: "skillspector@docker",
        reason: "the installed @aihq/scan declares no detector.skillspector capability",
      },
    ]);
  });
});

describe("preflightRequiredBaselineAnalyzers", () => {
  it("fails closed with an actionable provisioning hint when a required analyzer is unprovisioned", async () => {
    const scan = probeModule((request) =>
      request.detectorId === "detector.cisco"
        ? { available: false, reason: "prerequisite-missing", detail: "uv" }
        : { available: true },
    );
    await expect(
      preflightRequiredBaselineAnalyzers({ platform: "linux", env: {}, importer: scan.importer }),
    ).rejects.toThrow(
      /preflight: required analyzer\(s\) not provisioned.*cisco@uvx unavailable \(prerequisite-missing: uv\).*installed @aihq\/scan/is,
    );
  });

  it("refuses rather than passing when @aihq/scan is missing", async () => {
    await expect(
      preflightRequiredBaselineAnalyzers({
        platform: "linux",
        env: {},
        importer: () =>
          Promise.reject(Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" })),
      }),
    ).rejects.toBeInstanceOf(ScanPackageRefusalError);
  });
});
