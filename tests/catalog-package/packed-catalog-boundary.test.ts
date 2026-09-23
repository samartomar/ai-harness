import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Packed-consumer proof of the Core/Catalog boundary: Core is built with its own
// tsup config and declaration emit, packed, and installed with --ignore-scripts
// into disposable consumers outside the repository, once alone and once beside
// Scan and the Catalog tarball this checkout installs. The tool asserts the
// optional-peer manifest, a single dynamic import and no bundled Catalog, the
// TypeScript declarations with skipLibCheck false with and without Catalog, and
// that the historical ECC route takes its runtime descriptor from the INSTALLED
// Catalog (resolve trace and provenance line), from Core's embedded copy only
// when Catalog is absent, and refuses by name when the installed bytes change.
// ---------------------------------------------------------------------------

const repoRoot = process.cwd();
const catalogTarball = join(
  repoRoot,
  "tests",
  "fixtures",
  "packages",
  "aihq-catalog-0.2.0-517e43d.tgz",
);
const scratch: string[] = [];

afterAll(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

function npmCli(): string {
  const cli = process.env.npm_execpath;
  if (cli === undefined || !/\.[cm]?js$/.test(cli))
    throw new Error("npm_execpath is required for the packed-consumer test");
  return cli;
}

describe("packed Core and the optional @aihq/catalog peer", () => {
  it("resolves the ECC runtime descriptor across the package boundary", () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "aih-packed-catalog-boundary-test-")));
    scratch.push(work);
    const emptyUserConfig = join(work, "empty.npmrc");
    writeFileSync(emptyUserConfig, "");
    const packed = spawnSync(
      process.execPath,
      [
        npmCli(),
        "pack",
        join(repoRoot, "node_modules", "@aihq", "scan"),
        "--ignore-scripts",
        "--pack-destination",
        work,
        "--userconfig",
        emptyUserConfig,
      ],
      {
        cwd: work,
        encoding: "utf8",
        env: { ...process.env, npm_config_userconfig: emptyUserConfig },
      },
    );
    expect(packed.status, packed.stderr).toBe(0);
    const scanTarball = readdirSync(work).find((file) => /^aihq-scan-.*\.tgz$/.test(file));
    expect(scanTarball).toBeDefined();

    const verified = spawnSync(
      process.execPath,
      [
        join(repoRoot, "tools", "verify-packed-catalog-boundary.mjs"),
        "--stage-from",
        repoRoot,
        "--scan",
        join(work, scanTarball as string),
        "--catalog",
        catalogTarball,
        "--work",
        join(work, "boundary"),
      ],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const lines = verified.stdout.trim().split(/\r?\n/);
    const last = lines.at(-1) ?? "";
    // A tool that stopped early prints no summary: report its own output, not a parse error.
    const summary = (last.startsWith("{") ? JSON.parse(last) : {}) as {
      ok?: boolean;
      failed?: string[];
    };
    expect(
      { status: verified.status, failed: summary.failed },
      `${verified.stdout}\n${verified.stderr}`,
    ).toEqual({ status: 0, failed: [] });
    expect(summary.ok).toBe(true);
    expect(lines.filter((line) => line.startsWith("FAIL "))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("PASS ")).length).toBeGreaterThanOrEqual(15);
  }, 900_000);
});
