import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import shippedAcceptanceJson from "../../src/binding/scan-acceptance.json";
import {
  checkSuperpowersScanAcceptance,
  runScanAcceptanceCli,
  type ScanAcceptanceArtifact,
  type ScanAcceptanceCheckDeps,
  ScanAcceptanceCheckError,
} from "../../src/binding/scan-acceptance-check.js";
import { type DimensionReport, inspectTree } from "../../src/binding/scan-gate.js";
import { defaultRunner, type Runner } from "../../src/internals/proc.js";
import { hermeticGitEnv } from "../git-fixture-env.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const SUPERPOWERS_COMMIT = "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9";
const ZWSP = String.fromCharCode(0x200b);

let tempRoot: string;
let checkout: string;

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe", env: hermeticGitEnv() });
}

function gitOutput(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: hermeticGitEnv() }).trim();
}

function initVendorCheckout(files: Record<string, string>): void {
  mkdirSync(checkout, { recursive: true });
  git(checkout, ["init", "-b", "main"]);
  git(checkout, ["config", "user.email", "test@example.com"]);
  git(checkout, ["config", "user.name", "Scan Acceptance Test"]);
  git(checkout, ["config", "commit.gpgsign", "false"]);
  git(checkout, ["remote", "add", "origin", "https://github.com/obra/superpowers.git"]);
  for (const [path, content] of Object.entries(files)) {
    const target = join(checkout, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-m", "fixture"]);
  git(checkout, ["checkout", "--detach", "HEAD"]);
}

function artifact(
  entries: readonly { code: string; path: string; fileSha256: string }[],
): ScanAcceptanceArtifact {
  return {
    schemaVersion: 2,
    reason: "fixture",
    accepted: entries.map((entry) => ({ repository: "obra/superpowers", ...entry })),
  };
}

const pinnedCheckoutRunner: Runner = async (argv, options) => {
  const result = await defaultRunner(argv, options);
  return argv.at(-2) === "rev-parse" && argv.at(-1) === "HEAD"
    ? { ...result, stdout: `${SUPERPOWERS_COMMIT}\n` }
    : result;
};

function fixtureDeps(acceptanceArtifact: unknown, inspect = inspectTree): ScanAcceptanceCheckDeps {
  return { acceptanceArtifact, inspectTree: inspect, runner: pinnedCheckoutRunner };
}

function pinnedContentFindings(reports: readonly DimensionReport[]) {
  return reports.flatMap((report) =>
    report.findings.flatMap((finding) =>
      finding.path !== undefined && finding.contentSha256 !== undefined ? [finding] : [],
    ),
  );
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "aih-scan-acceptance-"));
  checkout = join(tempRoot, "superpowers");
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("checkSuperpowersScanAcceptance", () => {
  it("ships no historical accepted rows", async () => {
    // The exact vendor tree is intentionally external; its 3dcbd5c audit belongs
    // to a disposable checkout. This regression proves the shipped ledger itself
    // has no historical rows through the production checker seam.
    initVendorCheckout({ "SKILL.md": "safe\n" });

    const report = await checkSuperpowersScanAcceptance(
      { checkoutPath: checkout },
      fixtureDeps(shippedAcceptanceJson, () => []),
    );

    expect(report.accepted).toEqual([]);
    expect(report.missing).toEqual([]);
  });

  it("uses real inspector pins with CRLF compatibility and repeatable byte-identical JSON", async () => {
    initVendorCheckout({ "a.md": `a${ZWSP}\r\n`, "z.md": `z${ZWSP}\r\n` });
    const inspected = pinnedContentFindings(inspectTree(checkout));
    const accepted = artifact(
      inspected.map((finding) => ({
        code: finding.code,
        path: finding.path as string,
        fileSha256: finding.contentSha256 as string,
      })),
    );
    const expectedCrLfHash = createHash("sha256").update(`a${ZWSP}\n`, "utf8").digest("hex");
    expect(inspected.find((finding) => finding.path === "a.md")?.contentSha256).toBe(
      expectedCrLfHash,
    );

    const first = await checkSuperpowersScanAcceptance(
      { checkoutPath: checkout },
      fixtureDeps(accepted),
    );
    const second = await checkSuperpowersScanAcceptance(
      { checkoutPath: checkout },
      fixtureDeps(accepted),
    );

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).not.toContain(checkout);
    expect(first.new).toEqual([]);
    expect(first.authorizes).toBe(false);
    expect(gitStatus(checkout)).toBe("");
  });

  it("reports stale, missing, new, and critical scanner findings without caller observations", async () => {
    initVendorCheckout({ "SKILL.md": `unsafe${ZWSP}\n` });
    const finding = pinnedContentFindings(inspectTree(checkout))[0];
    if (finding?.path === undefined || finding.contentSha256 === undefined)
      throw new Error("fixture finding missing");
    const criticalReports: DimensionReport[] = [
      {
        dimension: "critical",
        status: "produced",
        findings: [
          {
            code: finding.code,
            severity: finding.severity,
            detail: "changed fixture",
            coverage: "complete",
            path: finding.path,
            contentSha256: "c".repeat(64),
          },
          {
            code: "trust.malicious-code",
            severity: "critical",
            detail: "fixture",
            coverage: "complete",
            path: "SKILL.md",
            contentSha256: finding.contentSha256,
          },
        ],
      },
    ];
    const report = await checkSuperpowersScanAcceptance(
      { checkoutPath: checkout },
      fixtureDeps(
        artifact([
          { code: finding.code, path: finding.path, fileSha256: "a".repeat(64) },
          { code: "trust.hidden-unicode", path: "missing.md", fileSha256: "b".repeat(64) },
          { code: "trust.malicious-code", path: "SKILL.md", fileSha256: finding.contentSha256 },
        ]),
        () => criticalReports,
      ),
    );

    expect(report.stale).toHaveLength(1);
    expect(report.missing).toHaveLength(1);
    expect(report.new).toHaveLength(2);
    expect(report.critical).toHaveLength(1);
    expect(report.accepted).toEqual([]);
    expect(report.authorizes).toBe(false);
  });

  it("rejects malformed, duplicate, absolute, and traversal acceptance entries", async () => {
    initVendorCheckout({ "SKILL.md": "safe\n" });
    for (const accepted of [
      [{ code: "trust.hidden-unicode", path: "../SKILL.md", fileSha256: "a".repeat(64) }],
      [{ code: "trust.hidden-unicode", path: "/SKILL.md", fileSha256: "a".repeat(64) }],
      [{ code: "trust.hidden-unicode", path: "SKILL.md", fileSha256: "invalid" }],
      [
        { code: "trust.hidden-unicode", path: "SKILL.md", fileSha256: "a".repeat(64) },
        { code: "trust.hidden-unicode", path: "SKILL.md", fileSha256: "b".repeat(64) },
      ],
    ]) {
      await expect(
        checkSuperpowersScanAcceptance({ checkoutPath: checkout }, fixtureDeps(artifact(accepted))),
      ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
    }
  });

  it("rejects a checkout subdirectory before inspection", async () => {
    initVendorCheckout({ "nested/SKILL.md": "safe\n" });
    let inspections = 0;
    await expect(
      checkSuperpowersScanAcceptance(
        { checkoutPath: join(checkout, "nested") },
        fixtureDeps(artifact([]), () => {
          inspections += 1;
          return [];
        }),
      ),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
    expect(inspections).toBe(0);
  });

  it("rejects a malformed Git top-level result before inspection", async () => {
    initVendorCheckout({ "SKILL.md": "safe\n" });
    let inspections = 0;
    const malformedTopLevelRunner: Runner = async (argv, options) => {
      const result = await pinnedCheckoutRunner(argv, options);
      return argv.at(-2) === "rev-parse" && argv.at(-1) === "--show-toplevel"
        ? { ...result, stdout: `${join(checkout, "not-a-directory")}\n` }
        : result;
    };
    await expect(
      checkSuperpowersScanAcceptance(
        { checkoutPath: checkout },
        {
          ...fixtureDeps(artifact([]), () => {
            inspections += 1;
            return [];
          }),
          runner: malformedTopLevelRunner,
        },
      ),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
    expect(inspections).toBe(0);
  });

  it("rejects ignored checkout content before inspection", async () => {
    initVendorCheckout({ ".gitignore": "ignored/\n", "SKILL.md": "safe\n" });
    const ignoredPath = join(checkout, "ignored", "nested", "risk.md");
    mkdirSync(dirname(ignoredPath), { recursive: true });
    writeFileSync(ignoredPath, "unsafe\n", "utf8");
    let inspections = 0;
    await expect(
      checkSuperpowersScanAcceptance(
        { checkoutPath: checkout },
        fixtureDeps(artifact([]), () => {
          inspections += 1;
          return [];
        }),
      ),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
    expect(inspections).toBe(0);
  });

  it("accepts constrained GitHub Superpowers origin equivalents", async () => {
    initVendorCheckout({ "SKILL.md": "safe\n" });
    for (const remote of [
      "https://github.com/obra/Superpowers",
      "https://github.com/obra/Superpowers.git/",
      "git@github.com:obra/Superpowers.git",
      "ssh://git@github.com/obra/Superpowers.git",
    ]) {
      git(checkout, ["remote", "set-url", "origin", remote]);
      await expect(
        checkSuperpowersScanAcceptance({ checkoutPath: checkout }, fixtureDeps(artifact([]))),
      ).resolves.toMatchObject({ authorizes: false });
    }
  });

  it("rejects ambiguous GitHub Superpowers origin equivalents before inspection", async () => {
    initVendorCheckout({ "SKILL.md": "safe\n" });
    for (const remote of [
      "https://user@github.com/obra/superpowers.git",
      "https://github.com:443/obra/superpowers.git",
      "https://github.com/obra/superpowers.git?ref=main",
      "https://github.com/obra/superpowers.git#readme",
      "https://github.com/obra/superpowers.git/extra",
      "ssh://other@github.com/obra/superpowers.git",
      "ssh://git@github.com:22/obra/superpowers.git",
      "https://github.com/obra%2fsuperpowers.git",
    ]) {
      git(checkout, ["remote", "set-url", "origin", remote]);
      let inspections = 0;
      await expect(
        checkSuperpowersScanAcceptance(
          { checkoutPath: checkout },
          fixtureDeps(artifact([]), () => {
            inspections += 1;
            return [];
          }),
        ),
      ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
      expect(inspections).toBe(0);
    }
  });

  it("rejects skip-worktree and assume-unchanged tracked files before inspection", async () => {
    for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
      initVendorCheckout({ "SKILL.md": "pinned\n" });
      git(checkout, ["update-index", flag, "SKILL.md"]);
      writeFileSync(join(checkout, "SKILL.md"), "altered\n", "utf8");
      let inspections = 0;
      await expect(
        checkSuperpowersScanAcceptance(
          { checkoutPath: checkout },
          fixtureDeps(artifact([]), () => {
            inspections += 1;
            return [];
          }),
        ),
      ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
      expect(inspections).toBe(0);
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = mkdtempSync(join(tmpdir(), "aih-scan-acceptance-"));
      checkout = join(tempRoot, "superpowers");
    }
  });

  it("rejects an actual sparse checkout before inspection", async () => {
    initVendorCheckout({ "SKILL.md": "included\n", "excluded.md": "pinned\n" });
    git(checkout, ["sparse-checkout", "init", "--no-cone"]);
    git(checkout, ["sparse-checkout", "set", "--no-cone", "SKILL.md"]);
    let inspections = 0;
    await expect(
      checkSuperpowersScanAcceptance(
        { checkoutPath: checkout },
        fixtureDeps(artifact([]), () => {
          inspections += 1;
          return [];
        }),
      ),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
    expect(inspections).toBe(0);
  });

  it("rejects malformed index tag output before inspection", async () => {
    initVendorCheckout({ "SKILL.md": "safe\n" });
    let inspections = 0;
    const malformedIndexRunner: Runner = async (argv, options) => {
      const result = await pinnedCheckoutRunner(argv, options);
      return argv.at(-3) === "ls-files" && argv.at(-2) === "-v" && argv.at(-1) === "-z"
        ? { ...result, stdout: "Q SKILL.md\0" }
        : result;
    };
    await expect(
      checkSuperpowersScanAcceptance(
        { checkoutPath: checkout },
        {
          ...fixtureDeps(artifact([]), () => {
            inspections += 1;
            return [];
          }),
          runner: malformedIndexRunner,
        },
      ),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
    expect(inspections).toBe(0);
  });

  it("rejects replacement refs that substitute the detached checkout tree", async () => {
    initVendorCheckout({ "SKILL.md": "pinned\n" });
    const pinnedCommit = gitOutput(checkout, ["rev-parse", "HEAD"]);
    git(checkout, ["checkout", "-b", "replacement"]);
    writeFileSync(join(checkout, "SKILL.md"), "substituted\n", "utf8");
    git(checkout, ["add", "SKILL.md"]);
    git(checkout, ["commit", "-m", "replacement tree"]);
    const replacementCommit = gitOutput(checkout, ["rev-parse", "HEAD"]);
    git(checkout, ["replace", pinnedCommit, replacementCommit]);
    git(checkout, ["checkout", "--detach", pinnedCommit]);
    git(checkout, ["reset", "--hard", "HEAD"]);
    let inspections = 0;
    await expect(
      checkSuperpowersScanAcceptance(
        { checkoutPath: checkout },
        fixtureDeps(artifact([]), () => {
          inspections += 1;
          return [];
        }),
      ),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
    expect(inspections).toBe(0);
  });

  it("rejects an inert replacement ref before inspection", async () => {
    initVendorCheckout({ "SKILL.md": "pinned\n" });
    const pinnedCommit = gitOutput(checkout, ["rev-parse", "HEAD"]);
    git(checkout, ["update-ref", `refs/replace/${"f".repeat(40)}`, pinnedCommit]);
    let inspections = 0;
    await expect(
      checkSuperpowersScanAcceptance(
        { checkoutPath: checkout },
        fixtureDeps(artifact([]), () => {
          inspections += 1;
          return [];
        }),
      ),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
    expect(inspections).toBe(0);
  });

  it("fails closed when bounded replacement-ref enumeration fails", async () => {
    initVendorCheckout({ "SKILL.md": "pinned\n" });
    let inspections = 0;
    const unavailableReplacementRefRunner: Runner = async (argv, options) => {
      if (
        argv.at(-3) === "for-each-ref" &&
        argv.at(-2) === "refs/replace" &&
        argv.at(-1) === "--format=%(refname)"
      ) {
        expect(options?.maxBufferBytes).toBe(64 * 1024);
        return { code: 1, stdout: "", stderr: "unavailable" };
      }
      return pinnedCheckoutRunner(argv, options);
    };
    await expect(
      checkSuperpowersScanAcceptance(
        { checkoutPath: checkout },
        {
          ...fixtureDeps(artifact([]), () => {
            inspections += 1;
            return [];
          }),
          runner: unavailableReplacementRefRunner,
        },
      ),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
    expect(inspections).toBe(0);
  });

  it("fails closed for wrong, mutable, unreadable, and mutation-during-inspection checkouts", async () => {
    initVendorCheckout({ "SKILL.md": "safe\n", "unreadable/child": "not a file" });
    await expect(
      checkSuperpowersScanAcceptance(
        { checkoutPath: checkout },
        { acceptanceArtifact: artifact([]) },
      ),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);

    git(checkout, ["checkout", "main"]);
    await expect(
      checkSuperpowersScanAcceptance({ checkoutPath: checkout }, fixtureDeps(artifact([]))),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);

    git(checkout, ["checkout", "--detach", "HEAD"]);
    git(checkout, ["remote", "set-url", "origin", "https://example.invalid/not-superpowers.git"]);
    await expect(
      checkSuperpowersScanAcceptance({ checkoutPath: checkout }, fixtureDeps(artifact([]))),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
    git(checkout, ["remote", "set-url", "origin", "https://github.com/obra/superpowers.git"]);
    await expect(
      checkSuperpowersScanAcceptance(
        { checkoutPath: checkout },
        fixtureDeps(artifact([]), () => {
          throw new Error("EACCES");
        }),
      ),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
    await expect(
      checkSuperpowersScanAcceptance(
        { checkoutPath: checkout },
        fixtureDeps(artifact([]), (root) => {
          writeFileSync(join(root, "SKILL.md"), "mutated\n", "utf8");
          return [];
        }),
      ),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
  });

  it("rejects the AI-Harness checkout and writes no report file", async () => {
    initVendorCheckout({ "package.json": '{"name":"@aihq/harness"}\n' });
    const before = readdirSync(tempRoot).sort();
    await expect(
      checkSuperpowersScanAcceptance({ checkoutPath: checkout }, fixtureDeps(artifact([]))),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
    expect(readdirSync(tempRoot).sort()).toEqual(before);
  });
});

describe("runScanAcceptanceCli", () => {
  it("accepts only an explicit absolute checkout argument and emits deterministic JSON", async () => {
    const report = {
      checkout: { repository: "obra/superpowers" as const, commitSha: SUPERPOWERS_COMMIT },
      observations: [],
      accepted: [],
      stale: [],
      missing: [],
      new: [],
      critical: [],
      authorizes: false as const,
    };
    let checks = 0;
    const deps = {
      check: async () => {
        checks += 1;
        return report;
      },
    };
    await expect(runScanAcceptanceCli([], deps)).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
    await expect(runScanAcceptanceCli(["--checkout", "relative"], deps)).rejects.toBeInstanceOf(
      ScanAcceptanceCheckError,
    );
    await expect(
      runScanAcceptanceCli(["--checkout", checkout, "--apply"], deps),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
    expect(checks).toBe(0);
    await expect(runScanAcceptanceCli(["--checkout", checkout], deps)).resolves.toBe(
      `${JSON.stringify(report)}\n`,
    );
    expect(checks).toBe(1);
  });
});

function gitStatus(dir: string): string {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: dir,
    env: hermeticGitEnv(),
  })
    .toString("utf8")
    .trim();
}
