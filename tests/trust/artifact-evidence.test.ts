import { describe, expect, it } from "vitest";
import type { Check } from "../../src/internals/verify.js";
import {
  ArtifactEvidenceBundleV1Schema,
  ArtifactEvidenceBundleV2Schema,
  artifactDirectoryResolutionRecordV2,
  artifactEvidenceBundleDigestV1,
  artifactEvidenceBundleDigestV2,
  artifactEvidenceRecordV1,
  createArtifactEvidenceBundleV1,
  createArtifactEvidenceBundleV2,
  parseArtifactEvidenceBundleV1Text,
  parseArtifactEvidenceBundleV2Text,
  reconcileArtifactEvidenceV1,
} from "../../src/trust/artifact-evidence.js";
import { ArtifactIntakeV1Schema, ArtifactIntakeV2Schema } from "../../src/trust/artifact-intake.js";
import {
  extractDirectoryClaimV1,
  parseDirectoryDiscoveryUrlV1,
  resolveDirectoryClaimV1,
} from "../../src/trust/directory-resolution.js";

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

function directoryIntake() {
  return ArtifactIntakeV2Schema.parse({
    format: "aih-artifact-intake",
    version: 2,
    authority: { state: "not-authority" },
    defaults: { accountableOwner: "platform@acme.example" },
    items: [
      {
        id: "firecrawl-directory",
        kind: "mcp",
        source: {
          type: "directory",
          provider: "pulsemcp",
          url: "https://www.pulsemcp.com/servers/firecrawl",
        },
      },
    ],
  });
}

function firecrawlDirectoryResolution() {
  const source = parseDirectoryDiscoveryUrlV1("https://www.pulsemcp.com/servers/firecrawl");
  const claim = extractDirectoryClaimV1(
    source,
    "<h1>Firecrawl</h1><p>NAME io.github.firecrawl/firecrawl-mcp-server</p><p>Current Version: 3.7.4</p>",
  );
  return resolveDirectoryClaimV1(claim, {
    servers: [
      {
        server: {
          name: "io.github.firecrawl/firecrawl-mcp-server",
          version: "3.24.0",
          repository: {
            url: "https://github.com/firecrawl/firecrawl-mcp-server",
            source: "github",
          },
          packages: [
            {
              registryType: "npm",
              identifier: "firecrawl-mcp",
              version: "3.24.0",
              transport: { type: "stdio" },
              environmentVariables: [{ name: "FIRECRAWL_API_KEY", isSecret: true }],
            },
          ],
        },
      },
    ],
    metadata: { count: 1 },
  });
}

describe("ArtifactEvidenceBundleV1", () => {
  it("omits undefined optional check fields from the scan digest", () => {
    const item = intake().items[0];
    if (item === undefined) throw new Error("expected firecrawl intake item");
    const check: Check = { name: "trust scan", verdict: "pass", detail: "clean" };
    Object.assign(check, { code: undefined });

    const record = artifactEvidenceRecordV1({
      intake: intake(),
      item,
      state: "verified",
      observed: {
        type: "npm",
        tarballSha256: `sha256:${"b".repeat(64)}`,
        registryIntegrity: REGISTRY_INTEGRITY,
      },
      analyzersRun: ["aih-native"],
      checks: [check],
      findings: [],
    });

    expect(record.scanDigest).toBe(firecrawlRecord().scanDigest);
  });

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

describe("ArtifactEvidenceBundleV2", () => {
  it("binds a directory resolution to the exact claim without treating it as scan evidence", () => {
    const source = directoryIntake();
    const item = source.items[0];
    if (item === undefined) throw new Error("expected directory intake item");
    const resolution = artifactDirectoryResolutionRecordV2({
      intake: source,
      item,
      resolution: firecrawlDirectoryResolution(),
    });
    const bundle = createArtifactEvidenceBundleV2(source, [], [resolution]);

    expect(ArtifactEvidenceBundleV2Schema.parse(bundle)).toEqual(bundle);
    expect(bundle.results).toEqual([
      expect.objectContaining({
        itemId: "firecrawl-directory",
        state: "missing",
        resolutionId: resolution.id,
        resolutionDigest: resolution.resolutionDigest,
      }),
    ]);
    expect(bundle.evidence).toEqual([]);
    expect(bundle.resolutions[0]).toMatchObject({
      authority: { state: "not-authority" },
      resolution: {
        state: "mismatched",
        options: expect.arrayContaining([
          expect.objectContaining({
            source: expect.objectContaining({
              type: "npm",
              package: "firecrawl-mcp",
              version: "3.24.0",
            }),
          }),
        ]),
      },
    });
    expect(bundle.resolutions[0]).not.toHaveProperty("targets");
    expect(JSON.stringify(bundle)).not.toContain("FIRECRAWL_API_KEY=");
  });

  it("rejects altered, orphaned, replayed, and authority-bearing resolution claims", () => {
    const source = directoryIntake();
    const item = source.items[0];
    if (item === undefined) throw new Error("expected directory intake item");
    const resolution = artifactDirectoryResolutionRecordV2({
      intake: source,
      item,
      resolution: firecrawlDirectoryResolution(),
    });
    const bundle = createArtifactEvidenceBundleV2(source, [], [resolution]);

    const altered = structuredClone(bundle);
    const alteredResolution = altered.resolutions[0];
    if (alteredResolution === undefined) throw new Error("expected directory resolution");
    alteredResolution.resolution.options = [];
    expect(ArtifactEvidenceBundleV2Schema.safeParse(altered).success).toBe(false);

    const orphaned = structuredClone(bundle);
    const orphanedResult = orphaned.results[0];
    if (orphanedResult === undefined) throw new Error("expected directory result");
    delete orphanedResult.resolutionId;
    delete orphanedResult.resolutionDigest;
    const { bundleDigest: _orphanDigest, ...orphanUnsigned } = orphaned;
    orphaned.bundleDigest = artifactEvidenceBundleDigestV2(orphanUnsigned);
    expect(ArtifactEvidenceBundleV2Schema.safeParse(orphaned).success).toBe(false);

    const replayed = structuredClone(bundle);
    replayed.resolutions.push(structuredClone(resolution));
    const { bundleDigest: _replayDigest, ...replayUnsigned } = replayed;
    replayed.bundleDigest = artifactEvidenceBundleDigestV2(replayUnsigned);
    expect(ArtifactEvidenceBundleV2Schema.safeParse(replayed).success).toBe(false);

    const authorityClaim = structuredClone(bundle) as unknown as {
      resolutions: Array<Record<string, unknown>>;
    };
    const authorityResolution = authorityClaim.resolutions[0];
    if (authorityResolution === undefined) throw new Error("expected directory resolution");
    authorityResolution.targets = ["codex"];
    expect(ArtifactEvidenceBundleV2Schema.safeParse(authorityClaim).success).toBe(false);
  });

  it("strictly parses version 2 bundles and rejects duplicate JSON members", () => {
    const source = directoryIntake();
    const item = source.items[0];
    if (item === undefined) throw new Error("expected directory intake item");
    const resolution = artifactDirectoryResolutionRecordV2({
      intake: source,
      item,
      resolution: firecrawlDirectoryResolution(),
    });
    const bundle = createArtifactEvidenceBundleV2(source, [], [resolution]);

    expect(parseArtifactEvidenceBundleV2Text(JSON.stringify(bundle))).toEqual(bundle);
    expect(() =>
      parseArtifactEvidenceBundleV2Text(
        '{"format":"aih-preflight-evidence-bundle","version":2,"version":1}',
      ),
    ).toThrow(/duplicate JSON object key/i);
  });
});
