import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adaptSkillPackageGraph } from "../../src/capability/package-graph/adapters/skills.js";
import { buildPackageGraphIndex } from "../../src/capability/package-graph/build.js";
import {
  InstalledSkillPackSnapshotError,
  resolveInstalledSkillPackSnapshot,
} from "../../src/capability/package-manager/domains/skill-pack-installed.js";
import { resolveCapabilityPackages } from "../../src/capability/package-manager/resolve.js";

const SHA = "a".repeat(40);
const FILE_BYTES = Buffer.from("# Clean\n", "utf8");
let root: string;

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function fixture() {
  const adapted = adaptSkillPackageGraph({
    lockAuthorityId: "lock:aih-skills",
    catalogAuthorityId: "catalog:aih-packs",
    hostSource: { provider: "github", repository: "host/project" },
    lockBytes: json({
      schemaVersion: 1,
      skills: [
        {
          name: "clean",
          source: `owner/repo@${SHA}`,
          commit: SHA,
          verdict: "GREEN",
          scope: "repo",
          card: "ai-coding/skill-cards/clean.json",
          evidenceSha256: "e".repeat(64),
          approvedBy: "docs-platform",
          approvedAt: "2026-08-09T00:00:00.000Z",
        },
      ],
    }),
    packsBytes: json({
      schemaVersion: 1,
      packs: [
        {
          name: "docs-quality",
          skills: [{ name: "clean", source: `owner/repo@${SHA}`, commit: SHA }],
        },
      ],
    }),
  });
  const index = buildPackageGraphIndex(adapted.documents);
  const authority = index.authorities.find(({ kind }) => kind === "catalog");
  const claim = index.claims.find(
    (candidate) => candidate.entityKind === "package" && candidate.authorityId === authority?.id,
  );
  if (authority === undefined || claim?.entityKind !== "package") {
    throw new Error("expected package fixture");
  }
  const resolution = resolveCapabilityPackages({
    manifest: {
      schemaVersion: 1,
      authorities: [authority],
      roots: [claim.id],
      packages: [
        {
          kind: "package",
          id: claim.id,
          authorityId: claim.authorityId,
          claimDigest: claim.claimDigest,
          sourceDigest: claim.entity.sourceDigest,
          dependencies: [],
          members: claim.entity.members,
        },
      ],
    },
    index,
  });
  return { adapted, index, resolution };
}

function artifactSha(bytes = FILE_BYTES): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function trustSource(overrides: Record<string, unknown> = {}) {
  return {
    id: "owner-repo",
    kind: "github",
    source: "owner/repo",
    ref: "main",
    pinnedSha: SHA,
    promotedAt: "2026-08-09T00:00:00.000Z",
    promotedSkills: ["clean"],
    analyzersRun: ["aih-native"],
    artifactHashes: [{ path: "skills/clean/SKILL.md", sha256: artifactSha() }],
    findings: [],
    ...overrides,
  };
}

function trustLockBytes(sources: unknown[] = [trustSource()]): Buffer {
  return json({ schemaVersion: 1, sources });
}

function installedPath(): string {
  return join(root, "ai-coding", "skills", "owner-repo", "clean", "SKILL.md");
}

function install(bytes = FILE_BYTES): void {
  mkdirSync(join(root, "ai-coding", "skills", "owner-repo", "clean"), { recursive: true });
  writeFileSync(installedPath(), bytes, { mode: 0o640 });
}

function input(overrides: Record<string, unknown> = {}) {
  const value = fixture();
  return {
    root,
    contextDir: "ai-coding",
    resolution: value.resolution,
    index: value.index,
    diagnostics: value.adapted.diagnostics,
    trustLockBytes: trustLockBytes(),
    ...overrides,
  };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("expected installed skill-pack refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(InstalledSkillPackSnapshotError);
    expect((error as InstalledSkillPackSnapshotError).code).toBe(code);
    expect(error).not.toHaveProperty("path");
  }
}

function expectFixedCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("expected installed skill-pack refusal");
  } catch (error) {
    expect(error).toMatchObject({
      name: "InstalledSkillPackSnapshotError",
      code,
    });
    expect(String(error)).not.toContain(root);
  }
}

async function resolverWithFs(overrides: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock("node:fs", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:fs")>()),
    ...overrides,
  }));
  return import("../../src/capability/package-manager/domains/skill-pack-installed.js");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-installed-skill-pack-"));
});

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
});

describe("installed skill-pack snapshots", () => {
  it("returns frozen, deterministic, mutation-isolated exact bindings and files", () => {
    install();
    const request = input();
    const result = resolveInstalledSkillPackSnapshot(request);
    writeFileSync(installedPath(), "changed\n");
    request.trustLockBytes.fill(0);

    expect(result.schemaVersion).toBe(1);
    expect(result.bindings).toHaveLength(1);
    expect(result.files).toEqual([
      {
        memberId: "skill:clean",
        path: "ai-coding/skills/owner-repo/clean/SKILL.md",
        sha256: artifactSha(),
        mode: statSync(installedPath()).mode & 0o777,
        bytes: FILE_BYTES,
      },
    ]);
    expect(result.files[0]?.bytes).toEqual(FILE_BYTES);
    expect(result.files[0]?.bytes).not.toBe(FILE_BYTES);
    const exposedBytes = result.files[0]?.bytes;
    exposedBytes?.fill(0);
    expect(result.files[0]?.bytes).toEqual(FILE_BYTES);
    expect(artifactSha(Buffer.from(result.files[0]?.bytes ?? []))).toBe(result.files[0]?.sha256);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.bindings)).toBe(true);
    expect(Object.isFrozen(result.files)).toBe(true);

    writeFileSync(installedPath(), FILE_BYTES, { mode: 0o640 });
    const shuffled = resolveInstalledSkillPackSnapshot({
      ...input(),
      diagnostics: [...request.diagnostics].reverse(),
    });
    expect(shuffled).toEqual(result);
  });

  it("reruns the authority bridge and rejects hostile input before filesystem access", () => {
    install();
    const invalid = input();
    const forged = structuredClone(invalid.resolution) as unknown as {
      packages: Array<{ claimDigest: string }>;
    };
    const forgedPackage = forged.packages[0];
    if (forgedPackage === undefined) throw new Error("expected package fixture");
    forgedPackage.claimDigest = "f".repeat(64);
    expectCode(
      () => resolveInstalledSkillPackSnapshot({ ...invalid, resolution: forged }),
      "authority-refused",
    );

    let calls = 0;
    const hostile = input();
    Object.defineProperty(hostile, "contextDir", {
      enumerable: true,
      get() {
        calls += 1;
        return "ai-coding";
      },
    });
    expectCode(() => resolveInstalledSkillPackSnapshot(hostile), "invalid-input");
    expect(calls).toBe(0);
  });

  it("strictly rejects malformed, duplicate, missing, extra, and mismatched promotion receipts", () => {
    install();
    expectCode(
      () => resolveInstalledSkillPackSnapshot(input({ trustLockBytes: Buffer.from([0xff]) })),
      "invalid-trust-lock",
    );
    expectCode(
      () =>
        resolveInstalledSkillPackSnapshot(
          input({ trustLockBytes: trustLockBytes([trustSource(), trustSource()]) }),
        ),
      "duplicate-promotion",
    );
    expectCode(
      () =>
        resolveInstalledSkillPackSnapshot(
          input({
            trustLockBytes: trustLockBytes([
              trustSource({
                artifactHashes: [...trustSource().artifactHashes, ...trustSource().artifactHashes],
              }),
            ]),
          }),
        ),
      "invalid-trust-lock",
    );
    expectCode(
      () => resolveInstalledSkillPackSnapshot(input({ trustLockBytes: trustLockBytes([]) })),
      "missing-promotion",
    );
    expectCode(
      () =>
        resolveInstalledSkillPackSnapshot(
          input({
            trustLockBytes: trustLockBytes([trustSource({ pinnedSha: "b".repeat(40) })]),
          }),
        ),
      "source-mismatch",
    );
    expectCode(
      () =>
        resolveInstalledSkillPackSnapshot(
          input({
            trustLockBytes: trustLockBytes([
              trustSource({
                promotedSkills: ["clean", "extra"],
                artifactHashes: [
                  ...trustSource().artifactHashes,
                  { path: "skills/extra/SKILL.md", sha256: "c".repeat(64) },
                ],
              }),
            ]),
          }),
        ),
      "extra-promotion",
    );

    expect(() =>
      resolveInstalledSkillPackSnapshot(
        input({ trustLockBytes: trustLockBytes([trustSource({ source: "OWNER/REPO" })]) }),
      ),
    ).not.toThrow();
  });

  it("revalidates directory identities and complete child sets after reading", async () => {
    install();
    let calls = 0;
    const mockedReaddir = ((...args: unknown[]) => {
      calls += 1;
      if (calls === 2) {
        writeFileSync(join(root, "ai-coding", "skills", "owner-repo", "clean", "late.md"), "late");
      }
      return Reflect.apply(readdirSync, undefined, args);
    }) as unknown as typeof readdirSync;
    const loaded = await resolverWithFs({ readdirSync: mockedReaddir });
    expectFixedCode(
      () => loaded.resolveInstalledSkillPackSnapshot(input()),
      "installed-artifact-mismatch",
    );
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("refuses an expected leaf overwritten during the verification scan", async () => {
    install();
    let calls = 0;
    const mockedReaddir = ((...args: unknown[]) => {
      calls += 1;
      if (calls === 2) writeFileSync(installedPath(), "changed during verification\n");
      return Reflect.apply(readdirSync, undefined, args);
    }) as unknown as typeof readdirSync;
    const loaded = await resolverWithFs({ readdirSync: mockedReaddir });
    expectFixedCode(
      () => loaded.resolveInstalledSkillPackSnapshot(input()),
      "installed-artifact-mismatch",
    );
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("normalizes fstat, read, and close failures to fixed value-free errors", async () => {
    install();
    for (const name of ["fstatSync", "readSync", "closeSync"] as const) {
      const loaded = await resolverWithFs({
        [name]: () => {
          throw new Error(`${root}/hostile\u202e`);
        },
      });
      expectFixedCode(
        () => loaded.resolveInstalledSkillPackSnapshot(input()),
        "unsafe-installed-artifact",
      );
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("rejects absent, changed, and unreceipted installed artifacts", () => {
    expectCode(() => resolveInstalledSkillPackSnapshot(input()), "installed-artifact-mismatch");
    install(Buffer.from("changed\n"));
    expectCode(() => resolveInstalledSkillPackSnapshot(input()), "installed-artifact-mismatch");
    install();
    writeFileSync(join(root, "ai-coding", "skills", "owner-repo", "clean", "extra.md"), "extra");
    expectCode(() => resolveInstalledSkillPackSnapshot(input()), "installed-artifact-mismatch");
  });

  it("rejects partial receipts and symlinked installed parent directories", () => {
    install();
    const readmeBytes = Buffer.from("# Readme\n");
    expectCode(
      () =>
        resolveInstalledSkillPackSnapshot(
          input({
            trustLockBytes: trustLockBytes([
              trustSource({
                artifactHashes: [
                  { path: "skills/clean/README.md", sha256: artifactSha(readmeBytes) },
                ],
              }),
            ]),
          }),
        ),
      "artifact-refused",
    );

    const ownerRoot = join(root, "ai-coding", "skills", "owner-repo");
    const outsideRoot = join(root, "outside-owner");
    renameSync(ownerRoot, outsideRoot);
    symlinkSync(outsideRoot, ownerRoot, "dir");
    expectCode(() => resolveInstalledSkillPackSnapshot(input()), "unsafe-installed-artifact");
  });

  it("rejects symlink, hardlink, oversized, and case-fold-colliding installed artifacts", () => {
    install();
    const outside = join(root, "outside.md");
    writeFileSync(outside, FILE_BYTES);
    rmSync(installedPath());
    symlinkSync(outside, installedPath());
    expectCode(() => resolveInstalledSkillPackSnapshot(input()), "unsafe-installed-artifact");

    rmSync(installedPath());
    writeFileSync(installedPath(), FILE_BYTES);
    const hardlink = join(root, "ai-coding", "skills", "owner-repo", "clean", "hard.md");
    linkSync(installedPath(), hardlink);
    expectCode(() => resolveInstalledSkillPackSnapshot(input()), "unsafe-installed-artifact");
    rmSync(hardlink);

    truncateSync(installedPath(), 8 * 1024 * 1024 + 1);
    expectCode(() => resolveInstalledSkillPackSnapshot(input()), "unsafe-installed-artifact");

    install();
    const folded = join(root, "ai-coding", "skills", "owner-repo", "clean", "skill.md");
    writeFileSync(folded, FILE_BYTES);
    if (realpathSync(folded) !== realpathSync(installedPath())) {
      expectCode(() => resolveInstalledSkillPackSnapshot(input()), "unsafe-installed-artifact");
    }
  });
});
