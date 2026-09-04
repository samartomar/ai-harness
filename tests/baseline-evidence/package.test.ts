import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { CISCO_SKILL_SCANNER_SPEC } from "../../src/baseline-evidence/analyzer-profile.js";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";

const repo = process.cwd();

function packageJson(): {
  files: string[];
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
    files: string[];
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
}

describe("baseline evidence release payload", () => {
  it("ships the auditable vendor lock in the actual npm pack file list", () => {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("npm_execpath is required for the cross-platform pack test");
    const output = execFileSync(
      process.execPath,
      [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const packed = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    const files = packed[0]?.files.map((file) => file.path) ?? [];
    expect(files).toContain("src/baseline-evidence/vendor-lock.json");
    expect(files).toContain("tools/cisco-skill-scanner/pyproject.toml");
    expect(files).toContain("tools/cisco-skill-scanner/uv.lock");
    expect(files).toContain("tools/trust-scanners/cisco-mcp/pyproject.toml");
    expect(files).toContain("tools/trust-scanners/cisco-mcp/uv.lock");
    expect(files).toContain("tools/trust-scanners/semgrep/pyproject.toml");
    expect(files).toContain("tools/trust-scanners/semgrep/uv.lock");
    expect(files).toContain("tools/trust-scanners/snyk-agent-scan/pyproject.toml");
    expect(files).toContain("tools/trust-scanners/snyk-agent-scan/uv.lock");
  });

  it("delegates baseline execution to the exact public Scanner and keeps Core consumption explicit", () => {
    const manifest = packageJson();
    const scripts = manifest.scripts;
    expect(manifest.devDependencies["@aihq/scan"]).toBe("0.3.0");
    expect(scripts["baseline:request"]).toContain("scanner-cli.ts request");
    expect(scripts["baseline:vet"]).toBeUndefined();
    expect(scripts["baseline:consume"]).toBeUndefined();
    expect(scripts["baseline:consume-publication"]).toContain("scanner-cli.ts consume-publication");
    expect(scripts["baseline:assemble"]).toContain("scanner-cli.ts assemble");
    expect(scripts["baseline:check"]).toContain("check:baseline-pins");
    expect(scripts["baseline:check"]).toContain("check:baseline-analyzers");
    expect(scripts["baseline:check"]).toContain("check:baseline-installable");
    expect(scripts["check:baseline-analyzers"]).toContain("check-baseline-analyzers.ts");
    expect(scripts.verify).toContain("check:baseline-analyzers");
  });

  it("does not retain a second baseline refresh executor inside Core", () => {
    expect(existsSync(join(repo, "src", "baseline-evidence", "generate.ts"))).toBe(false);
    expect(existsSync(join(repo, "src", "baseline-evidence", "shard.ts"))).toBe(false);
    expect(existsSync(join(repo, "src", "baseline-evidence", "ecc-preflight-receipt.ts"))).toBe(
      false,
    );
  });

  it("keeps required CI on committed evidence and immutable consumption explicit", () => {
    const requiredPath = join(repo, ".github", "workflows", "baseline-evidence.yml");
    expect(existsSync(requiredPath)).toBe(false);
    const ciWorkflow = readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8");
    const ciDocument = parseDocument(ciWorkflow);
    expect(ciDocument.errors).toEqual([]);
    const qualitySteps = (
      ciDocument.toJSON() as {
        jobs?: { quality?: { steps?: Array<{ name?: unknown; run?: unknown }> } };
      }
    ).jobs?.quality?.steps;
    if (!qualitySteps) throw new Error("ci workflow must define quality steps");
    const requiredCommands = JSON.stringify(qualitySteps);
    expect(requiredCommands).toContain("npm run baseline:check");
    expect(requiredCommands).not.toContain("baseline:vet");
    expect(requiredCommands).not.toContain("setup-uv");
    expect(requiredCommands).not.toContain("docker");

    const consumePath = join(repo, ".github", "workflows", "baseline-publication-consume.yml");
    expect(existsSync(consumePath)).toBe(true);
    const consumeWorkflow = readFileSync(consumePath, "utf8");
    expect(parseDocument(consumeWorkflow).errors).toEqual([]);
    expect(consumeWorkflow).toContain(baselineCatalogById("ecc").pinnedSha);
    expect(consumeWorkflow).toContain(baselineCatalogById("superpowers").pinnedSha);
    expect(consumeWorkflow).toContain("869806438a39a002763659a2708a1ae7fcc3431d");
    expect(consumeWorkflow).toContain("npm run baseline:request");
    expect(consumeWorkflow).toContain("npm run baseline:consume-publication");
    expect(consumeWorkflow).toContain("npm run baseline:assemble");
    expect(consumeWorkflow).toContain("gh release download");
    expect(consumeWorkflow).toContain("gh attestation verify");
    expect(consumeWorkflow).toContain("baseline-v1-$request_sha256");
    expect(consumeWorkflow).toContain(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    );
    expect(consumeWorkflow).toContain("actions/upload-artifact@");
    expect(consumeWorkflow).not.toMatch(/git\s+(commit|push)|npm\s+publish/);
    expect(consumeWorkflow).not.toContain("baseline:vet");
    expect(consumeWorkflow).not.toContain("setup-python");
    expect(consumeWorkflow).not.toContain("setup-uv");
    expect(consumeWorkflow).not.toContain("docker");
  });

  it("keeps legacy analyzer locks auditable while Scanner owns refresh execution", () => {
    const runtimeRoot = join(repo, "tools", "cisco-skill-scanner");
    const pyproject = join(runtimeRoot, "pyproject.toml");
    const lock = join(runtimeRoot, "uv.lock");
    expect(existsSync(pyproject)).toBe(true);
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(pyproject, "utf8")).toContain(CISCO_SKILL_SCANNER_SPEC);

    const ciWorkflow = readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8");
    const consumeWorkflow = readFileSync(
      join(repo, ".github", "workflows", "baseline-publication-consume.yml"),
      "utf8",
    );
    for (const workflow of [ciWorkflow, consumeWorkflow]) {
      expect(workflow).not.toContain("setup-python");
      expect(workflow).not.toContain("setup-uv");
      expect(workflow).not.toContain("/usr/bin/python");
      expect(workflow).not.toContain("/usr/bin/bwrap");
      expect(workflow).not.toContain("docker");
    }
  });

  it("builds SkillSpector from its committed lock on a digest-pinned base", () => {
    const path = join(repo, "tools", "skillspector.Dockerfile");
    expect(existsSync(path)).toBe(true);
    const dockerfile = readFileSync(path, "utf8");
    expect(dockerfile).toContain(
      "python:3.12-slim-bookworm@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134",
    );
    expect(dockerfile).toContain("uv==0.12.9");
    expect(dockerfile).toContain(
      'org.opencontainers.image.revision="2d198ab910add401cad658d1087e7c7ba24fd640"',
    );
    expect(dockerfile).toContain("COPY pyproject.toml uv.lock README.md ./");
    expect(dockerfile).toContain("uv sync --frozen --no-dev --no-editable");
    // The build-backend cutoff is load-bearing: uv.lock does not pin the PEP 517
    // backends, so without it setuptools/hatchling float and the image digest
    // moves. Guard the exact value — silently losing it reintroduces the drift
    // that made the controlled digest unrebuildable.
    expect(dockerfile).toContain("UV_EXCLUDE_NEWER=2026-08-15T00:00:00Z");
    expect(dockerfile).not.toContain("apt-get");
    expect(dockerfile).not.toMatch(/pip\s+install\s+--no-cache-dir\s+\./);
  });

  it("checks analyzer-complete vendor receipts again before release packaging", () => {
    const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const workflow = readFileSync(join(repo, ".github", "workflows", "release.yml"), "utf8");
    expect(manifest.scripts["verify:release-candidate"]).toContain(
      "npm run check:baseline-analyzers",
    );
    expect(workflow).toContain("npm run verify:release-candidate");
  });
});
