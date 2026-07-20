import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry, type ProvisionRequest } from "../../src/binding/adapter.js";
import {
  assertResolvedMatchesDeclaration,
  BindingScanError,
  type DimensionInspector,
  type ResolvedGitSource,
  resolveGitSource,
  runFastScanGate,
  type ScanDisposition,
  scannableFromGit,
} from "../../src/binding/scan-gate.js";
import { type BindingDeclaration, BindingDeclarationSchema } from "../../src/binding/schema.js";
import { defaultRunner } from "../../src/internals/proc.js";
import { createFakeAdapter } from "./fake-adapter.js";

const producedClean: DimensionInspector = {
  dimension: "c",
  run: () => ({ dimension: "c", status: "produced", findings: [] }),
};

let repoDir: string;
let cacheHome: string;

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir }).toString().trim();
}

function commit(dir: string, rel: string, content: string): string {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", `add ${rel}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "aih-fix-repo-"));
  cacheHome = mkdtempSync(join(tmpdir(), "aih-fix-home-"));
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.email", "t@example.com"]);
  git(repoDir, ["config", "user.name", "Fix Test"]);
  git(repoDir, ["config", "commit.gpgsign", "false"]);
});

afterEach(() => {
  for (const dir of [repoDir, cacheHome]) rmSync(dir, { recursive: true, force: true });
});

describe("FINDING 3 — stale-checkout digest hazard", () => {
  it("re-clones when the cached checkout is not at the requested commit", async () => {
    const sha1 = commit(repoDir, "a.txt", "one\n");
    const sha2 = commit(repoDir, "b.txt", "two\n");

    const first = await resolveGitSource(
      { repository: repoDir, commitSha: sha2 },
      { runner: defaultRunner, cacheHome },
    );

    // Simulate an interrupted prior run: the <sha2> checkout dir is left at sha1.
    git(join(cacheHome, "cache", sha2), ["checkout", "--quiet", sha1]);

    const second = await resolveGitSource(
      { repository: repoDir, commitSha: sha2 },
      { runner: defaultRunner, cacheHome },
    );
    // Without the HEAD check, the digest would be sha1's tree; the fix re-clones.
    expect(second.commitSha).toBe(sha2);
    expect(second.treeDigest).toBe(first.treeDigest);
  });

  it("re-clones when the cached checkout is dirty", async () => {
    const sha = commit(repoDir, "a.txt", "one\n");
    const first = await resolveGitSource(
      { repository: repoDir, commitSha: sha },
      { runner: defaultRunner, cacheHome },
    );
    writeFileSync(join(cacheHome, "cache", sha, "injected.txt"), "polluted\n");
    const second = await resolveGitSource(
      { repository: repoDir, commitSha: sha },
      { runner: defaultRunner, cacheHome },
    );
    expect(second.treeDigest).toBe(first.treeDigest);
  });
});

describe("FINDING 3 — assertResolvedMatchesDeclaration (D7 re-provision cross-check)", () => {
  function gitDecl(resolved: ResolvedGitSource): BindingDeclaration {
    return {
      schemaVersion: 1,
      framework: { id: "ecc", host: "claude" },
      source: {
        kind: "git",
        repository: resolved.repository,
        commitSha: resolved.commitSha,
        treeDigest: resolved.treeDigest,
      },
    };
  }

  it("accepts a resolved source that matches the declaration", async () => {
    const sha = commit(repoDir, "a.txt", "one\n");
    const resolved = await resolveGitSource(
      { repository: repoDir, commitSha: sha },
      { runner: defaultRunner, cacheHome },
    );
    expect(() => assertResolvedMatchesDeclaration(gitDecl(resolved), resolved)).not.toThrow();
  });

  it("rejects a treeDigest mismatch", async () => {
    const sha = commit(repoDir, "a.txt", "one\n");
    const resolved = await resolveGitSource(
      { repository: repoDir, commitSha: sha },
      { runner: defaultRunner, cacheHome },
    );
    const declaration = gitDecl(resolved);
    const drifted: ResolvedGitSource = { ...resolved, treeDigest: "f".repeat(64) };
    expect(() => assertResolvedMatchesDeclaration(declaration, drifted)).toThrow(BindingScanError);
  });

  it("rejects a source-kind mismatch", async () => {
    const sha = commit(repoDir, "a.txt", "one\n");
    const resolved = await resolveGitSource(
      { repository: repoDir, commitSha: sha },
      { runner: defaultRunner, cacheHome },
    );
    const npmDeclaration: BindingDeclaration = {
      schemaVersion: 1,
      framework: { id: "superpowers", host: "claude" },
      source: {
        kind: "npm",
        package: "x",
        exactVersion: "1.0.0",
        integrity: `sha512-${"A".repeat(86)}==`,
      },
    };
    expect(() => assertResolvedMatchesDeclaration(npmDeclaration, resolved)).toThrow(
      BindingScanError,
    );
  });
});

describe("FINDING 4 — git argv hygiene / leading-dash rejection", () => {
  it("rejects a leading-dash repository at the schema layer (whole value and each segment)", () => {
    for (const repository of ["-oops", "-owner/repo", "owner/-repo"]) {
      const declaration = {
        schemaVersion: 1,
        framework: { id: "ecc", host: "claude" },
        source: { kind: "git", repository, commitSha: "a".repeat(40), treeDigest: "b".repeat(64) },
      };
      expect(BindingDeclarationSchema.safeParse(declaration).success).toBe(false);
    }
  });

  it("rejects a leading-dash repository at the resolver layer", async () => {
    await expect(
      resolveGitSource({ repository: "-oops", ref: "HEAD" }, { runner: defaultRunner, cacheHome }),
    ).rejects.toBeInstanceOf(BindingScanError);
  });
});

describe("FINDING 5 — registry-enforced provision guard", () => {
  async function fixture(): Promise<{ resolved: ResolvedGitSource; disposition: ScanDisposition }> {
    const sha = commit(repoDir, "SKILL.md", "# skill\n");
    const resolved = await resolveGitSource(
      { repository: repoDir, commitSha: sha },
      { runner: defaultRunner, cacheHome },
    );
    const disposition = runFastScanGate(
      scannableFromGit(resolved),
      { posture: "enterprise" },
      { cacheHome, inspectors: [producedClean] },
    );
    return { resolved, disposition };
  }

  function declaration(): BindingDeclaration {
    return {
      schemaVersion: 1,
      framework: { id: "ecc", host: "claude" },
      source: {
        kind: "git",
        repository: "affaan-m/ECC",
        commitSha: "a".repeat(40),
        treeDigest: "b".repeat(64),
      },
    };
  }

  it("blocks a sloppy adapter's provision on a forged disposition via the registry wrapper", async () => {
    const registry = new AdapterRegistry();
    registry.register(
      createFakeAdapter({
        framework: "ecc",
        adapterType: "host-plugin",
        resolved: {
          kind: "git",
          repository: "o/r",
          commitSha: "c".repeat(40),
          treeDigest: "d".repeat(64),
          treePath: "/x",
        },
        skipGuard: true,
      }),
    );
    const adapter = registry.get("ecc");
    if (adapter === undefined) throw new Error("adapter missing");
    const { resolved } = await fixture();
    const forged = {
      digest: resolved.treeDigest,
      verdict: "allow",
      findings: [],
      posture: "enterprise",
      producedAt: new Date().toISOString(),
    } as unknown as ScanDisposition;
    const request: ProvisionRequest = { context: { declaration: declaration() }, resolved };
    await expect(adapter.provision(request, forged)).rejects.toBeInstanceOf(BindingScanError);
  });

  it("lets a compliant provision pass through the registry wrapper", async () => {
    const registry = new AdapterRegistry();
    registry.register(
      createFakeAdapter({
        framework: "ecc",
        adapterType: "host-plugin",
        resolved: {
          kind: "git",
          repository: "o/r",
          commitSha: "c".repeat(40),
          treeDigest: "d".repeat(64),
          treePath: "/x",
        },
        skipGuard: true,
      }),
    );
    const adapter = registry.get("ecc");
    if (adapter === undefined) throw new Error("adapter missing");
    const { resolved, disposition } = await fixture();
    const request: ProvisionRequest = { context: { declaration: declaration() }, resolved };
    const result = await adapter.provision(request, disposition);
    expect(result.lock.scannedDigest).toBe(resolved.treeDigest);
  });

  it("dispatches the non-provision contract methods through the wrapper unchanged", async () => {
    const registry = new AdapterRegistry();
    registry.register(
      createFakeAdapter({
        framework: "ecc",
        adapterType: "host-plugin",
        resolved: {
          kind: "git",
          repository: "o/r",
          commitSha: "c".repeat(40),
          treeDigest: "d".repeat(64),
          treePath: "/x",
        },
      }),
    );
    const adapter = registry.get("ecc");
    if (adapter === undefined) throw new Error("adapter missing");
    const context = { declaration: declaration() };
    expect((await adapter.inspect({ treePath: "/t" })).framework).toBe("ecc");
    expect((await adapter.resolve({ declaration: declaration() })).kind).toBe("git");
    expect(adapter.plan(context).framework).toBe("ecc");
    expect(adapter.verify(context).ok).toBe(true);
    expect(adapter.remove(context).mode).toBe("drift-report-only");
    expect(adapter.report(context).framework).toBe("ecc");
  });
});
