import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeAnalyzerIdentity } from "../../src/baseline-evidence/native-identity.js";
import type {
  BaselineComponentEvidence,
  BaselineEvidenceLock,
  BaselineSourceEvidence,
} from "../../src/baseline-evidence/schema.js";
import { assertIdentityOnlyLockMigration } from "../../src/internals/assert-identity-only-lock-migration.js";

function lock(): BaselineEvidenceLock {
  return {
    schemaVersion: 1,
    sources: [
      {
        id: "ecc",
        owner: "affaan-m",
        repo: "ECC",
        pinnedSha: "d".repeat(40),
        components: [
          {
            id: "skill:example",
            paths: ["skills/example"],
            treeSha256: "a".repeat(64),
            verdict: "pass",
            analyzers: [
              { name: "aih-native", version: "2.9.0" },
              { name: "skillspector@docker", version: "rev@sha256:deadbeef" },
            ],
            findings: [],
          },
          {
            id: "skill:blocked",
            paths: ["skills/blocked"],
            treeSha256: "b".repeat(64),
            verdict: "blocked",
            analyzers: [{ name: "aih-native", version: "2.9.0" }],
            findings: [{ code: "trust.hidden-unicode", detail: "danger", fingerprint: "fp:1" }],
          },
        ],
      },
    ],
  };
}

function eccSource(base: BaselineEvidenceLock): BaselineSourceEvidence {
  const source = base.sources.find((candidate) => candidate.id === "ecc");
  if (source === undefined) throw new Error("fixture lock is missing the ecc source");
  return source;
}

/** Build a "next" lock from `base`, replacing the ecc source's components (and,
 * optionally, its pin) — avoids repeating a non-null assertion on `sources[0]` in
 * every test. */
function withEccComponents(
  base: BaselineEvidenceLock,
  components: BaselineComponentEvidence[],
  sourceOverrides: Partial<BaselineSourceEvidence> = {},
): BaselineEvidenceLock {
  return { ...base, sources: [{ ...eccSource(base), ...sourceOverrides, components }] };
}

function rewriteNative(
  component: BaselineComponentEvidence,
  nextIdentity: string,
): BaselineComponentEvidence {
  return {
    ...component,
    analyzers: component.analyzers.map((receipt) =>
      receipt.name === "aih-native" ? { ...receipt, version: nextIdentity } : receipt,
    ),
  };
}

const nextIdentity = "native.a1b2c3d4e5f6";

describe("assertIdentityOnlyLockMigration", () => {
  it("accepts a migration that rewrites only every aih-native receipt version", () => {
    const prior = lock();
    const next = withEccComponents(
      prior,
      eccSource(prior).components.map((component) => rewriteNative(component, nextIdentity)),
    );

    const report = assertIdentityOnlyLockMigration(prior, next, nextIdentity);
    expect(report).toEqual({ ok: true, diffs: [] });
  });

  it("rejects a migration where a verdict silently flips", () => {
    const prior = lock();
    const next = withEccComponents(
      prior,
      eccSource(prior).components.map((component) =>
        rewriteNative(
          {
            ...component,
            verdict: component.id === "skill:blocked" ? "pass" : component.verdict,
            findings: component.id === "skill:blocked" ? [] : component.findings,
          },
          nextIdentity,
        ),
      ),
    );

    const report = assertIdentityOnlyLockMigration(prior, next, nextIdentity);
    expect(report.ok).toBe(false);
    expect(report.diffs).toContainEqual(
      expect.objectContaining({ sourceId: "ecc", componentId: "skill:blocked" }),
    );
  });

  it("rejects a migration that also changes treeSha256", () => {
    const prior = lock();
    const next = withEccComponents(
      prior,
      eccSource(prior).components.map((component) =>
        rewriteNative(
          {
            ...component,
            treeSha256: component.id === "skill:example" ? "c".repeat(64) : component.treeSha256,
          },
          nextIdentity,
        ),
      ),
    );

    const report = assertIdentityOnlyLockMigration(prior, next, nextIdentity);
    expect(report.ok).toBe(false);
    expect(report.diffs.some((diff) => diff.detail.includes("treeSha256"))).toBe(true);
  });

  it("rejects a migration that changes a non-aih-native analyzer version", () => {
    const prior = lock();
    const next = withEccComponents(
      prior,
      eccSource(prior).components.map((component) => ({
        ...component,
        analyzers: component.analyzers.map((receipt) => {
          if (receipt.name === "aih-native") return { ...receipt, version: nextIdentity };
          if (receipt.name === "skillspector@docker") {
            return { ...receipt, version: "rev@sha256:drifted" };
          }
          return receipt;
        }),
      })),
    );

    const report = assertIdentityOnlyLockMigration(prior, next, nextIdentity);
    expect(report.ok).toBe(false);
    expect(report.diffs.some((diff) => diff.detail.includes("analyzers"))).toBe(true);
  });

  it("rejects a migration that reorders findings or drops a fingerprint", () => {
    const prior = lock();
    const next = withEccComponents(
      prior,
      eccSource(prior).components.map((component) =>
        rewriteNative(
          {
            ...component,
            findings: component.findings.map((finding) => ({
              code: finding.code,
              detail: finding.detail,
            })),
          },
          nextIdentity,
        ),
      ),
    );

    const report = assertIdentityOnlyLockMigration(prior, next, nextIdentity);
    expect(report.ok).toBe(false);
    expect(report.diffs.some((diff) => diff.detail.includes("findings"))).toBe(true);
  });

  it("rejects a migration that silently rebinds the pin", () => {
    const prior = lock();
    const next = withEccComponents(
      prior,
      eccSource(prior).components.map((component) => rewriteNative(component, nextIdentity)),
      { pinnedSha: "e".repeat(40) },
    );

    const report = assertIdentityOnlyLockMigration(prior, next, nextIdentity);
    expect(report.ok).toBe(false);
    expect(report.diffs.some((diff) => diff.detail.includes("pinnedSha"))).toBe(true);
  });

  it("rejects a component count or ordering change", () => {
    const prior = lock();
    const [firstComponent] = eccSource(prior).components;
    if (firstComponent === undefined) throw new Error("fixture ecc source has no components");
    const next = withEccComponents(prior, [firstComponent]);

    const report = assertIdentityOnlyLockMigration(prior, next, nextIdentity);
    expect(report.ok).toBe(false);
  });

  it("rejects when the top-level source count differs", () => {
    const prior = lock();
    const next: BaselineEvidenceLock = { ...prior, sources: [...prior.sources, eccSource(prior)] };

    const report = assertIdentityOnlyLockMigration(prior, next, nextIdentity);
    expect(report.ok).toBe(false);
    // The count mismatch is a hard stop: the function returns immediately with exactly
    // this one lock-level diff, before it ever inspects source ids or components.
    expect(report.diffs).toEqual([
      { sourceId: "<lock>", componentId: "<catalog>", detail: "source count 1 → 2" },
    ]);
  });

  it("rejects when a source's id no longer matches at the same index", () => {
    const prior = lock();
    const next = withEccComponents(
      prior,
      eccSource(prior).components.map((component) => rewriteNative(component, nextIdentity)),
      { id: "ecc-renamed" },
    );

    const report = assertIdentityOnlyLockMigration(prior, next, nextIdentity);
    expect(report.ok).toBe(false);
    expect(report.diffs.some((diff) => diff.detail.includes("source order/id mismatch"))).toBe(
      true,
    );
  });

  it("rejects when a source's owner or repo changes", () => {
    const prior = lock();
    const next = withEccComponents(
      prior,
      eccSource(prior).components.map((component) => rewriteNative(component, nextIdentity)),
      { repo: "ECC-fork" },
    );

    const report = assertIdentityOnlyLockMigration(prior, next, nextIdentity);
    expect(report.ok).toBe(false);
    expect(report.diffs.some((diff) => diff.detail.includes("owner/repo"))).toBe(true);
  });

  it("rejects when two components are reordered/renamed while the count stays the same", () => {
    const prior = lock();
    const [first, second] = eccSource(prior).components;
    if (first === undefined || second === undefined) {
      throw new Error("fixture ecc source must have two components");
    }
    // Same two receipts, swapped positions: componentIndex 0 now holds "skill:blocked"
    // where the prior lock had "skill:example" at that index.
    const next = withEccComponents(prior, [
      rewriteNative(second, nextIdentity),
      rewriteNative(first, nextIdentity),
    ]);

    const report = assertIdentityOnlyLockMigration(prior, next, nextIdentity);
    expect(report.ok).toBe(false);
    expect(report.diffs.some((diff) => diff.detail.includes("component order/id mismatch"))).toBe(
      true,
    );
  });

  it("rejects when a component's paths change", () => {
    const prior = lock();
    const next = withEccComponents(
      prior,
      eccSource(prior).components.map((component) =>
        rewriteNative(
          {
            ...component,
            paths: component.id === "skill:example" ? ["skills/example-moved"] : component.paths,
          },
          nextIdentity,
        ),
      ),
    );

    const report = assertIdentityOnlyLockMigration(prior, next, nextIdentity);
    expect(report.ok).toBe(false);
    expect(report.diffs.some((diff) => diff.detail.includes("paths"))).toBe(true);
  });

  it("defaults nextIdentity to the real nativeAnalyzerIdentity() when not supplied", () => {
    const prior = lock();
    const report = assertIdentityOnlyLockMigration(prior, prior);
    // Same lock compared to itself is identity-only only if its own aih-native
    // version already equals the live nativeAnalyzerIdentity(); here it does not
    // (fixture uses "2.9.0"), so this must report a diff rather than silently pass.
    expect(report.ok).toBe(false);
  });
});

/**
 * These exercise the actual CLI entry point (`optionValue`, `readLock`, `main`, and the
 * `import.meta.url` self-invocation guard) — none of which are exported, so the only way
 * to reach them with real behavior (not a re-implementation) is to reproduce how `tsx`
 * would run this file: point `process.argv[1]` at the module's own resolved path, then
 * dynamically re-import it after `vi.resetModules()` so the top-level guard re-evaluates
 * and calls `main()` for real. `process.argv`/`process.exitCode` are snapshotted and
 * restored in `afterEach` so this can't leak into other test files.
 */
describe("assert-identity-only-lock-migration CLI (main() via the process.argv guard)", () => {
  const SCRIPT_PATH = fileURLToPath(
    new URL("../../src/internals/assert-identity-only-lock-migration.ts", import.meta.url),
  );
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const roots: string[] = [];

  function fixtureDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "aih-lock-migration-cli-"));
    roots.push(dir);
    return dir;
  }

  function writeLockFixture(dir: string, name: string, value: BaselineEvidenceLock): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value), "utf8");
    return path;
  }

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.resetModules();
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function runCli(args: string[]): Promise<void> {
    process.argv = [originalArgv[0] ?? "node", SCRIPT_PATH, ...args];
    vi.resetModules();
    await import("../../src/internals/assert-identity-only-lock-migration.js");
  }

  it("throws the usage error when both --prior and --next are missing", async () => {
    await expect(runCli([])).rejects.toThrow(
      "usage: assert-identity-only-lock-migration --prior <file> --next <file>",
    );
  });

  it("throws the usage error when only --prior is supplied", async () => {
    const dir = fixtureDir();
    const priorPath = writeLockFixture(dir, "prior.json", lock());

    await expect(runCli(["--prior", priorPath])).rejects.toThrow(
      "usage: assert-identity-only-lock-migration --prior <file> --next <file>",
    );
  });

  it("accepts an identity-only migration end-to-end and prints the summary line to stdout", async () => {
    const dir = fixtureDir();
    const prior = lock();
    const liveIdentity = nativeAnalyzerIdentity();
    const next = withEccComponents(
      prior,
      eccSource(prior).components.map((component) => rewriteNative(component, liveIdentity)),
    );
    const priorPath = writeLockFixture(dir, "prior.json", prior);
    const nextPath = writeLockFixture(dir, "next.json", next);

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCli(["--prior", priorPath, "--next", nextPath]);

    expect(process.exitCode).not.toBe(1);
    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toBe(
      `${priorPath} -> ${nextPath}: identical except every aih-native receipt now reads ${liveIdentity}\n`,
    );
  });

  it("rejects a real content change end-to-end: per-diff stderr lines and exitCode 1", async () => {
    const dir = fixtureDir();
    const prior = lock();
    const liveIdentity = nativeAnalyzerIdentity();
    const next = withEccComponents(
      prior,
      eccSource(prior).components.map((component) =>
        rewriteNative(
          {
            ...component,
            treeSha256: component.id === "skill:example" ? "c".repeat(64) : component.treeSha256,
          },
          liveIdentity,
        ),
      ),
    );
    const priorPath = writeLockFixture(dir, "prior.json", prior);
    const nextPath = writeLockFixture(dir, "next.json", next);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runCli(["--prior", priorPath, "--next", nextPath]);

    expect(process.exitCode).toBe(1);
    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain(`ecc/skill:example: treeSha256 ${"a".repeat(64)} → ${"c".repeat(64)}`);
    expect(output).toContain(
      "migration is not identity-only: 1 component(s)/source(s) changed beyond the aih-native identity rewrite",
    );
  });
});
