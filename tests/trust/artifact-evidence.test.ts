import { describe, expect, it } from "vitest";
import {
  ArtifactEvidenceBundleV1Schema,
  artifactEvidenceRecordV1,
  createArtifactEvidenceBundleV1,
  parseArtifactEvidenceBundleV1Text,
  reconcileArtifactEvidenceV1,
} from "../../src/trust/artifact-evidence.js";
import { ArtifactIntakeV1Schema } from "../../src/trust/artifact-intake.js";

const SHA = "a".repeat(40);

function intake(version = "3.24.0") {
  return ArtifactIntakeV1Schema.parse({
    format: "aih-artifact-intake",
    version: 1,
    defaults: { accountableOwner: "platform@acme.example", targets: ["codex"] },
    items: [
      {
        id: "firecrawl-mcp",
        kind: "mcp",
        source: {
          type: "npm",
          registry: "https://registry.npmjs.org",
          package: "firecrawl-mcp",
          version,
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
    expect(() =>
      parseArtifactEvidenceBundleV1Text(
        '{"format":"aih-preflight-evidence-bundle","format":"other","version":1}',
      ),
    ).toThrow(/duplicate JSON object key/i);
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
  });
});
