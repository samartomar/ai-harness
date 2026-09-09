import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalStrictJsonSha256V1 } from "../../../../src/contract/strict-json-v1.js";

const mocks = vi.hoisted(() => ({ author: vi.fn() }));
vi.mock("../../../../src/baseline-evidence/aih-scan-preparation.js", () => ({
  authorPreparedAihScannerPublicationV1: mocks.author,
}));

import {
  compilerQualificationBindingDigestV1,
  prepareAihFirstPartyCompilerQualificationsV1,
} from "../../../../src/org-policy/workbench/core/catalog-qualification-v1.js";
import { defaultPreparedWorkbenchCatalog } from "../../../../src/org-policy/workbench/prepared-catalog.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = (value: string | Uint8Array) => `sha256:${sha(value)}`;
const baselineBundle = structuredClone(defaultPreparedWorkbenchCatalog().bundle);
const coreReleaseMatch = /^package:@aihq\/core@(.+)$/.exec(
  baselineBundle.sources["source:aih-core"]?.revision.id ?? "",
);
const coreRelease = coreReleaseMatch?.[1];
if (coreRelease === undefined)
  throw new Error("built-in Core source must declare an exact package release");

function output(bundle = structuredClone(baselineBundle)) {
  const source = bundle.sources["source:aih-core"]!;
  const components = Object.values(bundle.assets)
    .filter((asset) => asset.sourceId === source.id)
    .map((asset) => {
      const pack = /^packs\/([a-z][a-z0-9-]{0,63})\//.test(asset.originalPath);
      const mcp = asset.kind === "mcp";
      const paths = pack
        ? ["aih-packs.json", asset.originalPath].sort()
        : mcp
          ? [`declarations/claude/project/${asset.label}.json`]
          : ["generated/usage-metering/usage-record.mjs"];
      const files = pack
        ? [
            { path: "aih-packs.json", digest: digest(`${asset.id}:manifest`) },
            { path: `${asset.originalPath}/SKILL.md`, digest: digest(`${asset.id}:pack`) },
          ]
        : [{ path: paths[0]!, digest: digest(asset.id) }];
      return {
        componentId: `asset:${sha(asset.id)}`,
        componentTreeSha256: sha(`tree:${asset.id}`),
        paths,
        files,
        subject: {
          assetId: asset.id,
          sourceId: source.id,
          sourceRevisionId: source.revision.id,
          contentDigest: asset.contentDigest,
        },
      };
    })
    .sort((left, right) => left.componentId.localeCompare(right.componentId));
  const coverage = {
    version: "workbench-scanner-coverage/v1" as const,
    authority: "none" as const,
    scope: "declared-source-files" as const,
    compilerInputDigest: digest("built-in-input"),
    source: {
      id: source.id,
      revisionId: source.revision.id,
      contentDigest: source.revision.contentDigest,
      locator: source.upstreamOrigin.locator,
    },
    repository: "samartomar/ai-harness",
    pinnedCommit: "a".repeat(40),
    sourceTreeSha256: sha("source-tree"),
    components,
    unmappedDerivedAssets: [],
  };
  return {
    version: "aih-scanner-publication-output/v1" as const,
    authority: "none" as const,
    catalog: {
      id: "aih" as const,
      owner: "samartomar" as const,
      repository: "ai-harness" as const,
      pinnedCommit: coverage.pinnedCommit,
      sourceTreeSha256: coverage.sourceTreeSha256,
      coverageDigest: `sha256:${canonicalStrictJsonSha256V1(coverage)}`,
      source: {
        id: source.id,
        revisionId: source.revision.id,
        contentDigest: source.revision.contentDigest,
        inputFormat: "built-in/v1" as const,
        upstreamOrigin: { kind: "aih" as const, locator: source.upstreamOrigin.locator },
      },
    },
    coverage,
    report: {},
    publications: [],
    observations: components.map((component) => ({
      componentId: component.componentId,
      componentTreeSha256: component.componentTreeSha256,
      reportSignedAt: "2026-09-09T00:00:00.000Z",
      reportVerificationExpiresAt: "2026-09-10T00:00:00.000Z",
      requestSha256: sha(`request:${component.componentId}`),
      publicationSha256: sha(`publication:${component.componentId}`),
      receiptSha256: sha(`receipt:${component.componentId}`),
    })),
    verification: {
      method: "gh-attestation-verify" as const,
      preparedAt: "2026-09-09T00:00:00.000Z",
    },
  };
}

describe("first-party Catalog qualification preparation", () => {
  it("derives profiles and bindings only from the verified AIH witness", () => {
    const bundle = structuredClone(baselineBundle);
    mocks.author.mockReturnValue(output(bundle));
    const prepared = prepareAihFirstPartyCompilerQualificationsV1(bundle, {
      kind: "prepared-aih-scanner-publications/v1",
    });
    expect(prepared).toBeDefined();
    expect(Object.keys(prepared!.bindings)).toHaveLength(9);
    expect(
      Object.values(prepared!.bindings).filter(
        (binding) => binding.material.kind === "source-files",
      ),
    ).toHaveLength(3);
    expect(
      Object.values(prepared!.bindings).filter(
        (binding) => binding.material.kind === "configuration-only",
      ),
    ).toHaveLength(6);
    expect(prepared!.unsupported).toEqual([
      { assetId: "aih/usage-metering", reason: "unsupported-governance-subject-kind" },
    ]);
    for (const [assetId, binding] of Object.entries(prepared!.bindings)) {
      const profile = prepared!.profiles[assetId]!;
      expect(binding.subject.source).toMatchObject({
        type: "aih",
        release: coreRelease,
        revision: profile.sha256,
      });
      expect(profile.sha256).toBe(digest(Buffer.from(profile.bytes)));
      expect(JSON.parse(Buffer.from(profile.bytes).toString("utf8"))).toMatchObject({
        format: "aih-first-party-qualification-profile",
        asset: { assetId },
      });
    }
  });

  it("keeps profiles, subjects, and bindings stable across a reverify clock", () => {
    const first = output();
    const second = structuredClone(first);
    second.verification.preparedAt = "2026-09-10T00:00:00.000Z";
    mocks.author.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const left = prepareAihFirstPartyCompilerQualificationsV1(structuredClone(baselineBundle), {
      kind: "prepared-aih-scanner-publications/v1",
    });
    const right = prepareAihFirstPartyCompilerQualificationsV1(structuredClone(baselineBundle), {
      kind: "prepared-aih-scanner-publications/v1",
    });
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    for (const assetId of Object.keys(left!.bindings)) {
      expect(left!.profiles[assetId]!.sha256).toBe(right!.profiles[assetId]!.sha256);
      expect(left!.bindings[assetId]!.subject).toEqual(right!.bindings[assetId]!.subject);
      expect(compilerQualificationBindingDigestV1(left!.bindings[assetId]!)).toBe(
        compilerQualificationBindingDigestV1(right!.bindings[assetId]!),
      );
    }
  });

  it.each([
    "unavailable-witness",
    "changed-component",
    "changed-bundle-compiler",
    "changed-asset-source-revision",
  ])("fails closed for %s", (scenario) => {
    const bundle = structuredClone(baselineBundle);
    const authored = output(bundle);
    if (scenario === "unavailable-witness") mocks.author.mockReturnValue(undefined);
    else {
      if (scenario === "changed-component")
        authored.observations[0]!.componentTreeSha256 = sha("other-tree");
      if (scenario === "changed-bundle-compiler")
        bundle.sources["source:aih-core"]!.compiler.version = "2";
      if (scenario === "changed-asset-source-revision")
        bundle.assets["aih/code-review-graph"]!.sourceRevisionId = "package:@aihq/core@0.0.1";
      mocks.author.mockReturnValue(authored);
    }
    expect(
      prepareAihFirstPartyCompilerQualificationsV1(bundle, {
        kind: "prepared-aih-scanner-publications/v1",
      }),
    ).toBeUndefined();
  });
});
