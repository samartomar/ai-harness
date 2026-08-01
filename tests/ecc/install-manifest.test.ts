import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ECC_INSTALL_MANIFEST_SCHEMA_VERSION,
  type EccInstallManifest,
  EccInstallManifestError,
  type EccManifestInstall,
  type EccManifestSource,
  eccInstallManifestPath,
  evaluateEccInstallDrift,
  hashManagedFile,
  readEccInstallManifest,
  upsertEccInstall,
  writeEccInstallManifestAtomic,
} from "../../src/ecc/install-manifest.js";

let root: string;
let kiroRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-manifest-"));
  kiroRoot = join(root, ".kiro");
  mkdirSync(kiroRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

describe("hashManagedFile — ownership hashing reads regular files only", () => {
  it("hashes a regular file's exact bytes", () => {
    writeFileSync(join(kiroRoot, "agent.md"), "hello\n");
    expect(hashManagedFile(kiroRoot, "agent.md")).toBe(sha256("hello\n"));
  });

  it("returns undefined for an absent path", () => {
    expect(hashManagedFile(kiroRoot, "nope.md")).toBeUndefined();
  });

  it("returns undefined for a directory rather than hashing it", () => {
    mkdirSync(join(kiroRoot, "skills"), { recursive: true });
    expect(hashManagedFile(kiroRoot, "skills")).toBeUndefined();
  });

  // The guard that matters: ownership is decided by this hash, so following a symlink
  // would let content outside the managed root be recorded as AIH-owned, or let a
  // swapped link mask a stale file as current. Never follow, never hash the target.
  it("returns undefined for a symlink instead of hashing its target", () => {
    const outside = mkdtempSync(join(tmpdir(), "aih-ecc-outside-"));
    try {
      writeFileSync(join(outside, "real.md"), "outside\n");
      try {
        symlinkSync(join(outside, "real.md"), join(kiroRoot, "link.md"), "file");
      } catch {
        return; // unprivileged Windows cannot create symlinks; nothing to assert
      }
      expect(hashManagedFile(kiroRoot, "link.md")).toBeUndefined();
      expect(hashManagedFile(kiroRoot, "link.md")).not.toBe(sha256("outside\n"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

function sourceA(): EccManifestSource {
  return {
    kind: "git-checkout",
    ref: "main",
    commit: "a".repeat(40),
    package: null,
    version: null,
  };
}

function sourceB(): EccManifestSource {
  return { ...sourceA(), commit: "b".repeat(40) };
}

function install(overrides: Partial<EccManifestInstall> = {}): EccManifestInstall {
  return {
    target: "kiro",
    mechanism: "native-script",
    root: resolve(kiroRoot),
    installedAt: "2026-07-31T00:00:00.000Z",
    source: sourceA(),
    files: [
      { path: "steering/00-canon.md", sha256: sha256("canon") },
      { path: "agents/reviewer.md", sha256: sha256("reviewer") },
    ],
    ...overrides,
  };
}

function manifest(installs: EccManifestInstall[] = [install()]): EccInstallManifest {
  return { schemaVersion: ECC_INSTALL_MANIFEST_SCHEMA_VERSION, installs };
}

/** Classify one target against an in-memory picture of its destination tree. */
function drift(
  disk: Record<string, string>,
  options: { manifest?: EccInstallManifest; currentSource?: EccManifestSource } = {},
) {
  return evaluateEccInstallDrift({
    manifest: "manifest" in options ? options.manifest : manifest(),
    target: "kiro",
    root: resolve(kiroRoot),
    presentPaths: Object.keys(disk).sort(),
    hashAt: (path) => {
      const contents = disk[path];
      return contents === undefined ? undefined : sha256(contents);
    },
    currentSource: "currentSource" in options ? options.currentSource : sourceA(),
  });
}

describe("ECC install manifest — repo-local state", () => {
  it("lives under the repo-local .aih/ecc state dir, never inside the target dir", () => {
    expect(eccInstallManifestPath(root)).toBe(join(root, ".aih", "ecc", "install-manifest.json"));
  });

  it("round-trips a written manifest", () => {
    writeEccInstallManifestAtomic(root, manifest());
    const read = readEccInstallManifest(root);
    expect(read.present).toBe(true);
    if (!read.present) return;
    expect(read.manifest.installs).toHaveLength(1);
    expect(read.manifest.installs[0]?.target).toBe("kiro");
    expect(read.manifest.installs[0]?.source.commit).toBe("a".repeat(40));
  });

  it("reports absent when no manifest has ever been written", () => {
    expect(readEccInstallManifest(root).present).toBe(false);
  });

  it("fails closed on unparseable JSON rather than reporting an empty manifest", () => {
    mkdirSync(join(root, ".aih", "ecc"), { recursive: true });
    writeFileSync(eccInstallManifestPath(root), "{not json", "utf8");
    expect(() => readEccInstallManifest(root)).toThrow(EccInstallManifestError);
  });

  it("fails closed on a schema-invalid manifest", () => {
    mkdirSync(join(root, ".aih", "ecc"), { recursive: true });
    writeFileSync(
      eccInstallManifestPath(root),
      JSON.stringify({
        schemaVersion: ECC_INSTALL_MANIFEST_SCHEMA_VERSION,
        installs: [{ target: "kiro" }],
      }),
      "utf8",
    );
    expect(() => readEccInstallManifest(root)).toThrow(EccInstallManifestError);
  });

  it("refuses a recorded file path that escapes the managed root", () => {
    expect(() =>
      writeEccInstallManifestAtomic(
        root,
        manifest([install({ files: [{ path: "../../evil.md", sha256: sha256("x") }] })]),
      ),
    ).toThrow(EccInstallManifestError);
  });

  it("refuses an absolute recorded file path", () => {
    expect(() =>
      writeEccInstallManifestAtomic(
        root,
        manifest([install({ files: [{ path: "/etc/passwd", sha256: sha256("x") }] })]),
      ),
    ).toThrow(EccInstallManifestError);
  });

  it("writes a trailing-newline JSON document", () => {
    writeEccInstallManifestAtomic(root, manifest());
    expect(readFileSync(eccInstallManifestPath(root), "utf8")).toMatch(/\n$/);
  });

  it("replaces only the matching (target, root) entry on rerun", () => {
    const codex = install({
      target: "codex",
      mechanism: "checkout-merge",
      root: join(root, ".codex"),
    });
    const next = upsertEccInstall(manifest([install(), codex]), install({ source: sourceB() }));
    expect(next.installs).toHaveLength(2);
    expect(next.installs.find((entry) => entry.target === "kiro")?.source.commit).toBe(
      "b".repeat(40),
    );
    expect(next.installs.find((entry) => entry.target === "codex")?.source.commit).toBe(
      "a".repeat(40),
    );
  });
});

describe("ECC install manifest — three-state ownership", () => {
  it("reports an untouched file installed from the current source as AIH-owned", () => {
    const result = drift({ "steering/00-canon.md": "canon", "agents/reviewer.md": "reviewer" });
    expect(result.counts["aih-owned"]).toBe(2);
    expect(result.counts.stale).toBe(0);
    expect(result.counts["user-modified"]).toBe(0);
    expect(result.counts["unknown-provenance"]).toBe(0);
    expect(result.stale).toBe(false);
  });

  it("reports an untouched file as STALE once the source identity moved on", () => {
    const result = drift(
      { "steering/00-canon.md": "canon", "agents/reviewer.md": "reviewer" },
      { currentSource: sourceB() },
    );
    expect(result.counts.stale).toBe(2);
    expect(result.counts["aih-owned"]).toBe(0);
    expect(result.stale).toBe(true);
  });

  it("reports a locally edited file as user-modified and NEVER as stale", () => {
    const result = drift(
      { "steering/00-canon.md": "operator edited this", "agents/reviewer.md": "reviewer" },
      { currentSource: sourceB() },
    );
    expect(result.counts["user-modified"]).toBe(1);
    expect(result.counts.stale).toBe(1);
    expect(
      result.samples.some(
        (sample) => sample.state === "user-modified" && sample.path === "steering/00-canon.md",
      ),
    ).toBe(true);
  });

  it("never claims staleness when the current source identity is unknown", () => {
    const result = drift(
      { "steering/00-canon.md": "canon", "agents/reviewer.md": "reviewer" },
      { currentSource: undefined },
    );
    expect(result.counts.stale).toBe(0);
    expect(result.counts["aih-owned"]).toBe(2);
  });

  it("never claims staleness when the current commit could not be resolved", () => {
    const result = drift(
      { "steering/00-canon.md": "canon", "agents/reviewer.md": "reviewer" },
      { currentSource: { ...sourceB(), commit: null } },
    );
    expect(result.counts.stale).toBe(0);
    expect(result.counts["aih-owned"]).toBe(2);
  });

  it("never claims staleness when the RECORDED commit was never captured", () => {
    const result = drift(
      { "steering/00-canon.md": "canon", "agents/reviewer.md": "reviewer" },
      {
        manifest: manifest([install({ source: { ...sourceA(), commit: null } })]),
        currentSource: sourceB(),
      },
    );
    expect(result.counts.stale).toBe(0);
    expect(result.counts["aih-owned"]).toBe(2);
  });

  it("compares npm installs by package and version, not by commit", () => {
    const npmA = {
      kind: "npm" as const,
      ref: null,
      commit: null,
      package: "ecc-universal",
      version: "2.1.0",
    };
    const stale = drift(
      { "steering/00-canon.md": "canon", "agents/reviewer.md": "reviewer" },
      {
        manifest: manifest([install({ mechanism: "npm", source: npmA })]),
        currentSource: { ...npmA, version: "2.2.0" },
      },
    );
    expect(stale.counts.stale).toBe(2);

    const current = drift(
      { "steering/00-canon.md": "canon", "agents/reviewer.md": "reviewer" },
      {
        manifest: manifest([install({ mechanism: "npm", source: npmA })]),
        currentSource: { ...npmA },
      },
    );
    expect(current.counts.stale).toBe(0);
    expect(current.counts["aih-owned"]).toBe(2);
  });

  it("never compares across mechanisms — an npm identity cannot age a git install", () => {
    const result = drift(
      { "steering/00-canon.md": "canon", "agents/reviewer.md": "reviewer" },
      {
        // Both sides carry a commit, so only the mechanism guard can stop the
        // comparison — a git install must never be aged by an npm identity.
        currentSource: {
          kind: "npm",
          ref: null,
          commit: "b".repeat(40),
          package: "ecc-universal",
          version: "2.1.0",
        },
      },
    );
    expect(result.counts.stale).toBe(0);
    expect(result.counts["aih-owned"]).toBe(2);
  });

  it("reports a recorded file that has since been deleted as removed", () => {
    const result = drift({ "steering/00-canon.md": "canon" });
    expect(result.counts.removed).toBe(1);
  });

  it("never claims a file it did not record — user-owned content stays untouched", () => {
    const result = drift({
      "steering/00-canon.md": "canon",
      "agents/reviewer.md": "reviewer",
      "steering/my-own-notes.md": "mine",
    });
    expect(result.counts["unknown-provenance"]).toBe(1);
    expect(result.counts["aih-owned"]).toBe(2);
    expect(
      result.samples.some(
        (sample) =>
          sample.state === "unknown-provenance" && sample.path === "steering/my-own-notes.md",
      ),
    ).toBe(true);
  });
});

describe("ECC install manifest — installs predating the manifest", () => {
  it("reports every path as unknown provenance when no manifest exists at all", () => {
    const result = drift(
      { "steering/00-canon.md": "canon", "agents/reviewer.md": "reviewer" },
      { manifest: undefined },
    );
    expect(result.counts["unknown-provenance"]).toBe(2);
    expect(result.counts["aih-owned"]).toBe(0);
    expect(result.counts.stale).toBe(0);
    expect(result.provenanceKnown).toBe(false);
  });

  it("reports unknown provenance when the manifest records a different target only", () => {
    const result = drift(
      { "steering/00-canon.md": "canon" },
      { manifest: manifest([install({ target: "codex", root: join(root, ".codex") })]) },
    );
    expect(result.counts["unknown-provenance"]).toBe(1);
    expect(result.provenanceKnown).toBe(false);
  });

  it("does not adopt a pre-manifest file merely because its bytes match the current source", () => {
    // The rejected option: a content match cannot separate an AIH-written file from a
    // user-authored identical one, so byte-identical content still reports unknown.
    const result = drift({ "steering/00-canon.md": "canon" }, { manifest: undefined });
    expect(result.counts["unknown-provenance"]).toBe(1);
    expect(result.counts["aih-owned"]).toBe(0);
  });
});

describe("ECC install manifest — acceptance: installed at source A, re-run at source B", () => {
  it("surfaces an actionable drift finding instead of silently reporting success", () => {
    writeEccInstallManifestAtomic(root, manifest());
    const read = readEccInstallManifest(root);
    expect(read.present).toBe(true);
    if (!read.present) return;

    const result = evaluateEccInstallDrift({
      manifest: read.manifest,
      target: "kiro",
      root: resolve(kiroRoot),
      presentPaths: ["agents/reviewer.md", "steering/00-canon.md"],
      hashAt: (path) => (path === "steering/00-canon.md" ? sha256("canon") : sha256("reviewer")),
      currentSource: sourceB(),
    });

    expect(result.stale).toBe(true);
    expect(result.counts.stale).toBe(2);
    expect(result.recordedSource?.commit).toBe("a".repeat(40));
    expect(result.currentSource?.commit).toBe("b".repeat(40));
  });
});
