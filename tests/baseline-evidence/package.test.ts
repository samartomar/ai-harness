import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CISCO_SKILL_SCANNER_SPEC,
  CISCO_SKILL_SCANNER_VERSION,
} from "../../src/baseline-evidence/analyzer-profile.js";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { SKILLSPECTOR_IMAGE, SKILLSPECTOR_IMAGE_DIGEST } from "../../src/trust/images.js";

const repo = process.cwd();

function packageJson(): {
  files: string[];
  scripts: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
    files: string[];
    scripts: Record<string, string>;
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

  it("exposes explicit write and check scripts for the same deterministic generator", () => {
    const scripts = packageJson().scripts;
    expect(scripts["baseline:vet"]).toContain("baseline-evidence/generate.ts");
    expect(scripts["baseline:check"]).toContain("baseline-evidence/generate.ts");
    expect(scripts["baseline:check"]).toContain("--check");
    expect(scripts["check:baseline-analyzers"]).toContain("check-baseline-analyzers.ts");
    expect(scripts.verify).toContain("check:baseline-analyzers");
  });

  it("runs a non-publishing vet-once workflow at both canonical source pins", () => {
    const path = join(repo, ".github", "workflows", "baseline-evidence.yml");
    expect(existsSync(path)).toBe(true);
    const workflow = readFileSync(path, "utf8");
    expect(workflow).toContain(baselineCatalogById("ecc").pinnedSha);
    expect(workflow).toContain(baselineCatalogById("superpowers").pinnedSha);
    // CI proves the committed evidence is CURRENT and REPRODUCES; it no longer
    // rescans from scratch. The inputs are content-addressed, so a repeat scan
    // at an unchanged pin set could only have sampled the runner image. The
    // from-scratch run is owned by the vet fleet and triggered by pin drift.
    expect(workflow).toContain("npm run check:baseline-pins");
    expect(workflow).toContain("npm run baseline:check");
    expect(workflow).not.toContain("npm run baseline:vet");
    expect(workflow).not.toContain("--full");
    expect(workflow).toContain(SKILLSPECTOR_IMAGE_DIGEST);
    // The image is pulled content-addressed by digest from GHCR, then tagged to
    // the local runtime name so SKILLSPECTOR_IMAGE selection (src/trust/images.ts)
    // keeps working unmodified. Verification is store-agnostic: it checks the
    // pulled image's RepoDigests rather than depending on the runner's Docker
    // image-store type (containerd vs legacy graphdriver).
    expect(workflow).toContain("docker pull");
    expect(workflow).toContain(`ghcr.io/samartomar/skillspector@${SKILLSPECTOR_IMAGE_DIGEST}`);
    expect(workflow).toContain("docker tag");
    expect(workflow).toContain(SKILLSPECTOR_IMAGE);
    expect(workflow).toContain("RepoDigests");
    expect(workflow).not.toContain("/etc/docker/daemon.json");
    expect(workflow).not.toContain("containerd-snapshotter");
    expect(workflow).not.toContain("systemctl restart docker");
    expect(workflow).not.toContain("docker build");
    expect(workflow).toContain("astral-sh/setup-uv@c771a70e6277c0a99b617c7a806ffedaca235ff9");
    expect(workflow).toContain(`skill-scanner ${CISCO_SKILL_SCANNER_VERSION}`);
    expect(workflow).toContain("actions/upload-artifact@");
    expect(workflow).toContain("src/baseline-evidence/vendor-lock.json");
    expect(workflow).not.toMatch(/git\s+(commit|push)|npm\s+publish/);
  });

  it("provisions Cisco from a committed uv lock and uploads the generated evidence candidate", () => {
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
    expect(workflow).toContain("tools/cisco-skill-scanner/uv.lock");
    expect(workflow).toContain("tools/trust-scanners/semgrep/uv.lock");
    expect(workflow).toContain("tools/trust-scanners/snyk-agent-scan/uv.lock");
    expect(workflow).toContain("tools/trust-scanners/cisco-mcp/uv.lock");
    expect(workflow).toContain("actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97");
    expect(workflow).toContain('python-version: "3.12"');
    expect(workflow.match(/--python 3\.12/g)?.length).toBeGreaterThanOrEqual(6);
    expect(workflow).toContain("uv run");
    expect(workflow).toContain("--project tools/cisco-skill-scanner");
    expect(workflow).toContain("--project tools/trust-scanners/semgrep");
    expect(workflow).toContain("--project tools/trust-scanners/snyk-agent-scan");
    expect(workflow).toContain("--project tools/trust-scanners/cisco-mcp");
    expect(workflow).toContain('test "$semgrep_version" = "1.173.0"');
    expect(workflow).toContain("snyk-agent-scan help");
    expect(workflow).toContain("mcp-scanner --help");
    expect(workflow).toContain("--locked");
    expect(workflow).toContain("--offline");
    // `baseline:check` byte-compares the regenerated artifacts itself, so the
    // separate `git diff --exit-code` the old from-scratch step needed is gone.
    expect(workflow).toContain("npm run baseline:check");
    expect(workflow).not.toContain("git diff --exit-code");
  });

  it("builds SkillSpector from its committed lock on a digest-pinned base", () => {
    const path = join(repo, "tools", "skillspector.Dockerfile");
    expect(existsSync(path)).toBe(true);
    const dockerfile = readFileSync(path, "utf8");
    expect(dockerfile).toContain(
      "python:3.12-slim-bookworm@sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b",
    );
    expect(dockerfile).toContain("uv==0.12.2");
    expect(dockerfile).toContain(
      'org.opencontainers.image.revision="0562b964ec5ceac67ee15c163738e5404f14a908"',
    );
    expect(dockerfile).toContain("COPY pyproject.toml uv.lock README.md ./");
    expect(dockerfile).toContain("uv sync --frozen --no-dev --no-editable");
    expect(dockerfile).not.toContain("apt-get");
    expect(dockerfile).not.toMatch(/pip\s+install\s+--no-cache-dir\s+\./);
  });

  it("checks analyzer-complete vendor receipts again before release packaging", () => {
    const workflow = readFileSync(join(repo, ".github", "workflows", "release.yml"), "utf8");
    expect(workflow).toContain("npm run check:baseline-analyzers");
  });
});
