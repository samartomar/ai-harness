import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { resolveOrgBaselineEvidence } from "../../src/baseline-evidence/org.js";
import { sha256Hex } from "../../src/bundle/index.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-baseline-org-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, contents: string): void {
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function policy(signingRepository = "acme/engineering-governance") {
  const catalog = baselineCatalogById("ecc");
  return parseOrgPolicy({
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    trust: {
      baselineOverrides: [
        {
          catalog: "ecc",
          owner: catalog.owner,
          repo: catalog.repo,
          pinnedSha: catalog.pinnedSha,
          bundle: ".aih/org-evidence/ecc",
          signingRepository,
          reason: "Reviewed ECC baseline",
          reviewer: "security@example.com",
          approvedAt: "2026-07-10T12:00:00.000Z",
        },
      ],
    },
  });
}

function policyWithoutEvidence(
  minimumPosture: "enterprise" | "vibe",
  trust: Record<string, unknown> | undefined,
) {
  return parseOrgPolicy({
    schemaVersion: 2,
    minimumPosture,
    references: { repoContract: "ai-coding/project.json" },
    ...(minimumPosture === "enterprise" ? { governance: { supportedClis: ["kiro"] } } : {}),
    ...(trust === undefined ? {} : { trust }),
  });
}

function requiredEvidenceSkeleton(catalog = baselineCatalogById("ecc")): string {
  return [
    `catalog: ${catalog.id}`,
    `owner: ${catalog.owner}`,
    `repo: ${catalog.repo}`,
    `pinnedSha: ${catalog.pinnedSha}`,
    "bundle:",
    "signingRepository:",
    "reason:",
    "reviewer:",
    "approvedAt:",
  ].join("\n");
}

function defaultLock(): unknown {
  const catalog = baselineCatalogById("ecc");
  return {
    schemaVersion: 1,
    sources: [
      {
        id: "ecc",
        owner: catalog.owner,
        repo: catalog.repo,
        pinnedSha: catalog.pinnedSha,
        components: [
          {
            id: "skill:verification-loop",
            paths: ["skills/verification-loop"],
            treeSha256: "a".repeat(64),
            verdict: "pass",
            analyzers: [{ name: "aih-native", version: "2.7.0" }],
            findings: [],
          },
        ],
      },
    ],
  };
}

function seedBundle(lock: unknown = defaultLock()): { artifactSha256: string; sumsPath: string } {
  const artifactPath = ".aih/baseline-reports/ecc.json";
  const artifact = `${JSON.stringify(lock, null, 2)}\n`;
  const artifactSha256 = sha256Hex(artifact);
  const manifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      files: [{ path: artifactPath, bytes: Buffer.byteLength(artifact), sha256: artifactSha256 }],
    },
    null,
    2,
  )}\n`;
  const index = `${JSON.stringify(
    {
      schemaVersion: 1,
      artifacts: [
        {
          kind: "baseline-evidence",
          path: artifactPath,
          sha256: artifactSha256,
          schemaVersion: 1,
        },
      ],
    },
    null,
    2,
  )}\n`;
  const sums = [
    `${artifactSha256}  files/${artifactPath}`,
    `${sha256Hex(manifest)}  manifest.json`,
    `${sha256Hex(index)}  evidence.json`,
    "",
  ].join("\n");
  const bundle = ".aih/org-evidence/ecc";
  put(`${bundle}/files/${artifactPath}`, artifact);
  put(`${bundle}/manifest.json`, manifest);
  put(`${bundle}/evidence.json`, index);
  put(`${bundle}/SHA256SUMS`, sums);
  return { artifactSha256, sumsPath: join(root, bundle, "SHA256SUMS") };
}

describe("resolveOrgBaselineEvidence", () => {
  it("verifies checksums and the attributed GitHub repository before returning evidence", async () => {
    const { artifactSha256, sumsPath } = seedBundle();
    const seen = vi.fn();
    const run = fakeRunner((argv) => {
      seen(argv);
      return { code: 0, stdout: "verified" };
    });
    const result = await resolveOrgBaselineEvidence({
      root,
      catalog: baselineCatalogById("ecc"),
      policy: policy(),
      run,
    });

    expect(seen).toHaveBeenCalledWith([
      "gh",
      "attestation",
      "verify",
      sumsPath,
      "--repo",
      "acme/engineering-governance",
    ]);
    expect(result.checks.every((check) => check.verdict === "pass")).toBe(true);
    expect(result.evidence).toMatchObject({
      tier: "org",
      issuer: "github:acme/engineering-governance",
      evidenceSha256: artifactSha256,
      lock: { schemaVersion: 1 },
    });
  });

  it("returns no evidence and does not invoke gh when bundle checksums drift", async () => {
    seedBundle();
    put(".aih/org-evidence/ecc/files/.aih/baseline-reports/ecc.json", "tampered\n");
    const seen = vi.fn();
    const result = await resolveOrgBaselineEvidence({
      root,
      catalog: baselineCatalogById("ecc"),
      policy: policy(),
      run: fakeRunner((argv) => {
        seen(argv);
        return { code: 0 };
      }),
    });
    expect(seen).not.toHaveBeenCalled();
    expect(result.evidence).toBeUndefined();
    expect(result.checks).toEqual([
      expect.objectContaining({ verdict: "fail", code: "baseline.evidence-mismatch" }),
    ]);
  });

  it("returns no evidence when GitHub rejects the configured signing repository", async () => {
    seedBundle();
    const result = await resolveOrgBaselineEvidence({
      root,
      catalog: baselineCatalogById("ecc"),
      policy: policy("wrong/repository"),
      run: fakeRunner(() => ({ code: 1, stderr: "attestation not found" })),
    });
    expect(result.evidence).toBeUndefined();
    expect(result.checks.at(-1)).toMatchObject({ verdict: "fail", code: "bundle.signature" });
  });

  it("rejects a signed lock newer than this build loudly, never as absent evidence", async () => {
    const lock = defaultLock() as { schemaVersion: number };
    seedBundle({ ...lock, schemaVersion: 2 });
    const result = await resolveOrgBaselineEvidence({
      root,
      catalog: baselineCatalogById("ecc"),
      policy: policy(),
      run: fakeRunner(() => ({ code: 0, stdout: "verified" })),
    });
    expect(result.evidence).toBeUndefined();
    const failure = result.checks.find((check) => check.verdict === "fail");
    expect(failure?.code).toBe("baseline.evidence-schema-unsupported");
    expect(failure?.detail).toContain("schema version 2");
    expect(failure?.detail).toContain("version 1");
    // The misdiagnosis this floor exists to stop: skew must never be reported
    // as the absence it causes.
    expect(failure?.detail).not.toContain("contains no baseline evidence");
  });

  it("rejects a signed artifact this build cannot parse instead of silently skipping it", async () => {
    seedBundle({ schemaVersion: 1, sources: [{ id: "ecc", componentsRenamed: [] }] });
    const result = await resolveOrgBaselineEvidence({
      root,
      catalog: baselineCatalogById("ecc"),
      policy: policy(),
      run: fakeRunner(() => ({ code: 0, stdout: "verified" })),
    });
    expect(result.evidence).toBeUndefined();
    expect(result.checks.at(-1)).toMatchObject({
      verdict: "fail",
      code: "baseline.evidence-schema-unsupported",
    });
  });

  it("does nothing when policy has no override for the requested source pin", async () => {
    const result = await resolveOrgBaselineEvidence({
      root,
      catalog: baselineCatalogById("ecc", "b".repeat(40)),
      policy: policy(),
      run: fakeRunner(() => {
        throw new Error("should not run");
      }),
    });
    expect(result).toEqual({ checks: [] });
  });

  it.each([
    ["no trust object", undefined],
    ["an empty trust object", {}],
    ["an empty baseline override list", { baselineOverrides: [] }],
  ])("blocks Enterprise %s with only a paste-shaped evidence skeleton", async (_label, trust) => {
    const catalog = baselineCatalogById("ecc");
    const result = await resolveOrgBaselineEvidence({
      root,
      catalog,
      policy: policyWithoutEvidence("enterprise", trust),
      run: fakeRunner(() => {
        throw new Error("absence must not invoke attestation verification");
      }),
    });

    expect(result).toEqual({
      checks: [
        {
          name: "org baseline evidence required",
          verdict: "fail",
          code: "baseline.org-evidence-required",
          detail: requiredEvidenceSkeleton(catalog),
        },
      ],
    });
  });

  it("keeps Vibe absence empty so the packaged fallback remains available", async () => {
    const result = await resolveOrgBaselineEvidence({
      root,
      catalog: baselineCatalogById("ecc"),
      policy: policyWithoutEvidence("vibe", undefined),
      run: fakeRunner(() => {
        throw new Error("Vibe absence must not invoke attestation verification");
      }),
    });

    expect(result).toEqual({ checks: [] });
  });

  it("names only the first exact same-source stale override and never leaks unrelated entries", async () => {
    const catalog = baselineCatalogById("ecc");
    const firstStaleSha = "b".repeat(40);
    const laterStaleSha = "c".repeat(40);
    const result = await resolveOrgBaselineEvidence({
      root,
      catalog,
      policy: parseOrgPolicy({
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: { supportedClis: ["kiro"] },
        trust: {
          baselineOverrides: [
            {
              catalog: "superpowers",
              owner: catalog.owner,
              repo: catalog.repo,
              pinnedSha: catalog.pinnedSha,
              bundle: ".aih/org-evidence/catalog-mismatch",
              signingRepository: "acme/catalog-mismatch",
              reason: "Catalog mismatch must not match",
              reviewer: "security@example.com",
              approvedAt: "2026-07-10T12:00:00.000Z",
            },
            {
              catalog: "superpowers",
              owner: "obra",
              repo: "Superpowers",
              pinnedSha: "d".repeat(40),
              bundle: ".aih/org-evidence/superpowers",
              signingRepository: "acme/unrelated",
              reason: "Unrelated evidence",
              reviewer: "security@example.com",
              approvedAt: "2026-07-10T12:00:00.000Z",
            },
            {
              catalog: catalog.id,
              owner: catalog.owner,
              repo: catalog.repo.toUpperCase(),
              pinnedSha: catalog.pinnedSha,
              bundle: ".aih/org-evidence/repo-case-alias",
              signingRepository: "acme/repo-case-alias",
              reason: "Repository case alias must not match",
              reviewer: "security@example.com",
              approvedAt: "2026-07-10T12:00:00.000Z",
            },
            {
              catalog: catalog.id,
              owner: catalog.owner,
              repo: catalog.repo,
              pinnedSha: firstStaleSha,
              bundle: ".aih/org-evidence/ecc-old",
              signingRepository: "acme/first-stale",
              reason: "Stale ECC evidence",
              reviewer: "security@example.com",
              approvedAt: "2026-07-10T12:00:00.000Z",
            },
            {
              catalog: catalog.id,
              owner: catalog.owner,
              repo: catalog.repo,
              pinnedSha: laterStaleSha,
              bundle: ".aih/org-evidence/ecc-later",
              signingRepository: "acme/later-stale",
              reason: "Later stale ECC evidence",
              reviewer: "security@example.com",
              approvedAt: "2026-07-10T12:00:00.000Z",
            },
            {
              catalog: catalog.id,
              owner: catalog.owner.toUpperCase(),
              repo: catalog.repo,
              pinnedSha: catalog.pinnedSha,
              bundle: ".aih/org-evidence/ecc-case-alias",
              signingRepository: "acme/case-alias",
              reason: "Case alias must not match",
              reviewer: "security@example.com",
              approvedAt: "2026-07-10T12:00:00.000Z",
            },
          ],
        },
      }),
      run: fakeRunner(() => {
        throw new Error("stale evidence must not invoke attestation verification");
      }),
    });

    const check = result.checks[0];
    expect(check).toMatchObject({
      name: "org baseline evidence required",
      verdict: "fail",
      code: "baseline.org-evidence-required",
    });
    expect(check?.detail).toContain(`declaredPinnedSha: ${firstStaleSha}`);
    expect(check?.detail).toContain(`pinnedSha: ${catalog.pinnedSha}`);
    expect(check?.detail).toContain("re-vet");
    expect(check?.detail).toContain("update");
    expect(check?.detail).not.toContain(laterStaleSha);
    expect(check?.detail).not.toContain("acme/catalog-mismatch");
    expect(check?.detail).not.toContain("acme/unrelated");
    expect(check?.detail).not.toContain("acme/case-alias");
    expect(check?.detail).not.toContain("acme/repo-case-alias");
  });

  it("uses the live requested pin when an old same-source override is stale", async () => {
    const liveCatalog = baselineCatalogById("ecc", "e".repeat(40));
    const result = await resolveOrgBaselineEvidence({
      root,
      catalog: liveCatalog,
      policy: parseOrgPolicy({
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: { supportedClis: ["kiro"] },
        trust: {
          baselineOverrides: [
            {
              catalog: liveCatalog.id,
              owner: liveCatalog.owner,
              repo: liveCatalog.repo,
              pinnedSha: "a".repeat(40),
              bundle: ".aih/org-evidence/ecc-old",
              signingRepository: "acme/engineering-governance",
              reason: "Old exact source evidence",
              reviewer: "security@example.com",
              approvedAt: "2026-07-10T12:00:00.000Z",
            },
          ],
        },
      }),
      run: fakeRunner(() => {
        throw new Error("stale evidence must not invoke attestation verification");
      }),
    });

    expect(result.checks[0]).toMatchObject({ code: "baseline.org-evidence-required" });
    expect(result.checks[0]?.detail).toContain(`pinnedSha: ${liveCatalog.pinnedSha}`);
    expect(result.checks[0]?.detail).toContain(`declaredPinnedSha: ${"a".repeat(40)}`);
  });
});
