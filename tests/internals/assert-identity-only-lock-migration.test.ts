import { describe, expect, it } from "vitest";
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

  it("defaults nextIdentity to the real nativeAnalyzerIdentity() when not supplied", () => {
    const prior = lock();
    const report = assertIdentityOnlyLockMigration(prior, prior);
    // Same lock compared to itself is identity-only only if its own aih-native
    // version already equals the live nativeAnalyzerIdentity(); here it does not
    // (fixture uses "2.9.0"), so this must report a diff rather than silently pass.
    expect(report.ok).toBe(false);
  });
});
