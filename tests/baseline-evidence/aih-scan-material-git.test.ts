import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type ExecFileSync = typeof import("node:child_process").execFileSync;

const git = vi.hoisted(() => ({
  execFileSync: vi.fn<ExecFileSync>(),
  original: undefined as unknown as ExecFileSync,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  git.original = original.execFileSync;
  return { ...original, execFileSync: git.execFileSync };
});

import {
  type MaterializedAihScanSubjectsV1,
  materializeAihScanSubjectsV1,
  removeMaterializedAihScanSubjectsV1,
} from "../../src/baseline-evidence/aih-scan-material.js";
import { policyAuthoringCatalog } from "../../src/org-policy/catalog.js";
import { compileBuiltInCatalogV1 } from "../../src/org-policy/workbench/compilers/built-in.js";

const roots: string[] = [];
const materialized: MaterializedAihScanSubjectsV1[] = [];

afterEach(() => {
  git.execFileSync.mockReset();
  for (const subject of materialized.splice(0)) {
    if (existsSync(subject.sourceRoot)) removeMaterializedAihScanSubjectsV1(subject);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  roots.push(root);
  return root;
}

function currentRevision(): string {
  return String(git.original("git", ["rev-parse", "HEAD"], { encoding: "utf8" })).trim();
}

function input(outputParent: string) {
  const catalog = policyAuthoringCatalog();
  return {
    packageRoot: resolve("."),
    outputParent,
    coreRevision: { pinnedSha: currentRevision() },
    catalog,
    compiled: compileBuiltInCatalogV1(catalog),
  };
}

function useRealGit(): void {
  git.execFileSync.mockImplementation((...args) => git.original(...args));
}

describe("pinned Git material capture", () => {
  it("reads the manifest and validated pack set through two bounded batch processes", () => {
    const calls: unknown[][] = [];
    useRealGit();
    git.execFileSync.mockImplementation((...args) => {
      calls.push(args);
      return git.original(...args);
    });

    const subject = materializeAihScanSubjectsV1(input(temporaryDirectory("aih-material-git-")));
    materialized.push(subject);

    const gitCalls = calls.filter((args) => args[0] === "git");
    expect(gitCalls.some((args) => (args[1] as readonly string[]).includes("show"))).toBe(false);
    const batches = gitCalls.filter((args) => (args[1] as readonly string[]).includes("cat-file"));
    expect(batches).toHaveLength(2);
    for (const [, args, options] of batches) {
      expect(args).toEqual(expect.arrayContaining(["cat-file", "--batch-command", "--buffer"]));
      expect(Buffer.isBuffer((options as { input?: unknown }).input)).toBe(true);
      expect((options as { input: Buffer }).input.toString("utf8")).toMatch(
        /^contents [0-9a-f]{40}:\S+\n/u,
      );
    }
  });

  it("rejects a batch record without its exact trailing binary frame", () => {
    const pinnedSha = currentRevision();
    git.execFileSync.mockImplementation((_command, args) => {
      if (args?.includes("rev-parse")) return `${pinnedSha}\n`;
      if (args?.includes("cat-file")) return Buffer.from(`${pinnedSha} blob 1\nx`, "ascii");
      throw new Error("unexpected Git invocation");
    });
    const outputParent = temporaryDirectory("aih-material-git-framing-");

    expect(() => materializeAihScanSubjectsV1(input(outputParent))).toThrow(
      /pinned Git batch framing/,
    );
    expect(readdirSync(outputParent)).toEqual([]);
  });

  it("rejects an oversized declared blob before accepting a binary frame", () => {
    const pinnedSha = currentRevision();
    git.execFileSync.mockImplementation((_command, args) => {
      if (args?.includes("rev-parse")) return `${pinnedSha}\n`;
      if (args?.includes("cat-file"))
        return Buffer.from(`${pinnedSha} blob ${16 * 1024 * 1024 + 1}\n`, "ascii");
      throw new Error("unexpected Git invocation");
    });

    expect(() =>
      materializeAihScanSubjectsV1(input(temporaryDirectory("aih-material-git-bounds-"))),
    ).toThrow(/source exceeds maximum size/);
  });
});
