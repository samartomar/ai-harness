import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AcceptedContentFinding,
  assertProvisionAuthorized,
  BindingScanError,
  type DimensionReport,
  readScanAcceptanceArtifact,
  resolvedSourceDigest,
  resolveGitSource,
  resolveNpmSource,
  rollupScanFindings,
  runFastScanGate,
  type ScanDisposition,
  scannableFromGit,
} from "../../src/binding/scan-gate.js";
import { defaultRunner, fakeRunner } from "../../src/internals/proc.js";
import { hermeticGitEnv } from "../git-fixture-env.js";
import { fakeBindingGateScan } from "./fake-binding-gate.js";

// Heavy real-git/child-process tests: per-test budgets sized for worker
// contention, not idle hardware — 5s defaults flaked on CI runners (#509).
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const SHA256 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const INTEGRITY = `sha512-${"A".repeat(86)}==`;

let cacheHome: string;
let repoDir: string;

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe", env: hermeticGitEnv() });
}

function initGitRepo(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
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

beforeEach(() => {
  cacheHome = mkdtempSync(join(tmpdir(), "aih-binding-cache-"));
  repoDir = mkdtempSync(join(tmpdir(), "aih-binding-repo-"));
});

afterEach(() => {
  rmSync(cacheHome, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

const producedClean: DimensionReport = { dimension: "structure", status: "produced", findings: [] };

const producedCritical: DimensionReport = {
  dimension: "suspicious-execution",
  status: "produced",
  findings: [
    { code: "trust.malicious-code", severity: "critical", detail: "boom", coverage: "complete" },
  ],
};

/** The gate's deps with Scan's binding gate answering `reports` (unnamed dimensions clean). */
function gateDeps(reports: readonly DimensionReport[] = []) {
  return { cacheHome, scanExecution: fakeBindingGateScan(reports) };
}

function sha256Lf(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** A unicode finding as Scan pins it: path + LF-normalized content hash. */
function unicodeFinding(
  code: "trust.hidden-unicode" | "trust.visible-unicode",
  path: string,
  text: string,
) {
  return {
    code,
    severity: code === "trust.hidden-unicode" ? ("high" as const) : ("medium" as const),
    detail: code === "trust.hidden-unicode" ? "hidden unicode" : "visible non-ASCII typography",
    coverage: "complete" as const,
    path,
    contentSha256: sha256Lf(text),
  };
}

describe("rollupScanFindings", () => {
  it("groups every raw finding deterministically without masking duplicate identities", () => {
    const duplicate = {
      code: "a",
      severity: "medium" as const,
      detail: "a",
      coverage: "complete" as const,
      path: "a.md",
    };
    const findings = [
      {
        code: "z",
        severity: "high" as const,
        detail: "z",
        coverage: "complete" as const,
        path: "b.md",
        accepted: true,
      },
      {
        code: "a",
        severity: "medium" as const,
        detail: "a",
        coverage: "complete" as const,
        path: "a.md",
      },
      duplicate,
      {
        code: "a",
        severity: "high" as const,
        detail: "again",
        coverage: "complete" as const,
        path: "a.md",
      },
      {
        code: "global",
        severity: "critical" as const,
        detail: "global",
        coverage: "complete" as const,
      },
    ];
    expect(rollupScanFindings(findings)).toEqual([
      expect.objectContaining({ path: "a.md", findings: [findings[1], findings[2], findings[3]] }),
      expect.objectContaining({ path: "b.md", findings: [findings[0]] }),
      expect.objectContaining({ path: undefined, findings: [findings[4]] }),
    ]);
  });

  it("is byte-stable across permutations and preserves advisory and content identities", () => {
    const findings = [
      {
        code: "x",
        severity: "high" as const,
        detail: "same",
        coverage: "complete" as const,
        path: "a",
        contentSha256: "b".repeat(64),
        advisory: { reclassifiedFrom: "high" as const, contextClass: "comment" },
      },
      {
        code: "x",
        severity: "high" as const,
        detail: "same",
        coverage: "complete" as const,
        path: "a",
        contentSha256: "a".repeat(64),
        advisory: { reclassifiedFrom: "high" as const, contextClass: "comment" },
      },
    ];
    expect(JSON.stringify(rollupScanFindings(findings))).toBe(
      JSON.stringify(rollupScanFindings([...findings].reverse())),
    );
    expect(rollupScanFindings(findings)[0]?.findings).toHaveLength(2);
  });

  it("keeps absent, false, and true acceptance states deterministically distinct", () => {
    const findings = [
      {
        code: "x",
        severity: "high" as const,
        detail: "same",
        coverage: "complete" as const,
        path: "a",
      },
      {
        code: "x",
        severity: "high" as const,
        detail: "same",
        coverage: "complete" as const,
        path: "a",
        accepted: false,
      },
      {
        code: "x",
        severity: "high" as const,
        detail: "same",
        coverage: "complete" as const,
        path: "a",
        accepted: true,
      },
    ];
    expect(JSON.stringify(rollupScanFindings(findings))).toBe(
      JSON.stringify(rollupScanFindings([...findings].reverse())),
    );
    expect(rollupScanFindings(findings)[0]?.findings.map((finding) => finding.accepted)).toEqual([
      undefined,
      false,
      true,
    ]);
  });
});

// A dimension Scan reports as unavailable, so coverage is incomplete even though
// every other dimension produced.
const missingDim: DimensionReport = {
  dimension: "network-update",
  status: "missing",
  reason: "deep scanner unavailable",
  findings: [],
};

describe("git source resolution (D7 exact identity)", () => {
  it("resolves a ref to an exact 40-char SHA, checks out, and hashes the tree", async () => {
    initGitRepo(repoDir, { "SKILL.md": "# skill\n", "src/index.ts": "export const x = 1;\n" });
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    expect(resolved.kind).toBe("git");
    expect(resolved.commitSha).toMatch(SHA40);
    expect(resolved.treeDigest).toMatch(SHA256);
    expect(existsSync(resolved.treePath)).toBe(true);
    expect(resolvedSourceDigest(resolved)).toBe(resolved.treeDigest);
  });

  it("produces the same tree digest after the derived checkout cache is deleted (rebuildable)", async () => {
    initGitRepo(repoDir, { "SKILL.md": "# skill\n" });
    const first = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    rmSync(join(cacheHome, "cache"), { recursive: true, force: true });
    const second = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    expect(second.commitSha).toBe(first.commitSha);
    expect(second.treeDigest).toBe(first.treeDigest);
  });

  it("accepts an exact commit SHA input without a ref resolution round-trip", async () => {
    initGitRepo(repoDir, { "SKILL.md": "# skill\n" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      env: hermeticGitEnv(),
    })
      .toString()
      .trim();
    const resolved = await resolveGitSource(
      { repository: repoDir, commitSha: head },
      { runner: defaultRunner, cacheHome },
    );
    expect(resolved.commitSha).toBe(head);
  });

  it("fails closed when ls-remote yields no commit SHA", async () => {
    const runner = fakeRunner((argv) => (argv.includes("ls-remote") ? { stdout: "" } : undefined));
    await expect(
      resolveGitSource({ repository: "affaan-m/ECC", ref: "HEAD" }, { runner, cacheHome }),
    ).rejects.toBeInstanceOf(BindingScanError);
  });

  it("maps a bare owner/repo slug to its canonical GitHub https remote for ls-remote and clone", async () => {
    const seen: string[][] = [];
    const runner = fakeRunner((argv) => {
      seen.push([...argv]);
      if (argv[1] === "ls-remote") return { stdout: `${"a".repeat(40)}\tHEAD\n` };
      if (argv[1] === "clone") return { code: 1, stderr: "transport capture only" };
      return undefined;
    });
    await expect(
      resolveGitSource({ repository: "obra/superpowers", ref: "HEAD" }, { runner, cacheHome }),
    ).rejects.toBeInstanceOf(BindingScanError);
    const lsRemote = seen.find((argv) => argv[1] === "ls-remote") ?? [];
    const clone = seen.find((argv) => argv[1] === "clone") ?? [];
    expect(lsRemote[3]).toBe("https://github.com/obra/superpowers.git");
    expect(clone[clone.length - 2]).toBe("https://github.com/obra/superpowers.git");
    expect(lsRemote).not.toContain("obra/superpowers");
    expect(clone).not.toContain("obra/superpowers");
  });

  it("clones via the mapped GitHub remote when a commitSha pin skips ls-remote (W4 live-run regression)", async () => {
    const seen: string[][] = [];
    const runner = fakeRunner((argv) => {
      seen.push([...argv]);
      if (argv[1] === "clone") return { code: 1, stderr: "transport capture only" };
      return undefined;
    });
    await expect(
      resolveGitSource(
        { repository: "obra/superpowers", commitSha: "b36e0829c6d0140e93cfef2ca599b1b07d4a7797" },
        { runner, cacheHome },
      ),
    ).rejects.toBeInstanceOf(BindingScanError);
    expect(seen.some((argv) => argv[1] === "ls-remote")).toBe(false);
    const clone = seen.find((argv) => argv[1] === "clone") ?? [];
    expect(clone[clone.length - 2]).toBe("https://github.com/obra/superpowers.git");
  });

  it("gives transport git calls a tree-scaled timeout instead of proc's 30s default (W4 attempt-4 live-run regression)", async () => {
    const seen: Array<{ argv: string[]; timeoutMs?: number }> = [];
    const runner = fakeRunner((argv, opts) => {
      seen.push({ argv: [...argv], timeoutMs: opts?.timeoutMs });
      if (argv[1] === "ls-remote") return { stdout: `${"a".repeat(40)}\tHEAD\n` };
      if (argv[3] === "checkout") return { code: 1, stderr: "transport capture only" };
      return undefined;
    });
    await expect(
      resolveGitSource({ repository: "samartomar/ECC", ref: "HEAD" }, { runner, cacheHome }),
    ).rejects.toBeInstanceOf(BindingScanError);
    for (const op of ["ls-remote", "clone"]) {
      expect(seen.find((call) => call.argv[1] === op)?.timeoutMs).toBe(120_000);
    }
    expect(seen.find((call) => call.argv[3] === "checkout")?.timeoutMs).toBe(120_000);
  });

  it("passes an https repository locator to git verbatim", async () => {
    const seen: string[][] = [];
    const runner = fakeRunner((argv) => {
      seen.push([...argv]);
      if (argv[1] === "clone") return { code: 1, stderr: "transport capture only" };
      return undefined;
    });
    await expect(
      resolveGitSource(
        { repository: "https://example.com/frameworks/superpowers.git", commitSha: "a".repeat(40) },
        { runner, cacheHome },
      ),
    ).rejects.toBeInstanceOf(BindingScanError);
    const clone = seen.find((argv) => argv[1] === "clone") ?? [];
    expect(clone[clone.length - 2]).toBe("https://example.com/frameworks/superpowers.git");
  });

  it("passes an scp-like repository locator to git verbatim", async () => {
    const seen: string[][] = [];
    const runner = fakeRunner((argv) => {
      seen.push([...argv]);
      if (argv[1] === "clone") return { code: 1, stderr: "transport capture only" };
      return undefined;
    });
    await expect(
      resolveGitSource(
        { repository: "git@github.com:obra/superpowers.git", commitSha: "a".repeat(40) },
        { runner, cacheHome },
      ),
    ).rejects.toBeInstanceOf(BindingScanError);
    const clone = seen.find((argv) => argv[1] === "clone") ?? [];
    expect(clone[clone.length - 2]).toBe("git@github.com:obra/superpowers.git");
  });

  it("rejects an unsafe ref", async () => {
    await expect(
      resolveGitSource(
        { repository: "affaan-m/ECC", ref: "--upload-pack=evil" },
        { runner: defaultRunner, cacheHome },
      ),
    ).rejects.toBeInstanceOf(BindingScanError);
  });
});

describe("npm source resolution (minimal; tarball deferred)", () => {
  it("resolves package identity from injected registry metadata", async () => {
    const resolved = await resolveNpmSource(
      { package: "@obra/superpowers", version: "6.0.0" },
      { fetchMetadata: () => ({ version: "6.0.0", integrity: INTEGRITY }) },
    );
    expect(resolved).toEqual({
      kind: "npm",
      package: "@obra/superpowers",
      exactVersion: "6.0.0",
      integrity: INTEGRITY,
    });
    expect(resolvedSourceDigest(resolved)).toBe(INTEGRITY);
  });

  it("fails closed when registry metadata is not an exact version or SRI integrity", async () => {
    await expect(
      resolveNpmSource(
        { package: "x", version: "latest" },
        { fetchMetadata: () => ({ version: "latest", integrity: INTEGRITY }) },
      ),
    ).rejects.toBeInstanceOf(BindingScanError);
  });

  // W6 replaces the deferred-acquisition throw stub with real acquisition; see
  // tests/binding/npm-source.test.ts for the acquire/verify/unpack/digest suite.
});

describe("fast scan disposition (D12 gate + posture-graded coverage)", () => {
  async function scannable() {
    initGitRepo(repoDir, { "SKILL.md": "# skill\n", "README.md": "hello\n" });
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    return scannableFromGit(resolved);
  }

  it("allows a clean, fully-covered tree at every posture (all 11 dimensions produced)", async () => {
    const src = await scannable();
    for (const posture of ["vibe", "enterprise", "enterprise"] as const) {
      const disposition = await runFastScanGate(src, { posture }, gateDeps());
      expect(disposition.verdict).toBe("allow");
      expect(disposition.digest).toBe(src.digest);
      expect(disposition.findings.every((f) => f.coverage === "complete")).toBe(true);
    }
  });

  it("blocks at enterprise when a dimension is unavailable (incomplete coverage fails closed)", async () => {
    const src = await scannable();
    for (const posture of ["enterprise", "enterprise"] as const) {
      const disposition = await runFastScanGate(
        src,
        { posture },
        gateDeps([producedClean, missingDim]),
      );
      expect(disposition.verdict).toBe("block");
      expect(disposition.findings.some((f) => f.coverage === "incomplete")).toBe(true);
    }
  });

  it("blocks incomplete coverage at vibe without the explicit allowance", async () => {
    const src = await scannable();
    expect(
      (await runFastScanGate(src, { posture: "vibe" }, gateDeps([producedClean, missingDim])))
        .verdict,
    ).toBe("block");
  });

  it("allows incomplete coverage at vibe only when the policy opts in", async () => {
    const src = await scannable();
    expect(
      (
        await runFastScanGate(
          src,
          { posture: "vibe", allowIncompleteAtVibe: true },
          gateDeps([producedClean, missingDim]),
        )
      ).verdict,
    ).toBe("allow");
  });

  it("allows at enterprise when Scan reports complete clean coverage", async () => {
    const src = await scannable();
    const disposition = await runFastScanGate(
      src,
      { posture: "enterprise" },
      gateDeps([producedClean]),
    );
    expect(disposition.verdict).toBe("allow");
    expect(disposition.findings.every((f) => f.coverage === "complete")).toBe(true);
  });

  it("blocks on a danger finding even at vibe with incomplete allowance (danger floor)", async () => {
    const src = await scannable();
    const disposition = await runFastScanGate(
      src,
      { posture: "vibe", allowIncompleteAtVibe: true },
      gateDeps([producedClean, producedCritical]),
    );
    expect(disposition.verdict).toBe("block");
  });

  // Scan states the finding and, for a visible-unicode file, its U+0130 verdict;
  // Core decides. A dotted-I verdict of "machine-sensitive" gates, "advisory"
  // stays a non-blocking advisory, and a hidden-unicode high always gates.
  const TURKISH_UNICODE_CASES = [
    ["dotted İ in prose", "docs/turkish.md", "Turkish İ prose.\n", "trust.visible-unicode", false],
    [
      "dotted İ in a comment",
      "src/turkish.ts",
      "// Turkish İ comment\nexport const value = 1;\n",
      "trust.visible-unicode",
      false,
    ],
    [
      "dotted İ in a string",
      "src/turkish.ts",
      'export const label = "İ string";\n',
      "trust.visible-unicode",
      false,
    ],
    [
      "dotted İ in an identifier",
      "src/turkish.ts",
      "export const İd = 1;\n",
      "trust.visible-unicode",
      true,
    ],
    [
      "dotted İ in a config key",
      "settings.json",
      '{"İd":"value"}\n',
      "trust.visible-unicode",
      true,
    ],
    ["dotless ı in prose", "docs/turkish.md", "Turkish ı prose.\n", "trust.visible-unicode", false],
    [
      "dotless ı in a comment",
      "src/turkish.ts",
      "// Turkish ı comment\nexport const value = 1;\n",
      "trust.visible-unicode",
      false,
    ],
    [
      "dotless ı in a string",
      "src/turkish.ts",
      'export const label = "ı string";\n',
      "trust.visible-unicode",
      false,
    ],
    [
      "dotless ı in an identifier",
      "src/turkish.ts",
      "export const ıd = 1;\n",
      "trust.hidden-unicode",
      undefined,
    ],
    [
      "dotless ı in a config key",
      "settings.json",
      '{"ıd":"value"}\n',
      "trust.hidden-unicode",
      undefined,
    ],
  ] as const;

  it.each(TURKISH_UNICODE_CASES)(
    "%s: Scan's facts give the correct end-to-end gate outcome",
    async (label, path, text, code, dottedIBlocking) => {
      const root = join(repoDir, `turkish-${label.replace(/[^a-z]/gi, "")}`);
      initGitRepo(root, { [path]: text });
      const resolved = await resolveGitSource(
        { repository: root, ref: "HEAD" },
        { runner: defaultRunner, cacheHome },
      );
      const finding = unicodeFinding(code, path, text);
      const disposition = await runFastScanGate(
        scannableFromGit(resolved),
        { posture: "vibe", allowIncompleteAtVibe: true },
        gateDeps([
          {
            dimension: "hidden-unicode",
            status: "produced",
            findings: [finding],
            ...(dottedIBlocking === undefined
              ? {}
              : { dottedIBlocking: { [path]: dottedIBlocking } }),
          },
        ]),
      );
      const expected =
        code === "trust.hidden-unicode" || dottedIBlocking === true ? "block" : "allow";
      expect(disposition.verdict).toBe(expected);
      const gated = disposition.findings.find((candidate) => candidate.code === code);
      expect(gated).toMatchObject({ severity: finding.severity, path });
      if (expected === "allow") expect(gated?.advisory).toBeDefined();
      else expect(gated).not.toHaveProperty("advisory");
    },
  );

  it("gates a visible-unicode finding Scan gave no dotted-I verdict for (uncertain, never a proven advisory)", async () => {
    const path = "docs/turkish.md";
    const text = "Turkish İ prose.\n";
    initGitRepo(repoDir, { [path]: text });
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const finding = unicodeFinding("trust.visible-unicode", path, text);
    const disposition = await runFastScanGate(
      scannableFromGit(resolved),
      {
        posture: "vibe",
        allowIncompleteAtVibe: true,
        acceptedFindings: [
          {
            repository: "test/fixture",
            code: "trust.visible-unicode",
            path,
            fileSha256: finding.contentSha256,
          },
        ],
      },
      gateDeps([{ dimension: "hidden-unicode", status: "produced", findings: [finding] }]),
    );
    expect(disposition.verdict).toBe("block");
    expect(disposition.rawSourceScan).toBe("FINDINGS_PRESENT");
    const gated = disposition.findings.find(
      (candidate) => candidate.code === "trust.visible-unicode",
    );
    expect(gated).not.toHaveProperty("advisory");
    // An uncertain dotted-I finding can never be accepted away.
    expect(gated).not.toHaveProperty("accepted");
  });

  it("keeps dotted İ prose advisory when a different glyph blocks the same file", async () => {
    const root = join(repoDir, "turkish-mixed-context");
    const path = "src/turkish.ts";
    const text = "// Turkish İ prose\nexport const ıd = 1;\n";
    initGitRepo(root, { [path]: text });
    const resolved = await resolveGitSource(
      { repository: root, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const disposition = await runFastScanGate(
      scannableFromGit(resolved),
      { posture: "vibe", allowIncompleteAtVibe: true },
      gateDeps([
        {
          dimension: "hidden-unicode",
          status: "produced",
          findings: [
            unicodeFinding("trust.hidden-unicode", path, text),
            unicodeFinding("trust.visible-unicode", path, text),
          ],
          dottedIBlocking: { [path]: false },
        },
      ]),
    );

    expect(disposition.verdict).toBe("block");
    expect(
      disposition.findings.find((finding) => finding.code === "trust.visible-unicode")?.advisory,
    ).toBeDefined();
    expect(disposition.findings.some((finding) => finding.code === "trust.hidden-unicode")).toBe(
      true,
    );
  });

  it.each(["parent traversal", "symlink"])(
    "fails closed when a deep visible-unicode path escapes the checkout by %s",
    async (escapeKind) => {
      const root = join(repoDir, `deep-visible-unicode-${escapeKind.replace(" ", "-")}`);
      initGitRepo(root, { "src/safe.ts": "export const safe = true;\n" });
      const resolved = await resolveGitSource(
        { repository: root, ref: "HEAD" },
        { runner: defaultRunner, cacheHome },
      );
      const outsideName = `outside-${escapeKind.replace(" ", "-")}.md`;
      const outsidePath = join(resolved.treePath, "..", outsideName);
      const outsideText = "Turkish İ prose.\n";
      writeFileSync(outsidePath, outsideText);
      const path =
        escapeKind === "parent traversal" ? `../${outsideName}` : "src/linked-outside.md";
      if (escapeKind === "symlink") {
        symlinkSync(outsidePath, join(resolved.treePath, path), "file");
      }
      try {
        const contentSha256 = createHash("sha256").update(outsideText, "utf8").digest("hex");
        const disposition = await runFastScanGate(
          scannableFromGit(resolved),
          {
            posture: "vibe",
            allowIncompleteAtVibe: true,
            acceptedFindings: [
              {
                repository: "test/fixture",
                code: "trust.visible-unicode",
                path,
                fileSha256: contentSha256,
              },
            ],
            deepDimensionReports: [
              {
                dimension: "deep-visible-unicode",
                status: "produced",
                findings: [
                  {
                    code: "trust.visible-unicode",
                    severity: "medium",
                    detail: "crafted external visible Unicode",
                    coverage: "complete",
                    path,
                    contentSha256,
                  },
                ],
              },
            ],
          },
          gateDeps(),
        );

        expect(disposition.verdict).toBe("block");
        const finding = disposition.findings.find(
          (candidate) => candidate.code === "trust.visible-unicode",
        );
        expect(finding).toMatchObject({ severity: "medium", path });
        expect(finding).not.toHaveProperty("advisory");
        expect(finding).not.toHaveProperty("accepted");
      } finally {
        rmSync(outsidePath, { force: true });
      }
    },
  );
});

describe("scan cache (derived, rebuildable)", () => {
  it("keeps the validation outcome unchanged after the derived caches are deleted", async () => {
    initGitRepo(repoDir, { "SKILL.md": "# skill\n" });
    const policy = { posture: "enterprise" } as const;
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const first = await runFastScanGate(scannableFromGit(resolved), policy, gateDeps());
    expect(existsSync(join(cacheHome, "scan-cache", `${resolved.treeDigest}.json`))).toBe(true);

    // Delete BOTH derived caches, then rebuild the whole chain from the committed
    // source: re-resolution re-clones and re-hashes; the gate recomputes.
    rmSync(join(cacheHome, "scan-cache"), { recursive: true, force: true });
    rmSync(join(cacheHome, "cache"), { recursive: true, force: true });
    const reResolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const second = await runFastScanGate(scannableFromGit(reResolved), policy, gateDeps());

    expect(second.verdict).toBe(first.verdict);
    expect(second.digest).toBe(first.digest);
    expect(second.findings).toEqual(first.findings);
  });

  it("recomputes rather than failing closed when the derived cache is corrupt", async () => {
    initGitRepo(repoDir, { "SKILL.md": "# skill\n" });
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const src = scannableFromGit(resolved);
    await runFastScanGate(src, { posture: "enterprise" }, gateDeps());
    writeFileSync(join(cacheHome, "scan-cache", `${src.digest}.json`), "{ corrupt");
    const scan = fakeBindingGateScan();
    const recomputed = await runFastScanGate(
      src,
      { posture: "enterprise" },
      { cacheHome, scanExecution: scan },
    );
    expect(recomputed.verdict).toBe("allow");
    expect(scan.requests).toHaveLength(1);
  });

  it("serves a warm schemaVersion-4 record with Scan's facts without asking Scan again", async () => {
    const path = "SKILL.md";
    const text = "# skill İ\n";
    initGitRepo(repoDir, { [path]: text });
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const src = scannableFromGit(resolved);
    const reports: DimensionReport[] = [
      {
        dimension: "hidden-unicode",
        status: "produced",
        findings: [unicodeFinding("trust.visible-unicode", path, text)],
        dottedIBlocking: { [path]: false },
      },
    ];
    const first = await runFastScanGate(src, { posture: "vibe" }, gateDeps(reports));
    const record = JSON.parse(
      readFileSync(join(cacheHome, "scan-cache", `${src.digest}.json`), "utf8"),
    ) as { schemaVersion: number; reports: DimensionReport[] };
    expect(record.schemaVersion).toBe(4);
    expect(record.reports.find((r) => r.dimension === "hidden-unicode")?.dottedIBlocking).toEqual({
      [path]: false,
    });

    const scan = fakeBindingGateScan();
    const warm = await runFastScanGate(
      src,
      { posture: "vibe" },
      { cacheHome, scanExecution: scan },
    );
    expect(scan.requests).toHaveLength(0);
    expect(warm.verdict).toBe("allow");
    expect(warm.findings).toEqual(first.findings);
    expect(warm.findings.find((f) => f.code === "trust.visible-unicode")?.advisory).toBeDefined();
  });

  it("treats a schemaVersion-3 record (no Scan facts) as a miss and asks Scan again", async () => {
    initGitRepo(repoDir, { "SKILL.md": "# skill\n" });
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const src = scannableFromGit(resolved);
    await runFastScanGate(src, { posture: "vibe" }, gateDeps());
    const cachePath = join(cacheHome, "scan-cache", `${src.digest}.json`);
    const record = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    writeFileSync(cachePath, `${JSON.stringify({ ...record, schemaVersion: 3 })}\n`);
    const scan = fakeBindingGateScan();
    await runFastScanGate(src, { posture: "vibe" }, { cacheHome, scanExecution: scan });
    expect(scan.requests).toHaveLength(1);
  });
});

describe("provision authorization guard (D12 code-path invariant)", () => {
  async function allowDisposition(): Promise<{ disposition: ScanDisposition; digest: string }> {
    initGitRepo(repoDir, { "SKILL.md": "# skill\n" });
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const src = scannableFromGit(resolved);
    const disposition = await runFastScanGate(
      src,
      { posture: "enterprise" },
      gateDeps([producedClean]),
    );
    return { disposition, digest: src.digest };
  }

  it("authorizes an allow disposition whose digest matches the resolved source", async () => {
    const { disposition, digest } = await allowDisposition();
    expect(() => assertProvisionAuthorized(disposition, digest)).not.toThrow();
  });

  it("rejects a digest mismatch (stale disposition)", async () => {
    const { disposition } = await allowDisposition();
    expect(() => assertProvisionAuthorized(disposition, "f".repeat(64))).toThrow(BindingScanError);
  });

  it("rejects a block verdict", async () => {
    initGitRepo(repoDir, { "SKILL.md": "# skill\n" });
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const src = scannableFromGit(resolved);
    const blocked = await runFastScanGate(
      src,
      { posture: "enterprise" },
      gateDeps([producedCritical]),
    );
    expect(() => assertProvisionAuthorized(blocked, src.digest)).toThrow(BindingScanError);
  });

  it("rejects a forged, structurally identical disposition with no brand", async () => {
    const { digest } = await allowDisposition();
    const forged = {
      digest,
      verdict: "allow",
      findings: [],
      posture: "enterprise",
      producedAt: new Date().toISOString(),
    } as unknown as ScanDisposition;
    expect(() => assertProvisionAuthorized(forged, digest)).toThrow(BindingScanError);
  });
});

describe("maintainer-accepted content findings (scan-acceptance baseline)", () => {
  // U+200B inside instruction text: a genuinely hidden character Scan reports
  // as trust.hidden-unicode (high), pinned to the file's content hash.
  const ZWSP = String.fromCharCode(0x200b);
  const HIDDEN_SKILL = `# skill\n\nzero${ZWSP}width instruction\n`;

  function sha256Utf8(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  async function hiddenUnicodeScannable(extraFiles: Record<string, string> = {}) {
    initGitRepo(repoDir, { "SKILL.md": HIDDEN_SKILL, "README.md": "hello\n", ...extraFiles });
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    return scannableFromGit(resolved);
  }

  /** Scan's report: every file carrying a ZWSP is a pinned hidden-unicode high. */
  function hiddenUnicodeReport(extraFiles: Record<string, string> = {}): DimensionReport {
    const files: Record<string, string> = { "SKILL.md": HIDDEN_SKILL, ...extraFiles };
    return {
      dimension: "hidden-unicode",
      status: "produced",
      findings: Object.entries(files)
        .filter(([, text]) => text.includes(ZWSP))
        .map(([path, text]) => ({
          ...unicodeFinding("trust.hidden-unicode", path, text),
          contentSha256: sha256Utf8(text),
        })),
    };
  }

  const acceptSkill: AcceptedContentFinding = {
    repository: "test/fixture",
    code: "trust.hidden-unicode",
    path: "SKILL.md",
    fileSha256: sha256Utf8(HIDDEN_SKILL),
  };

  it("blocks an unaccepted hidden-unicode high and pins it with path + content hash", async () => {
    const src = await hiddenUnicodeScannable();
    const disposition = await runFastScanGate(
      src,
      { posture: "vibe" },
      gateDeps([hiddenUnicodeReport()]),
    );
    expect(disposition.verdict).toBe("block");
    const finding = disposition.findings.find((f) => f.code === "trust.hidden-unicode");
    expect(finding?.path).toBe("SKILL.md");
    expect(finding?.contentSha256).toBe(sha256Utf8(HIDDEN_SKILL));
    expect(finding?.accepted).toBeUndefined();
  });

  it("allows when every high finding matches an accepted triple, keeping the findings marked in evidence", async () => {
    const src = await hiddenUnicodeScannable();
    const disposition = await runFastScanGate(
      src,
      { posture: "vibe", acceptedFindings: [acceptSkill] },
      gateDeps([hiddenUnicodeReport()]),
    );
    expect(disposition.verdict).toBe("allow");
    const finding = disposition.findings.find((f) => f.code === "trust.hidden-unicode");
    expect(finding?.accepted).toBe(true);
    expect(finding?.path).toBe("SKILL.md");
  });

  it("keeps blocking when the accepted entry's content hash no longer matches (content-pinned)", async () => {
    const src = await hiddenUnicodeScannable();
    const stale: AcceptedContentFinding = { ...acceptSkill, fileSha256: "a".repeat(64) };
    const disposition = await runFastScanGate(
      src,
      { posture: "vibe", acceptedFindings: [stale] },
      gateDeps([hiddenUnicodeReport()]),
    );
    expect(disposition.verdict).toBe("block");
  });

  it("keeps blocking when a new high finding appears alongside accepted ones", async () => {
    const other = { "notes/OTHER.md": `also${ZWSP}hidden\n` };
    const src = await hiddenUnicodeScannable(other);
    const disposition = await runFastScanGate(
      src,
      { posture: "vibe", acceptedFindings: [acceptSkill] },
      gateDeps([hiddenUnicodeReport(other)]),
    );
    expect(disposition.verdict).toBe("block");
  });

  it("never accepts a critical finding, even when the baseline lists its exact triple", async () => {
    // Scan may only pin a path Core sent, so x.js is part of the tree.
    const src = await hiddenUnicodeScannable({ "x.js": "boom();\n" });
    const criticalWithPin: DimensionReport = {
      dimension: "suspicious-execution",
      status: "produced",
      findings: [
        {
          code: "trust.malicious-code",
          severity: "critical",
          detail: "boom",
          coverage: "complete",
          path: "x.js",
          contentSha256: "ab".repeat(32),
        },
      ],
    };
    const disposition = await runFastScanGate(
      src,
      {
        posture: "vibe",
        acceptedFindings: [
          {
            repository: "test/fixture",
            code: "trust.malicious-code",
            path: "x.js",
            fileSha256: "ab".repeat(32),
          },
        ],
      },
      gateDeps([criticalWithPin]),
    );
    expect(disposition.verdict).toBe("block");
  });

  it("ignores a schemaVersion-1 scan-cache record (pre-acceptance format) and recomputes", async () => {
    initGitRepo(repoDir, { "SKILL.md": "# skill\n" });
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const src = scannableFromGit(resolved);
    expect((await runFastScanGate(src, { posture: "vibe" }, gateDeps())).verdict).toBe("allow");
    // A stale v1 record fabricating a critical finding must be a cache MISS,
    // not a served verdict: the acceptance fields it cannot carry would
    // otherwise silently disable the baseline for this digest.
    writeFileSync(
      join(cacheHome, "scan-cache", `${src.digest}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        digest: src.digest,
        scannedAt: "2026-01-01T00:00:00.000Z",
        reports: [
          {
            dimension: "legacy",
            status: "produced",
            findings: [
              {
                code: "trust.malicious-code",
                severity: "critical",
                detail: "stale",
                coverage: "complete",
              },
            ],
          },
        ],
      })}\n`,
    );
    expect((await runFastScanGate(src, { posture: "vibe" }, gateDeps())).verdict).toBe("allow");
  });

  it("ships the #804 empty acceptance ledger", () => {
    const artifact = readScanAcceptanceArtifact();
    expect(artifact.accepted).toEqual([]);
  });
});
