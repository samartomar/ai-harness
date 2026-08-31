import { describe, expect, it } from "vitest";
import type { Check } from "../../src/internals/verify.js";
import {
  ArtifactDirectoryResolutionRecordV2Schema,
  ArtifactEvidenceBundleV1Schema,
  ArtifactEvidenceBundleV2Schema,
  ArtifactEvidenceRecordV1Schema,
  ArtifactObservedSourceV1Schema,
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
import {
  ArtifactIntakeV1Schema,
  ArtifactIntakeV2Schema,
  artifactEvidenceRecordIdV1,
  artifactIntakeExactProjectionV1,
} from "../../src/trust/artifact-intake.js";
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

function mixedIntake() {
  return ArtifactIntakeV2Schema.parse({
    format: "aih-artifact-intake",
    version: 2,
    authority: { state: "not-authority" },
    defaults: { accountableOwner: "platform@acme.example" },
    items: [
      ...directoryIntake().items,
      {
        id: "firecrawl-mcp",
        kind: "mcp",
        source: {
          type: "npm",
          registry: "https://registry.npmjs.org",
          package: "firecrawl-mcp",
          version: "3.24.0",
          integrity: REGISTRY_INTEGRITY,
        },
      },
    ],
  });
}

function mixedIntakeEvidenceRecord() {
  const source = mixedIntake();
  const exact = artifactIntakeExactProjectionV1(source);
  const item = exact?.items[0];
  if (exact === undefined || item === undefined) throw new Error("expected exact intake item");
  return artifactEvidenceRecordV1({
    intake: exact,
    item,
    state: "verified",
    observed: {
      type: "npm",
      tarballSha256: `sha256:${"b".repeat(64)}`,
      registryIntegrity: REGISTRY_INTEGRITY,
    },
    analyzersRun: ["aih-native"],
    checks: [{ name: "trust scan", verdict: "pass" }],
    findings: [],
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

  it("rejects evidence whose identity, candidate, source digest, and observed source diverge", () => {
    const altered = structuredClone(firecrawlRecord());
    altered.id = "scan-wrong-000000000000";
    altered.candidate = "review-agent";
    altered.sourceDigest = `sha256:${"0".repeat(64)}`;
    altered.observed = { type: "github", commit: SHA };

    expect(ArtifactEvidenceRecordV1Schema.safeParse(altered).success).toBe(false);
  });

  it("rejects duplicate bundle results and duplicate records for one item", () => {
    const duplicate = createArtifactEvidenceBundleV1(intake(), [firecrawlRecord()]);
    const duplicateResult = duplicate.results[0];
    const duplicateRecord = duplicate.evidence[0];
    if (duplicateResult === undefined || duplicateRecord === undefined) {
      throw new Error("expected generated evidence bundle entries");
    }
    duplicate.results.push(structuredClone(duplicateResult));
    duplicate.evidence.push(structuredClone(duplicateRecord));
    const { bundleDigest: _digest, ...unsigned } = duplicate;
    duplicate.bundleDigest = artifactEvidenceBundleDigestV1(unsigned);

    expect(ArtifactEvidenceBundleV1Schema.safeParse(duplicate).success).toBe(false);
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

  it("rejects altered directory record identity and source binding", () => {
    const source = directoryIntake();
    const item = source.items[0];
    if (item === undefined) throw new Error("expected directory intake item");
    const resolution = artifactDirectoryResolutionRecordV2({
      intake: source,
      item,
      resolution: firecrawlDirectoryResolution(),
    });
    const altered = structuredClone(resolution);
    altered.id = "resolve-firecrawl-directory-000000000000";
    altered.sourceDigest = `sha256:${"0".repeat(64)}`;
    altered.source = {
      type: "directory",
      provider: "mcpmarket",
      url: "https://mcpmarket.com/server/firecrawl",
    };

    expect(ArtifactDirectoryResolutionRecordV2Schema.safeParse(altered).success).toBe(false);
  });

  it("rejects duplicate exact-source evidence and duplicate results in a version 2 bundle", () => {
    const source = mixedIntake();
    const record = mixedIntakeEvidenceRecord();
    const duplicate = createArtifactEvidenceBundleV2(source, [record], []);
    const evidenceResult = duplicate.results.find((entry) => entry.itemId === record.itemId);
    if (evidenceResult === undefined) throw new Error("expected exact evidence result");
    duplicate.results.push(structuredClone(evidenceResult));
    duplicate.evidence.push(structuredClone(record));
    const { bundleDigest: _digest, ...unsigned } = duplicate;
    duplicate.bundleDigest = artifactEvidenceBundleDigestV2(unsigned);

    expect(ArtifactEvidenceBundleV2Schema.safeParse(duplicate).success).toBe(false);
  });

  it("rejects one item claiming both scan evidence and directory resolution", () => {
    const source = directoryIntake();
    const item = source.items[0];
    if (item === undefined) throw new Error("expected directory intake item");
    const resolution = artifactDirectoryResolutionRecordV2({
      intake: source,
      item,
      resolution: firecrawlDirectoryResolution(),
    });
    const conflictingIntake = intake();
    const originalConflictingItem = conflictingIntake.items[0];
    if (originalConflictingItem === undefined) {
      throw new Error("expected conflicting intake item");
    }
    conflictingIntake.items[0] = {
      ...originalConflictingItem,
      id: item.id,
    };
    const conflictingItem = conflictingIntake.items[0];
    if (conflictingItem === undefined) throw new Error("expected conflicting intake item");
    const evidence = artifactEvidenceRecordV1({
      intake: conflictingIntake,
      item: conflictingItem,
      state: "verified",
      observed: {
        type: "npm",
        tarballSha256: `sha256:${"b".repeat(64)}`,
        registryIntegrity: REGISTRY_INTEGRITY,
      },
      analyzersRun: ["aih-native"],
      checks: [{ name: "trust scan", verdict: "pass" }],
      findings: [],
    });
    const conflict = createArtifactEvidenceBundleV2(source, [], [resolution]);
    conflict.evidence.push(evidence);
    const { bundleDigest: _digest, ...unsigned } = conflict;
    conflict.bundleDigest = artifactEvidenceBundleDigestV2(unsigned);

    expect(ArtifactEvidenceBundleV2Schema.safeParse(conflict).success).toBe(false);
  });

  it("rejects unsupported creator bindings and malformed missing-result claims", () => {
    const source = mixedIntake();
    const exactItem = source.items.find((item) => item.source.type === "npm");
    const directoryItem = source.items.find((item) => item.source.type === "directory");
    if (exactItem === undefined || directoryItem === undefined) {
      throw new Error("expected mixed intake items");
    }
    expect(() =>
      artifactDirectoryResolutionRecordV2({
        intake: source,
        item: exactItem,
        resolution: firecrawlDirectoryResolution(),
      }),
    ).toThrow(/not a directory MCP candidate/);

    const exactRecord = mixedIntakeEvidenceRecord();
    expect(() => createArtifactEvidenceBundleV2(directoryIntake(), [exactRecord], [])).toThrow(
      /scan evidence does not match/,
    );

    const directorySource = directoryIntake();
    const sourceDirectoryItem = directorySource.items[0];
    if (sourceDirectoryItem === undefined) throw new Error("expected directory intake item");
    const directoryResolution = artifactDirectoryResolutionRecordV2({
      intake: directorySource,
      item: sourceDirectoryItem,
      resolution: firecrawlDirectoryResolution(),
    });
    const mismatchedResolution = structuredClone(directoryResolution);
    mismatchedResolution.accountableOwner = "different-owner@acme.example";
    expect(() => createArtifactEvidenceBundleV2(source, [], [mismatchedResolution])).toThrow(
      /directory resolution does not match/,
    );

    const missingClaim = createArtifactEvidenceBundleV2(directorySource, [], []);
    const missingResult = missingClaim.results[0];
    if (missingResult === undefined) throw new Error("expected missing evidence result");
    missingResult.state = "verified";
    const { bundleDigest: _digest, ...unsigned } = missingClaim;
    missingClaim.bundleDigest = artifactEvidenceBundleDigestV2(unsigned);
    expect(ArtifactEvidenceBundleV2Schema.safeParse(missingClaim).success).toBe(false);
  });

  it("rejects malformed registry, discovery, and directory source primitives", () => {
    expect(
      ArtifactObservedSourceV1Schema.safeParse({
        type: "npm",
        tarballSha256: `sha256:${"b".repeat(64)}`,
        registryIntegrity: "not-an-sri",
      }).success,
    ).toBe(false);

    const malformedExact = structuredClone(intake());
    const malformedNpmItem = malformedExact.items.find((item) => item.source.type === "npm");
    if (malformedNpmItem === undefined || malformedNpmItem.source.type !== "npm") {
      throw new Error("expected npm intake item");
    }
    malformedNpmItem.discoveryUrl = "not a URL";
    malformedNpmItem.source.registry = "not a URL";
    malformedNpmItem.source.integrity = "not-an-sri";
    expect(ArtifactIntakeV1Schema.safeParse(malformedExact).success).toBe(false);

    const mismatchedDirectory = structuredClone(directoryIntake());
    const mismatchedItem = mismatchedDirectory.items[0];
    if (mismatchedItem === undefined || mismatchedItem.source.type !== "directory") {
      throw new Error("expected directory intake item");
    }
    mismatchedItem.source.provider = "mcpmarket";
    expect(ArtifactIntakeV2Schema.safeParse(mismatchedDirectory).success).toBe(false);

    const unsupportedDirectory = structuredClone(directoryIntake());
    const unsupportedItem = unsupportedDirectory.items[0];
    if (unsupportedItem === undefined || unsupportedItem.source.type !== "directory") {
      throw new Error("expected directory intake item");
    }
    unsupportedItem.source.url = "https://example.com/not-a-directory";
    expect(ArtifactIntakeV2Schema.safeParse(unsupportedDirectory).success).toBe(false);
  });

  it("rejects absent creator items and ambiguous version 2 intake identity", () => {
    const exactSource = intake();
    const absentExactItem = structuredClone(exactSource.items[0]);
    if (absentExactItem === undefined) throw new Error("expected exact intake item");
    absentExactItem.id = "absent-exact-item";
    expect(() =>
      artifactEvidenceRecordV1({
        intake: exactSource,
        item: absentExactItem,
        state: "verified",
        observed: {
          type: "npm",
          tarballSha256: `sha256:${"b".repeat(64)}`,
          registryIntegrity: REGISTRY_INTEGRITY,
        },
        analyzersRun: ["aih-native"],
        checks: [],
        findings: [],
      }),
    ).toThrow(/intake item is absent/);

    const directorySource = directoryIntake();
    const absentDirectoryItem = structuredClone(directorySource.items[0]);
    if (absentDirectoryItem === undefined) throw new Error("expected directory intake item");
    absentDirectoryItem.id = "absent-directory-item";
    expect(() =>
      artifactDirectoryResolutionRecordV2({
        intake: directorySource,
        item: absentDirectoryItem,
        resolution: firecrawlDirectoryResolution(),
      }),
    ).toThrow(/intake item is absent/);

    const duplicatedItem = structuredClone(directorySource.items[0]);
    if (duplicatedItem === undefined) throw new Error("expected directory intake item");
    delete duplicatedItem.accountableOwner;
    const ambiguous = {
      format: "aih-artifact-intake",
      version: 2,
      authority: { state: "not-authority" },
      items: [duplicatedItem, structuredClone(duplicatedItem)],
    };
    expect(ArtifactIntakeV2Schema.safeParse(ambiguous).success).toBe(false);
    expect(artifactIntakeExactProjectionV1(directorySource)).toBeUndefined();
    expect(() => artifactEvidenceRecordIdV1("valid-item", "sha256:NOT-LOWERCASE")).toThrow(
      /lowercase SHA-256/,
    );
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
