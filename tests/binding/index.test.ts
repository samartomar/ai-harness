import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  type BindingDeclaration,
  type DimensionInspector,
  type ProvisionRequest,
  readBindingDeclaration,
  readBindingLock,
  resolveGitSource,
  runFastScanGate,
  scannableFromGit,
  writeBindingLockAtomic,
} from "../../src/binding/index.js";
import { defaultRunner } from "../../src/internals/proc.js";
import { createFakeAdapter } from "./fake-adapter.js";

const complete: DimensionInspector = {
  dimension: "complete",
  run: () => ({ dimension: "complete", status: "produced", findings: [] }),
};

let projectRoot: string;
let repoDir: string;
let cacheHome: string;

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Binding Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  const skill = join(dir, "skills", "SKILL.md");
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, "# ecc skill\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "aih-binding-project-"));
  repoDir = mkdtempSync(join(tmpdir(), "aih-binding-src-"));
  cacheHome = mkdtempSync(join(tmpdir(), "aih-binding-home-"));
  initRepo(repoDir);
});

afterEach(() => {
  for (const dir of [projectRoot, repoDir, cacheHome])
    rmSync(dir, { recursive: true, force: true });
});

describe("binding W2 end-to-end (declaration authority + derived caches)", () => {
  it("binds a framework through the D6 contract and persists a derived lock", async () => {
    // 1. The COMMITTED declaration is the authority.
    const resolvedForDeclaration = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    // The committed marker carries a portable repository token; the identity that
    // actually binds is the exact commitSha + treeDigest.
    const declaration: BindingDeclaration = {
      schemaVersion: 1,
      framework: { id: "ecc", mode: "lean", host: "claude" },
      source: {
        kind: "git",
        repository: "affaan-m/ECC",
        commitSha: resolvedForDeclaration.commitSha,
        treeDigest: resolvedForDeclaration.treeDigest,
      },
    };
    writeFileSync(
      join(projectRoot, ".aih-config.json"),
      JSON.stringify(
        { schemaVersion: 1, contextDir: "ai-coding", targets: [], binding: declaration },
        null,
        2,
      ),
    );
    expect(readBindingDeclaration(projectRoot)).toEqual(declaration);

    // 2. Derived machine state: resolve -> scan -> provision through an adapter.
    const registry = new AdapterRegistry();
    registry.register(
      createFakeAdapter({
        framework: "ecc",
        adapterType: "host-plugin",
        resolved: resolvedForDeclaration,
      }),
    );
    const adapter = registry.get("ecc");
    if (adapter === undefined) throw new Error("adapter not registered");

    const resolved = await resolveGitSource(
      { repository: repoDir, commitSha: resolvedForDeclaration.commitSha },
      { runner: defaultRunner, cacheHome },
    );
    expect(resolved.treeDigest).toBe(
      declaration.source.kind === "git" ? declaration.source.treeDigest : "",
    );

    const disposition = runFastScanGate(
      scannableFromGit(resolved),
      { posture: "enterprise" },
      { cacheHome, inspectors: [complete] },
    );
    const request: ProvisionRequest = { context: { declaration }, resolved };
    const { lock } = await adapter.provision(request, disposition);

    // 3. Persist the derived lock; it reads back and carries the D7 fields.
    writeBindingLockAtomic(projectRoot, lock);
    const read = readBindingLock(projectRoot);
    expect(read.present).toBe(true);
    if (read.present) {
      expect(read.lock.scannedDigest).toBe(resolved.treeDigest);
      expect(read.lock.match).toBe(true);
      expect(read.lock.declaration.framework.id).toBe("ecc");
    }
  });

  it("keeps validation outcomes unchanged when derived caches are deleted; the committed declaration is untouched", async () => {
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const declaration: BindingDeclaration = {
      schemaVersion: 1,
      framework: { id: "ecc", host: "claude" },
      source: {
        kind: "git",
        repository: "affaan-m/ECC",
        commitSha: resolved.commitSha,
        treeDigest: resolved.treeDigest,
      },
    };
    writeFileSync(
      join(projectRoot, ".aih-config.json"),
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", binding: declaration }),
    );

    const first = runFastScanGate(scannableFromGit(resolved), { posture: "team" }, { cacheHome });

    // Blow away every derived cache and rebuild from the committed source.
    rmSync(join(cacheHome, "scan-cache"), { recursive: true, force: true });
    rmSync(join(cacheHome, "cache"), { recursive: true, force: true });
    const rebuilt = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const second = runFastScanGate(scannableFromGit(rebuilt), { posture: "team" }, { cacheHome });

    expect(second.verdict).toBe(first.verdict);
    expect(second.digest).toBe(first.digest);
    // The committed declaration — the authority — never changed.
    expect(readBindingDeclaration(projectRoot)).toEqual(declaration);
    expect(existsSync(join(projectRoot, ".aih-config.json"))).toBe(true);
  });
});
