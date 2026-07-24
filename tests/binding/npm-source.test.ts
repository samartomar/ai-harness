import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireNpmTree } from "../../src/binding/npm-source.js";
import {
  assertProvisionAuthorized,
  BindingScanError,
  type ResolvedNpmSource,
  resolvedSourceDigest,
  resolveGitSource,
  runFastScanGate,
  scannableFromGit,
  scannableFromNpm,
} from "../../src/binding/scan-gate.js";
import { defaultRunner, fakeRunner, type Runner } from "../../src/internals/proc.js";

const SHA256 = /^[0-9a-f]{64}$/;

let cacheHome: string;
let repoDir: string;

// -- A minimal, dependency-free USTAR builder --------------------------------
// Mirrors the reader's parsing exactly so the round-trip is self-validating, and
// lets a test craft the malicious entries (traversal / absolute / symlink) that
// system `tar` cannot portably produce.

interface TarEntry {
  name: string;
  type?: "0" | "5" | "2";
  content?: string;
  linkname?: string;
}

function tarHeader(name: string, size: number, type: string, linkname: string): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write(type === "5" ? "0000755\0" : "0000644\0", 100, "ascii");
  h.write("0000000\0", 108, "ascii");
  h.write("0000000\0", 116, "ascii");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  h.write("00000000000\0", 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  if (linkname) h.write(linkname.slice(0, 100), 157, "utf8");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += h[i] ?? 0;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

function buildTarGz(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? "0";
    const body = type === "0" ? Buffer.from(entry.content ?? "", "utf8") : Buffer.alloc(0);
    chunks.push(tarHeader(entry.name, body.length, type, entry.linkname ?? ""));
    if (body.length > 0) {
      chunks.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks));
}

function sriOf(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** A package tree under the npm `package/` root prefix. */
function packageTarGz(tree: Record<string, string>, extra: readonly TarEntry[] = []): Buffer {
  const entries: TarEntry[] = [{ name: "package/", type: "5" }];
  for (const [rel, content] of Object.entries(tree)) {
    entries.push({ name: `package/${rel}`, type: "0", content });
  }
  entries.push(...extra);
  return buildTarGz(entries);
}

// A fake npm CLI: `npm pack` drops the prepared tarball into --pack-destination;
// `npm view … gitHead` returns the injected head. Every argv is captured.
function npmRunner(
  opts: { tgz?: Buffer; gitHead?: string; packCode?: number },
  seen: string[][],
): Runner {
  return fakeRunner((argv, runOpts) => {
    seen.push([...argv]);
    if (argv[0] === "npm" && argv[1] === "pack") {
      if (opts.packCode !== undefined && opts.packCode !== 0) {
        return { code: opts.packCode, stderr: "npm pack boom" };
      }
      const destIdx = argv.indexOf("--pack-destination");
      const dir = destIdx >= 0 ? argv[destIdx + 1] : runOpts?.cwd;
      const name = "pkg-1.0.0.tgz";
      if (dir !== undefined && opts.tgz !== undefined) writeFileSync(join(dir, name), opts.tgz);
      return { code: 0, stdout: `${name}\n` };
    }
    if (argv[0] === "npm" && argv[1] === "view") {
      return { code: 0, stdout: `${opts.gitHead ?? ""}\n` };
    }
    return undefined;
  });
}

function npmSource(integrity: string): ResolvedNpmSource {
  return { kind: "npm", package: "pkg", exactVersion: "1.0.0", integrity };
}

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

function initGitRepo(dir: string, files: Record<string, string>): void {
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Binding Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
}

function packCalls(seen: string[][]): string[][] {
  return seen.filter((argv) => argv[0] === "npm" && argv[1] === "pack");
}

beforeEach(() => {
  cacheHome = mkdtempSync(join(tmpdir(), "aih-npm-cache-"));
  repoDir = mkdtempSync(join(tmpdir(), "aih-npm-repo-"));
});

afterEach(() => {
  rmSync(cacheHome, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe("acquireNpmTree — verify, unpack, digest", () => {
  const TREE = {
    "SKILL.md": "# skill\n",
    "README.md": "hello\n",
    "src/index.ts": "export const x = 1;\n",
    "package.json": '{"name":"pkg","version":"1.0.0","license":"MIT"}\n',
  };

  it("packs with --ignore-scripts, SRI-verifies, strips package/, digests, and scans", async () => {
    const tgz = packageTarGz(TREE);
    const integrity = sriOf(tgz);
    const seen: string[][] = [];
    const resolved = await acquireNpmTree(npmSource(integrity), {
      runner: npmRunner({ tgz }, seen),
      cacheHome,
    });

    // The identity is preserved and the tree is materialized + digested.
    expect(resolved.kind).toBe("npm");
    expect(resolved.integrity).toBe(integrity);
    expect(resolved.treeDigest).toMatch(SHA256);
    expect(resolved.treePath && existsSync(resolved.treePath)).toBe(true);
    expect([...(resolved.files ?? [])].sort()).toEqual([
      "README.md",
      "SKILL.md",
      "package.json",
      "src/index.ts",
    ]);

    // The `package/` prefix is stripped: content sits at the tree root.
    const treePath = resolved.treePath as string;
    expect(existsSync(join(treePath, "package"))).toBe(false);
    expect(existsSync(join(treePath, "SKILL.md"))).toBe(true);
    expect(existsSync(join(treePath, "src", "index.ts"))).toBe(true);

    // The pack call carried --ignore-scripts and an exact pkg@version (no range/latest).
    const pack = packCalls(seen)[0] ?? [];
    expect(pack).toContain("--ignore-scripts");
    expect(pack).toContain("pkg@1.0.0");
    expect(
      pack.some((arg) => arg.includes("latest") || arg.includes("^") || arg.includes("*")),
    ).toBe(false);

    // scannableFromNpm feeds runFastScanGate unchanged; the disposition binds the
    // npm identity (its integrity), and the provision guard authorizes it.
    const scannable = scannableFromNpm(resolved);
    expect(scannable.digest).toBe(integrity);
    const disposition = runFastScanGate(scannable, { posture: "enterprise" }, { cacheHome });
    expect(disposition.digest).toBe(integrity);
    expect(disposition.verdict).toBe("allow");
    expect(() =>
      assertProvisionAuthorized(disposition, resolvedSourceDigest(resolved)),
    ).not.toThrow();
  });

  it("rejects a version range, dist-tag, or non-SRI integrity via the schema guards", async () => {
    const tgz = packageTarGz(TREE);
    const seen: string[][] = [];
    const runner = npmRunner({ tgz }, seen);
    for (const bad of [
      { ...npmSource(sriOf(tgz)), exactVersion: "^1.0.0" },
      { ...npmSource(sriOf(tgz)), exactVersion: "latest" },
      { ...npmSource(sriOf(tgz)), exactVersion: "1.x" },
      npmSource(`sha256-${"A".repeat(43)}=`),
      npmSource("not-an-integrity"),
    ]) {
      await expect(
        acquireNpmTree(bad as ResolvedNpmSource, { runner, cacheHome }),
      ).rejects.toBeInstanceOf(BindingScanError);
    }
    // Fail-closed BEFORE any CLI call — the guard rejects the identity first.
    expect(seen).toHaveLength(0);
  });

  it("fails closed on an integrity mismatch: nothing unpacked, staging cleaned, nothing cached", async () => {
    const tgz = packageTarGz(TREE);
    const wrong = sriOf(Buffer.from("a different tarball"));
    const seen: string[][] = [];
    await expect(
      acquireNpmTree(npmSource(wrong), { runner: npmRunner({ tgz }, seen), cacheHome }),
    ).rejects.toBeInstanceOf(BindingScanError);

    // The tarball was fetched (pack ran) but the mismatch stopped everything after.
    expect(packCalls(seen)).toHaveLength(1);
    expect(existsSync(join(cacheHome, "npm"))).toBe(false);
    expect(readdirSync(cacheHome).some((name) => name.startsWith("npm-staging-"))).toBe(false);
  });

  it("verifies gitHead against the registry when asserted, and fails closed on a mismatch", async () => {
    const tgz = packageTarGz(TREE);
    const integrity = sriOf(tgz);
    const head = "a".repeat(40);

    // Match: npm view returns the asserted head → acquisition proceeds and records it.
    const okSeen: string[][] = [];
    const ok = await acquireNpmTree(npmSource(integrity), {
      runner: npmRunner({ tgz, gitHead: head }, okSeen),
      cacheHome,
      expectedGitHead: head,
    });
    expect(ok.gitHead).toBe(head);
    expect(okSeen.some((argv) => argv[0] === "npm" && argv[1] === "view")).toBe(true);

    // Mismatch: registry head differs → fail closed, cache nothing.
    const badHome = mkdtempSync(join(tmpdir(), "aih-npm-cache2-"));
    const badSeen: string[][] = [];
    await expect(
      acquireNpmTree(npmSource(integrity), {
        runner: npmRunner({ tgz, gitHead: "b".repeat(40) }, badSeen),
        cacheHome: badHome,
        expectedGitHead: head,
      }),
    ).rejects.toBeInstanceOf(BindingScanError);
    expect(existsSync(join(badHome, "npm"))).toBe(false);
    rmSync(badHome, { recursive: true, force: true });
  });
});

describe("acquireNpmTree — malicious tarball containment (untrusted input)", () => {
  const OK = { "SKILL.md": "# skill\n" };

  async function expectRefused(extra: TarEntry): Promise<void> {
    const tgz = packageTarGz(OK, [extra]);
    const seen: string[][] = [];
    await expect(
      acquireNpmTree(npmSource(sriOf(tgz)), { runner: npmRunner({ tgz }, seen), cacheHome }),
    ).rejects.toBeInstanceOf(BindingScanError);
    // Nothing materialized in the content-addressed cache, staging cleaned.
    expect(existsSync(join(cacheHome, "npm"))).toBe(false);
    expect(readdirSync(cacheHome).some((name) => name.startsWith("npm-staging-"))).toBe(false);
  }

  it("refuses a `..` traversal entry", async () => {
    await expectRefused({ name: "package/../escape.txt", type: "0", content: "pwn" });
    expect(existsSync(join(cacheHome, "escape.txt"))).toBe(false);
    expect(existsSync(join(cacheHome, "..", "escape.txt"))).toBe(false);
  });

  it("refuses an absolute-path entry", async () => {
    const abs = join(tmpdir(), "aih-abs-escape-should-never-exist.txt");
    rmSync(abs, { force: true });
    await expectRefused({ name: abs.replace(/\\/g, "/"), type: "0", content: "pwn" });
    expect(existsSync(abs)).toBe(false);
  });

  it("refuses a symlink entry", async () => {
    await expectRefused({ name: "package/link", type: "2", linkname: "/etc/passwd" });
  });
});

describe("acquireNpmTree — content-addressed cache", () => {
  const TREE = { "SKILL.md": "# skill\n", "a.txt": "alpha\n" };

  it("serves the cached tree on a second resolve without re-invoking npm", async () => {
    const tgz = packageTarGz(TREE);
    const integrity = sriOf(tgz);
    const seen: string[][] = [];
    const runner = npmRunner({ tgz }, seen);

    const first = await acquireNpmTree(npmSource(integrity), { runner, cacheHome });
    const second = await acquireNpmTree(npmSource(integrity), { runner, cacheHome });

    expect(packCalls(seen)).toHaveLength(1); // second call was a cache hit
    expect(second.treeDigest).toBe(first.treeDigest);
    expect(second.treePath).toBe(first.treePath);
  });

  it("re-acquires when the cached tree is corrupt (digest re-verified, not trusted)", async () => {
    const tgz = packageTarGz(TREE);
    const integrity = sriOf(tgz);
    const seen: string[][] = [];
    const runner = npmRunner({ tgz }, seen);

    const first = await acquireNpmTree(npmSource(integrity), { runner, cacheHome });
    // Tamper the cached tree so its recomputed digest no longer matches.
    writeFileSync(join(first.treePath as string, "a.txt"), "tampered\n");

    const second = await acquireNpmTree(npmSource(integrity), { runner, cacheHome });
    expect(packCalls(seen)).toHaveLength(2); // corruption forced a re-acquire
    expect(second.treeDigest).toBe(first.treeDigest);
    expect(readFileSync(join(second.treePath as string, "a.txt"), "utf8")).toBe("alpha\n");
  });
});

describe("acquireNpmTree — digest comparability & non-collision with git", () => {
  // Newline-free content on purpose: the tree digest hashes raw bytes, and git's
  // platform line-ending policy (core.autocrlf rewrites LF->CRLF on checkout on
  // Windows) would otherwise make the checked-out bytes differ from the tarball
  // bytes. The trees must be byte-identical for the "same idiom -> same digest"
  // comparison to mean anything, so we avoid line endings entirely.
  const TREE = {
    "SKILL.md": "# skill",
    "README.md": "hello",
    "src/index.ts": "export const x = 1;",
  };

  it("digests an identical tree to the same value the git resolver produces", async () => {
    initGitRepo(repoDir, TREE);
    const gitResolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );

    const tgz = packageTarGz(TREE);
    const npmResolved = await acquireNpmTree(npmSource(sriOf(tgz)), {
      runner: npmRunner({ tgz }, []),
      cacheHome,
    });

    // Same tree-hash idiom → identical content digests identically.
    expect(npmResolved.treeDigest).toBe(gitResolved.treeDigest);
  });

  it("keys the scan cache by npm identity so an identical git tree never collides", async () => {
    initGitRepo(repoDir, TREE);
    const gitResolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const tgz = packageTarGz(TREE);
    const integrity = sriOf(tgz);
    const npmResolved = await acquireNpmTree(npmSource(integrity), {
      runner: npmRunner({ tgz }, []),
      cacheHome,
    });

    const gitDisp = runFastScanGate(
      scannableFromGit(gitResolved),
      { posture: "team" },
      { cacheHome },
    );
    const npmDisp = runFastScanGate(
      scannableFromNpm(npmResolved),
      { posture: "team" },
      { cacheHome },
    );

    // Equal trees, DIFFERENT disposition digests (git: treeDigest, npm: integrity).
    expect(gitResolved.treeDigest).toBe(npmResolved.treeDigest);
    expect(gitDisp.digest).toBe(gitResolved.treeDigest);
    expect(npmDisp.digest).toBe(integrity);
    expect(gitDisp.digest).not.toBe(npmDisp.digest);
    // Two distinct cache files — neither tree served the other.
    expect(
      readdirSync(join(cacheHome, "scan-cache")).filter((n) => n.endsWith(".json")),
    ).toHaveLength(2);
  });
});

describe("acquireNpmTree — CLI failure surfaces", () => {
  it("fails closed when npm pack writes no tarball", async () => {
    const seen: string[][] = [];
    await expect(
      acquireNpmTree(npmSource(sriOf(Buffer.from("x"))), {
        runner: npmRunner({ packCode: 1 }, seen),
        cacheHome,
      }),
    ).rejects.toBeInstanceOf(BindingScanError);
  });
});
