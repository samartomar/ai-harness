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
    expect(manifest.devDependencies["@aihq/scan"]).toBe("0.2.2");
    expect(scripts["baseline:request"]).toContain("scanner-cli.ts request");
    expect(scripts["baseline:vet"]).toBe("aih-scan baseline-vet");
    expect(scripts["baseline:consume"]).toContain("scanner-cli.ts consume");
    expect(scripts["baseline:assemble"]).toContain("scanner-cli.ts assemble");
    expect(scripts["baseline:check"]).toContain("check:baseline-pins");
    expect(scripts["baseline:check"]).toContain("check:baseline-analyzers");
    expect(scripts["baseline:check"]).toContain("check:baseline-installable");
    expect(scripts["check:baseline-analyzers"]).toContain("check-baseline-analyzers.ts");
    expect(scripts.verify).toContain("check:baseline-analyzers");
  });

  it("runs a non-publishing vet-once workflow at both canonical source pins", () => {
    const path = join(repo, ".github", "workflows", "baseline-evidence.yml");
    expect(existsSync(path)).toBe(true);
    const workflow = readFileSync(path, "utf8");
    expect(workflow).toContain(baselineCatalogById("ecc").pinnedSha);
    expect(workflow).toContain(baselineCatalogById("superpowers").pinnedSha);
    const workflowDocument = parseDocument(workflow);
    expect(workflowDocument.errors).toEqual([]);
    const jobs = (
      workflowDocument.toJSON() as {
        jobs?: Record<string, { steps?: Array<{ if?: unknown; run?: unknown }> }>;
      }
    ).jobs;
    const requiredSteps = jobs?.["vet-once"]?.steps;
    if (!requiredSteps) throw new Error("baseline-evidence workflow must define vet-once steps");
    const requiredCommands = JSON.stringify(requiredSteps);
    expect(requiredCommands).toContain("npm run baseline:check");
    expect(requiredCommands).not.toContain("baseline:vet");
    expect(requiredCommands).not.toContain("setup-uv");
    expect(requiredCommands).not.toContain("docker");

    const refreshCommands = JSON.stringify(jobs?.["refresh-execute"]?.steps);
    expect(refreshCommands).toContain("npm run baseline:request");
    expect(refreshCommands).toContain("npm run baseline:vet");
    expect(workflow).toContain("npm run baseline:consume");
    expect(workflow).toContain("npm run baseline:assemble");
    expect(workflow).toContain(`@aihq/scan@\${SCANNER_VERSION}`);
    expect(workflow).toContain("astral-sh/setup-uv@20cfd1bf945f4377ade1205e4dbc17946fc9a30d");
    expect(workflow).toContain('version: "0.12.7"');
    expect(workflow).toContain(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    );
    expect(workflow).toContain("actions/upload-artifact@");
    expect(workflow).toContain("src/baseline-evidence/vendor-lock.json");
    expect(workflow).not.toMatch(/git\s+(commit|push)|npm\s+publish/);
  });

  it("keeps legacy analyzer locks auditable while Scanner owns refresh execution", () => {
    const runtimeRoot = join(repo, "tools", "cisco-skill-scanner");
    const pyproject = join(runtimeRoot, "pyproject.toml");
    const lock = join(runtimeRoot, "uv.lock");
    expect(existsSync(pyproject)).toBe(true);
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(pyproject, "utf8")).toContain(CISCO_SKILL_SCANNER_SPEC);

    const workflow = readFileSync(
      join(repo, ".github", "workflows", "baseline-evidence.yml"),
      "utf8",
    );
    expect(workflow).toContain("actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97");
    expect(workflow).toContain('python-version: "3.13"');
    expect(workflow).toContain("/usr/bin/python3.13");
    expect(workflow).toContain("/usr/local/bin/uv");
    expect(workflow).toContain("/usr/bin/bwrap");
    expect(workflow).toContain("kernel.apparmor_restrict_unprivileged_userns");
    expect(workflow).toContain("/usr/bin/bwrap --unshare-all --unshare-user");
    expect(workflow).toContain("--disable-userns --assert-userns-disabled");
    expect(workflow).toContain("npm run baseline:check");
    expect(workflow).toContain("scanner-baseline-core-candidate");
  });

  it("builds SkillSpector from its committed lock on a digest-pinned base", () => {
    const path = join(repo, "tools", "skillspector.Dockerfile");
    expect(existsSync(path)).toBe(true);
    const dockerfile = readFileSync(path, "utf8");
    expect(dockerfile).toContain(
      "python:3.12-slim-bookworm@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134",
    );
    expect(dockerfile).toContain("uv==0.12.7");
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
    const workflow = readFileSync(join(repo, ".github", "workflows", "release.yml"), "utf8");
    expect(workflow).toContain("npm run check:baseline-analyzers");
  });
});
