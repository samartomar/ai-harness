import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CISCO_SKILL_SCANNER_SPEC,
  CISCO_SKILL_SCANNER_VERSION,
} from "../../src/baseline-evidence/analyzer-profile.js";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { SKILLSPECTOR_IMAGE_DIGEST, SKILLSPECTOR_SOURCE_REVISION } from "../../src/trust/images.js";

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
    expect(workflow).toContain("npm run baseline:check");
    expect(workflow).toContain("repository: NVIDIA/SkillSpector");
    expect(workflow).toContain(`ref: ${SKILLSPECTOR_SOURCE_REVISION}`);
    expect(workflow).toContain(SKILLSPECTOR_IMAGE_DIGEST);
    expect(workflow).toContain("docker build");
    expect(workflow).toContain("tools/skillspector.Dockerfile");
    expect(workflow).toContain("SOURCE_DATE_EPOCH=1782883813");
    expect(workflow).toContain("astral-sh/setup-uv@11f9893b081a58869d3b5fccaea48c9e9e46f990");
    expect(workflow).toContain(CISCO_SKILL_SCANNER_SPEC);
    expect(workflow).toContain(`skill-scanner ${CISCO_SKILL_SCANNER_VERSION}`);
    expect(workflow).toContain("actions/upload-artifact@");
    expect(workflow).toContain("src/baseline-evidence/vendor-lock.json");
    expect(workflow).not.toMatch(/git\s+(commit|push)|npm\s+publish/);
  });

  it("builds SkillSpector from its committed lock on a digest-pinned base", () => {
    const path = join(repo, "tools", "skillspector.Dockerfile");
    expect(existsSync(path)).toBe(true);
    const dockerfile = readFileSync(path, "utf8");
    expect(dockerfile).toContain(
      "python:3.12-slim-bookworm@sha256:8a7e7cc04fd3e2bd787f7f24e22d5d119aa590d429b50c95dfe12b3abe52f48b",
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
