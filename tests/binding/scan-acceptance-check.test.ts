import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkSuperpowersScanAcceptance,
  ScanAcceptanceCheckError,
  type ScanAcceptanceObservation,
} from "../../src/binding/scan-acceptance-check.js";
import { defaultRunner, type Runner } from "../../src/internals/proc.js";
import { hermeticGitEnv } from "../git-fixture-env.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const SUPERPOWERS_COMMIT = "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9";

let tempRoot: string;
let checkout: string;

interface FixtureAcceptance {
  code: string;
  path: string;
  fileSha256: string;
}

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe", env: hermeticGitEnv() });
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

function artifact(entries: readonly FixtureAcceptance[]) {
  return {
    schemaVersion: 2,
    reason: "fixture",
    accepted: entries.map((entry) => ({ repository: "obra/superpowers", ...entry })),
  };
}

function observation(
  path: string,
  code = "trust.hidden-unicode",
  severity: ScanAcceptanceObservation["severity"] = "high",
): ScanAcceptanceObservation {
  return { code, severity, path };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const pinnedCheckoutRunner: Runner = async (argv, options) => {
  const result = await defaultRunner(argv, options);
  return argv.at(-2) === "rev-parse" && argv.at(-1) === "HEAD"
    ? { ...result, stdout: `${SUPERPOWERS_COMMIT}\n` }
    : result;
};

function check(
  accepted: readonly FixtureAcceptance[],
  observations: readonly ScanAcceptanceObservation[],
  outputPath?: string,
) {
  return checkSuperpowersScanAcceptance({
    checkoutPath: checkout,
    acceptance: artifact(accepted),
    observations,
    runner: pinnedCheckoutRunner,
    ...(outputPath === undefined ? {} : { outputPath }),
  });
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "aih-scan-acceptance-"));
  checkout = join(tempRoot, "superpowers");
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("checkSuperpowersScanAcceptance", () => {
  it("normalizes CRLF to LF before hashing and produces repeatable sorted observations", async () => {
    initVendorCheckout({ "z.md": "z\r\n", "a.md": "a\r\n" });
    const accepted = [
      {
        code: "trust.prompt-injection",
        path: "a.md",
        fileSha256: sha256("a\n"),
      },
      {
        code: "trust.hidden-unicode",
        path: "z.md",
        fileSha256: sha256("z\n"),
      },
    ];

    const first = await check(accepted, [
      observation("z.md"),
      observation("a.md", "trust.prompt-injection"),
    ]);
    const second = await check(accepted, [
      observation("a.md", "trust.prompt-injection"),
      observation("z.md"),
    ]);

    expect(first).toEqual(second);
    expect(first.observations.map((entry) => [entry.code, entry.path])).toEqual([
      ["trust.hidden-unicode", "z.md"],
      ["trust.prompt-injection", "a.md"],
    ]);
    expect(first.new).toEqual([]);
  });

  it("reports a stale accepted tuple and a newly observed unaccepted high without authorizing either", async () => {
    initVendorCheckout({ "SKILL.md": "current\n" });
    const result = await check(
      [
        {
          code: "trust.hidden-unicode",
          path: "SKILL.md",
          fileSha256: "a".repeat(64),
        },
      ],
      [observation("SKILL.md")],
    );

    expect(result.stale).toHaveLength(1);
    expect(result.new).toHaveLength(1);
    expect(result.accepted).toEqual([]);
    expect(result.authorizes).toBe(false);
  });

  it("reports an accepted file whose corresponding finding is missing", async () => {
    initVendorCheckout({ "SKILL.md": "content\n" });
    const fileSha256 = sha256("content\n");
    const result = await check(
      [{ code: "trust.hidden-unicode", path: "SKILL.md", fileSha256 }],
      [],
    );

    expect(result.missing).toEqual([
      { code: "trust.hidden-unicode", path: "SKILL.md", fileSha256 },
    ]);
    expect(result.authorizes).toBe(false);
  });

  it("never accepts a critical observation even when its exact tuple is listed", async () => {
    initVendorCheckout({ "SKILL.md": "content\n" });
    const fileSha256 = sha256("content\n");
    const result = await check(
      [{ code: "trust.malicious-code", path: "SKILL.md", fileSha256 }],
      [observation("SKILL.md", "trust.malicious-code", "critical")],
    );

    expect(result.accepted).toEqual([]);
    expect(result.new).toHaveLength(1);
    expect(result.critical).toHaveLength(1);
    expect(result.authorizes).toBe(false);
  });

  it.each([
    [[{ code: "trust.hidden-unicode", path: "../SKILL.md", fileSha256: "a".repeat(64) }]],
    [[{ code: "trust.hidden-unicode", path: "/SKILL.md", fileSha256: "a".repeat(64) }]],
    [[{ code: "trust.hidden-unicode", path: "SKILL.md", fileSha256: "invalid" }]],
    [
      [
        { code: "trust.hidden-unicode", path: "SKILL.md", fileSha256: "a".repeat(64) },
        { code: "trust.hidden-unicode", path: "SKILL.md", fileSha256: "b".repeat(64) },
      ],
    ],
  ])(
    "rejects malformed, duplicate, absolute, and traversal acceptance entries",
    async (accepted) => {
      initVendorCheckout({ "SKILL.md": "content\n" });
      await expect(check(accepted, [])).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
    },
  );

  it("fails closed for a wrong, mutable, or unreadable vendor checkout", async () => {
    initVendorCheckout({ "SKILL.md": "content\n", "unreadable/child": "not a file" });
    await expect(
      checkSuperpowersScanAcceptance({
        checkoutPath: checkout,
        acceptance: artifact([]),
        observations: [],
      }),
    ).rejects.toBeInstanceOf(ScanAcceptanceCheckError);

    git(checkout, ["checkout", "main"]);
    await expect(check([], [])).rejects.toBeInstanceOf(ScanAcceptanceCheckError);

    git(checkout, ["checkout", "--detach", "HEAD"]);
    await expect(check([], [observation("unreadable")])).rejects.toBeInstanceOf(
      ScanAcceptanceCheckError,
    );
  });

  it("rejects the AI-Harness checkout as the vendor target", async () => {
    initVendorCheckout({ "package.json": '{"name":"@aihq/harness"}\n' });
    await expect(check([], [])).rejects.toBeInstanceOf(ScanAcceptanceCheckError);
  });

  it("writes only to an explicit destination outside the scanned checkout", async () => {
    initVendorCheckout({ "SKILL.md": "content\n" });
    await expect(check([], [], join(checkout, "report.json"))).rejects.toBeInstanceOf(
      ScanAcceptanceCheckError,
    );

    const outputPath = join(tempRoot, "report.json");
    const result = await check([], [], outputPath);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(result);
  });
});
