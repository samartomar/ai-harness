import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";

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
  });

  it("runs a non-publishing vet-once workflow at both canonical source pins", () => {
    const path = join(repo, ".github", "workflows", "baseline-evidence.yml");
    expect(existsSync(path)).toBe(true);
    const workflow = readFileSync(path, "utf8");
    expect(workflow).toContain(baselineCatalogById("ecc").pinnedSha);
    expect(workflow).toContain(baselineCatalogById("superpowers").pinnedSha);
    expect(workflow).toContain("npm run baseline:check");
    expect(workflow).toContain("actions/upload-artifact@");
    expect(workflow).toContain("src/baseline-evidence/vendor-lock.json");
    expect(workflow).not.toMatch(/git\s+(commit|push)|npm\s+publish/);
  });
});
