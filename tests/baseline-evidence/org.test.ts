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
    schemaVersion: 1,
    minimumPosture: "team",
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

function seedBundle(): { artifactSha256: string; sumsPath: string } {
  const catalog = baselineCatalogById("ecc");
  const artifactPath = ".aih/baseline-reports/ecc.json";
  const artifact = `${JSON.stringify(
    {
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
    },
    null,
    2,
  )}\n`;
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
});
