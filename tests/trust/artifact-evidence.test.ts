import { describe, expect, it } from "vitest";
import {
  ArtifactEvidenceBundleV1Schema,
  artifactEvidenceBundleDigestV1,
  artifactEvidenceRecordV1,
  createArtifactEvidenceBundleV1,
  parseArtifactEvidenceBundleV1Text,
  reconcileArtifactEvidenceV1,
} from "../../src/trust/artifact-evidence.js";
import { ArtifactIntakeV1Schema } from "../../src/trust/artifact-intake.js";

const SHA = "a".repeat(40);
const REGISTRY_INTEGRITY = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const OTHER_REGISTRY_INTEGRITY = `sha512-${Buffer.alloc(64, 2).toString("base64")}`;

function intake(version = "3.24.0", integrity?: string) {
  return ArtifactIntakeV1Schema.parse({
    format: "aih-artifact-intake",
    version: 1,
    authority: { state: "not-authority" },
    defaults: { accountableOwner: "platform@acme.example" },
    items: [
      {
        id: "firecrawl-mcp",
        kind: "mcp",
        source: {
          type: "npm",
          registry: "https://registry.npmjs.org",
          package: "firecrawl-mcp",
          version,
          ...(integrity === undefined ? {} : { integrity }),
        },
      },
      {
        id: "review-agent",
        kind: "agent",
        source: {
          type: "github",
          repository: "acme/security-assets",
          commit: SHA,
          path: "agents/reviewer.md",
        },
      },
    ],
  });
}

function firecrawlRecord(detail = "clean") {
  const item = intake().items[0];
  if (item === undefined) throw new Error("expected firecrawl intake item");
  return artifactEvidenceRecordV1({
    intake: intake(),
    item,
    state: "verified",
    observed: {
      type: "npm",
      tarballSha256: `sha256:${"b".repeat(64)}`,
      registryIntegrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    },
    analyzersRun: ["aih-native"],
    checks: [{ name: "trust scan", verdict: "pass", detail }],
    findings: [],
  });
}

describe("ArtifactEvidenceBundleV1", () => {
  it("binds preflight evidence to one exact request without claiming authority", () => {
    const source = intake();
    const bundle = createArtifactEvidenceBundleV1(source, [firecrawlRecord()]);

    expect(ArtifactEvidenceBundleV1Schema.parse(bundle)).toEqual(bundle);
    expect(bundle.evidence[0]).toMatchObject({
      itemId: "firecrawl-mcp",
      kind: "mcp",
      authority: { state: "not-authority" },
      state: "verified",
    });
    expect(bundle.evidence[0]).not.toHaveProperty("targets");
    expect(bundle.evidence[0]?.observed).toMatchObject({
      type: "npm",
      tarballSha256: `sha256:${"b".repeat(64)}`,
    });
    expect(bundle.results).toEqual([
      expect.objectContaining({ itemId: "firecrawl-mcp", state: "verified" }),
      { itemId: "review-agent", kind: "agent", state: "missing", problem: "not scanned" },
    ]);
  });

  it("rejects altered evidence and duplicate JSON members", () => {
    const bundle = createArtifactEvidenceBundleV1(intake(), [firecrawlRecord()]);
    const altered = structuredClone(bundle);
    const record = altered.evidence[0];
    if (record === undefined) throw new Error("expected evidence record");
    record.state = "failed";

    expect(ArtifactEvidenceBundleV1Schema.safeParse(altered).success).toBe(false);
    const targetClaim = structuredClone(bundle) as unknown as {
      evidence: Array<Record<string, unknown>>;
    };
    const targetRecord = targetClaim.evidence[0];
    if (targetRecord === undefined) throw new Error("expected evidence record");
    targetRecord.targets = ["codex"];
    expect(ArtifactEvidenceBundleV1Schema.safeParse(targetClaim).success).toBe(false);
    expect(() =>
      parseArtifactEvidenceBundleV1Text(
        '{"format":"aih-preflight-evidence-bundle","format":"other","version":1}',
      ),
    ).toThrow(/duplicate JSON object key/i);
  });

  it("rejects observed pins that differ from the requested exact source", () => {
    const npmSource = intake("3.24.0", REGISTRY_INTEGRITY);
    const npmItem = npmSource.items[0];
    if (npmItem === undefined) throw new Error("expected npm intake item");
    expect(() =>
      artifactEvidenceRecordV1({
        intake: npmSource,
        item: npmItem,
        state: "verified",
        observed: {
          type: "npm",
          tarballSha256: `sha256:${"b".repeat(64)}`,
          registryIntegrity: OTHER_REGISTRY_INTEGRITY,
        },
        analyzersRun: ["aih-native"],
        checks: [],
        findings: [],
      }),
    ).toThrow(/observed registry integrity mismatch/i);

    const githubSource = intake();
    const githubItem = githubSource.items[1];
    if (githubItem === undefined) throw new Error("expected GitHub intake item");
    expect(() =>
      artifactEvidenceRecordV1({
        intake: githubSource,
        item: githubItem,
        state: "verified",
        observed: { type: "github", commit: "b".repeat(40) },
        analyzersRun: ["aih-native"],
        checks: [],
        findings: [],
      }),
    ).toThrow(/observed commit mismatch/i);
  });

  it("rejects bundle results that contradict or orphan their evidence records", () => {
    const bundle = createArtifactEvidenceBundleV1(intake(), [firecrawlRecord()]);
    const contradictory = structuredClone(bundle);
    const result = contradictory.results[0];
    if (result === undefined) throw new Error("expected evidence result");
    result.state = "failed";
    const { bundleDigest: _bundleDigest, ...unsigned } = contradictory;
    contradictory.bundleDigest = artifactEvidenceBundleDigestV1(unsigned);

    expect(ArtifactEvidenceBundleV1Schema.safeParse(contradictory).success).toBe(false);

    const orphaned = structuredClone(bundle);
    orphaned.results = orphaned.results.filter((entry) => entry.itemId !== "firecrawl-mcp");
    const { bundleDigest: _orphanDigest, ...orphanUnsigned } = orphaned;
    orphaned.bundleDigest = artifactEvidenceBundleDigestV1(orphanUnsigned);
    expect(ArtifactEvidenceBundleV1Schema.safeParse(orphaned).success).toBe(false);

    const falseEvidenceClaim = structuredClone(bundle);
    const missing = falseEvidenceClaim.results.find((entry) => entry.itemId === "review-agent");
    if (missing === undefined) throw new Error("expected missing result");
    missing.evidenceId = bundle.evidence[0]?.id;
    missing.sourceDigest = bundle.evidence[0]?.sourceDigest;
    const { bundleDigest: _claimDigest, ...claimUnsigned } = falseEvidenceClaim;
    falseEvidenceClaim.bundleDigest = artifactEvidenceBundleDigestV1(claimUnsigned);
    expect(ArtifactEvidenceBundleV1Schema.safeParse(falseEvidenceClaim).success).toBe(false);
  });

  it("classifies missing, stale, replayed, and non-authoritative evidence", () => {
    const source = intake();
    const first = createArtifactEvidenceBundleV1(source, [firecrawlRecord("first")]);
    const replay = createArtifactEvidenceBundleV1(source, [firecrawlRecord("different result")]);

    expect(reconcileArtifactEvidenceV1(source, [first])).toEqual([
      expect.objectContaining({ itemId: "firecrawl-mcp", state: "verified", authorized: false }),
      expect.objectContaining({ itemId: "review-agent", state: "missing", authorized: false }),
    ]);
    expect(reconcileArtifactEvidenceV1(source, [first, replay])[0]).toMatchObject({
      state: "replayed",
      authorized: false,
    });
    expect(reconcileArtifactEvidenceV1(intake("3.25.0"), [first])[0]).toMatchObject({
      state: "stale",
      authorized: false,
    });
    const changedOwner = intake();
    if (changedOwner.defaults === undefined) throw new Error("expected intake defaults");
    changedOwner.defaults.accountableOwner = "different-owner@acme.example";
    expect(reconcileArtifactEvidenceV1(changedOwner, [first])[0]).toMatchObject({
      state: "mismatched",
      authorized: false,
    });
  });
});
