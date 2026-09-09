import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashComponentTree } from "../../../../src/baseline-evidence/hash.js";
import { defaultRunner } from "../../../../src/internals/proc.js";
import {
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../../../src/org-policy/governance-decision-v2.js";
import type { AuthoringCatalogBundleV1 } from "../../../../src/org-policy/workbench/contracts.js";
import { CATALOG_QUALIFICATION_RELEASE_POLICY_V1 } from "../../../../src/org-policy/workbench/core/catalog-qualification-policy-v1.js";
import type {
  CatalogQualificationClosureV1,
  CompilerQualificationBindingV1,
} from "../../../../src/org-policy/workbench/core/catalog-qualification-v1.js";
import {
  canonicalCatalogQualificationClosureV1,
  catalogQualificationPreparedBundleV1,
  compilerQualificationBindingDigestV1,
  compilerQualificationBindingsFromRegisteredCoverageV1,
  inspectCatalogQualificationArtifactV1,
  preparePackagedCatalogQualificationV1,
  qualificationMaterialCoverageFromRegisteredCoverageV1,
  registeredCoverageGovernanceSubjectsV1,
  verifyCatalogQualificationArtifactsForPackagingV1,
} from "../../../../src/org-policy/workbench/core/catalog-qualification-v1.js";

vi.mock("../../../../src/internals/proc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/internals/proc.js")>()),
  defaultRunner: vi.fn(),
}));
vi.mock("../../../../src/live/runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/live/runner.js")>()),
  findOnPath: () => "fixture-gh",
}));

afterEach(() => vi.mocked(defaultRunner).mockReset());

const digest = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const bareDigest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function bundle(): AuthoringCatalogBundleV1 {
  const contentDigest = digest("skill bytes");
  const sourceDigest = digest("source bytes");
  return {
    version: "authoring-catalog-bundle/v1",
    sources: {
      "source:core": {
        id: "source:core",
        distributor: { kind: "aih", locator: "AIH" },
        upstreamOrigin: { kind: "aih", locator: "AIH" },
        inputFormat: "catalog-seed/v1",
        revision: { id: "release-1", contentDigest: sourceDigest },
        compiler: { id: "core", version: "1" },
      },
    },
    assets: {
      "aih/skill:review": {
        id: "aih/skill:review",
        sourceId: "source:core",
        sourceRevisionId: "release-1",
        contentDigest,
        originalPath: "skills/review/SKILL.md",
        derivation: "upstream",
        kind: "skill",
        label: "Review",
        detailChunkId: "detail:review",
        declaredHostCapabilities: [],
        authoring: { action: "record-selection", supportedTargets: [] },
      },
    },
    groups: {},
    relations: [],
    templates: {},
    evidence: {},
    provenance: { bundleDigest: digest("not-an-integrity-fixture") },
    detailChunks: {},
  } as AuthoringCatalogBundleV1;
}

function subject() {
  const source = { type: "aih" as const, release: "1.0.0", revision: digest("source bytes") };
  const sourceDigest = governanceDecisionSourceDigestV2(source);
  return {
    kind: "skill" as const,
    id: "review",
    source,
    sourceDigest,
    subjectDigest: governanceDecisionSubjectDigestV2({ kind: "skill", id: "review", sourceDigest }),
  };
}

function receipt(memberDigest: string, expiresAt = "2026-11-30T00:00:00Z") {
  const receiptSubject = subject();
  return {
    format: "aih-supported-qualification-receipt",
    version: 2,
    organizationAdmission: "not-authoritative",
    entryId: "recipe.review",
    subject: receiptSubject,
    qualificationBasis: {
      kind: "aih-supported",
      catalogSignerIdentity: "administrator:aih-supported/catalog-v2",
      catalogDigest: digest("catalog"),
      catalogHeadDigest: digest("head"),
      catalogMemberDigest: memberDigest,
      subjectKind: receiptSubject.kind,
      subjectDigest: receiptSubject.subjectDigest,
    },
    catalogContinuity: {
      catalogHeadDigest: digest("head"),
      previousCatalogHeadDigest: `sha256:${"0".repeat(64)}`,
      sequence: 0,
      replayIdentity: `catalog-head:${bareDigest("head")}:${bareDigest("replay")}`,
      signerKeyId: `ed25519:${bareDigest("key")}`,
      headValidFrom: "2026-09-01T00:00:00Z",
      headValidUntil: expiresAt,
    },
    issuedAt: "2026-09-01T00:00:00Z",
    notBefore: "2026-09-01T00:00:00Z",
    expiresAt,
  };
}

function receiptSet(memberDigest: string, receiptBytes: Uint8Array) {
  return {
    format: "aih-supported-qualification-receipt-set",
    version: 1,
    entries: [
      {
        entryId: "recipe.review",
        memberDigest,
        path: "receipts/recipe.review.json",
        receiptSha256: bareDigest(receiptBytes),
      },
    ],
  };
}

function ghResult(
  publisher: {
    repository: string;
    workflow: string;
    ref: string;
    issuer: string;
    commit: string;
    subjectName: string;
  },
  bytes: Uint8Array,
) {
  const workflow = `https://github.com/${publisher.workflow}@${publisher.ref}`;
  return JSON.stringify([
    {
      verificationResult: {
        signature: {
          certificate: {
            subjectAlternativeName: workflow,
            buildSignerURI: workflow,
            buildConfigURI: workflow,
            issuer: publisher.issuer,
            sourceRepositoryURI: `https://github.com/${publisher.repository}`,
            sourceRepositoryRef: publisher.ref,
            sourceRepositoryDigest: publisher.commit,
            runnerEnvironment: "github-hosted",
          },
        },
        verifiedTimestamps: [
          { type: "signed", uri: "https://rekor.sigstore.dev", timestamp: "2026-09-02T00:00:00Z" },
        ],
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [{ name: publisher.subjectName, digest: { sha256: bareDigest(bytes) } }],
        },
      },
    },
  ]);
}

function artifacts() {
  const catalog = bundle();
  const receiptSubject = subject();
  const binding = {
    format: "aih-compiler-qualification-binding",
    version: 1,
    asset: {
      assetId: "aih/skill:review",
      sourceId: "source:core",
      sourceRevisionId: "release-1",
      contentDigest: catalog.assets["aih/skill:review"]!.contentDigest,
    },
    sourceContentDigest: catalog.sources["source:core"]!.revision.contentDigest,
    compiler: { id: "core", version: "1", inputFormat: "catalog-seed/v1" },
    subject: receiptSubject,
    material: {
      kind: "source-files",
      treeDigest: catalog.assets["aih/skill:review"]!.contentDigest,
      files: [{ path: "skills/review/SKILL.md", digest: digest("skill bytes") }],
    },
  } satisfies CompilerQualificationBindingV1;
  const closure = {
    format: "aih-supported-catalog-member-closure",
    version: 1,
    assetId: "aih/skill:review",
    sourceId: "source:core",
    sourceRevisionId: "release-1",
    sourceContentDigest: catalog.sources["source:core"]!.revision.contentDigest,
    contentDigest: catalog.assets["aih/skill:review"]!.contentDigest,
    subjectDigest: receiptSubject.subjectDigest,
    bindingDigest: compilerQualificationBindingDigestV1(binding),
    scope: { kind: "source-files", description: "Reviewed source files" },
    files: [{ path: "skills/review/SKILL.md", digest: digest("skill bytes") }],
  } satisfies CatalogQualificationClosureV1;
  const closureBytes = Buffer.from(canonicalCatalogQualificationClosureV1(closure), "utf8");
  const member = {
    capabilities: { commands: [], egress: [], hooks: [], mcpTools: [], permissions: [] },
    closure: {
      identity: "artifact:artifacts/review-closure.json",
      sha256: bareDigest(closureBytes),
    },
    entryId: "recipe.review",
    platforms: [{ architecture: "amd64", os: "linux" }],
    prose: { identity: "artifact:prose.md", sha256: bareDigest("prose") },
    qualification: {
      findings: [],
      gaps: [],
      report: { identity: "evidence:report", sha256: bareDigest("report") },
      rights: [],
    },
    recipe: { identity: "artifact:recipe.json", sha256: bareDigest("recipe") },
    subject: receiptSubject,
    versions: { effect: "2", schema: "2" },
  } as const;
  const memberDigest = digest(`aih-supported-catalog-member/v2\0${stable(member)}`);
  const receiptValue = receipt(memberDigest);
  const receiptBytes = Buffer.from(stable(receiptValue), "utf8");
  return {
    bundle: catalog,
    receiptBytes,
    receiptSetBytes: Buffer.from(stable(receiptSet(memberDigest, receiptBytes)), "utf8"),
    memberBytes: Buffer.from(stable(member), "utf8"),
    closureBytesByIdentity: { "artifact:artifacts/review-closure.json": closureBytes },
    coreBindings: { "aih/skill:review": binding },
    publisher: {
      ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1.publisher,
      subjectName: "recipe.review.json",
    },
    receiptSetPublisher: {
      ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1.receiptSetPublisher,
    },
  };
}

describe("Core Catalog qualification preparation", () => {
  it.each(["valid", "duplicate", "missing", "wrong-digest", "malformed", "overflow"] as const)(
    "checks exact membership in a bounded multi-receipt attestation: %s",
    async (scenario) => {
      const input = artifacts();
      let calls = 0;
      vi.mocked(defaultRunner).mockImplementation(async () => {
        const isReceipt = calls++ === 0;
        const publisher = isReceipt ? input.publisher : input.receiptSetPublisher;
        const bytes = isReceipt ? input.receiptBytes : input.receiptSetBytes;
        const result = JSON.parse(ghResult(publisher, bytes));
        if (isReceipt) {
          const subjects = result[0].verificationResult.statement.subject;
          for (let index = 1; index < 512; index++)
            subjects.push({
              name: `recipe.other-${index}.json`,
              digest: { sha256: bareDigest(String(index)) },
            });
          if (scenario === "duplicate") subjects[1] = structuredClone(subjects[0]);
          if (scenario === "missing") subjects.shift();
          if (scenario === "wrong-digest") subjects[0].digest.sha256 = "0".repeat(64);
          if (scenario === "malformed") subjects[1].digest.sha256 = "not-a-digest";
          if (scenario === "overflow")
            subjects.push({ name: "recipe.overflow.json", digest: { sha256: "0".repeat(64) } });
        }
        return { code: 0, stderr: "", stdout: JSON.stringify(result) };
      });
      const prepared = await verifyCatalogQualificationArtifactsForPackagingV1(
        input.bundle,
        input.coreBindings,
        [input],
        "2026-09-02T00:00:00Z",
      );
      expect(prepared !== undefined).toBe(scenario === "valid");
    },
  );
  it("accepts the measured expanded receipt-set size and rejects the next entry or a duplicate", () => {
    const input = artifacts();
    const set = JSON.parse(input.receiptSetBytes.toString("utf8"));
    for (let index = 1; index < 512; index++) {
      const entryId = `recipe.extra-${String(index).padStart(3, "0")}`;
      set.entries.push({
        entryId,
        path: `receipts/${entryId}.json`,
        memberDigest: digest(entryId),
        receiptSha256: bareDigest(entryId),
      });
    }
    set.entries.sort((a: { entryId: string }, b: { entryId: string }) =>
      a.entryId.localeCompare(b.entryId),
    );
    input.receiptSetBytes = Buffer.from(stable(set));
    expect(input.receiptSetBytes.length).toBeGreaterThan(32_768);
    expect(
      inspectCatalogQualificationArtifactV1(
        input.bundle,
        input,
        input.coreBindings,
        "2026-09-02T00:00:00Z",
      ),
    ).toBeDefined();
    set.entries.push({
      entryId: "recipe.zzz",
      path: "receipts/recipe.zzz.json",
      memberDigest: digest("extra"),
      receiptSha256: bareDigest("extra"),
    });
    input.receiptSetBytes = Buffer.from(stable(set));
    expect(
      inspectCatalogQualificationArtifactV1(
        input.bundle,
        input,
        input.coreBindings,
        "2026-09-02T00:00:00Z",
      ),
    ).toBeUndefined();
    set.entries.pop();
    set.entries[1] = structuredClone(set.entries[0]);
    input.receiptSetBytes = Buffer.from(stable(set));
    expect(
      inspectCatalogQualificationArtifactV1(
        input.bundle,
        input,
        input.coreBindings,
        "2026-09-02T00:00:00Z",
      ),
    ).toBeUndefined();
  });
  it.each(["5e18dd66e42f91c30e4c5acd81d41f1e33cd987a", "b019b4e9d6260915a49d177bcc22b58518305dd4"])(
    "requires the fixed GH boundary for retained publisher %s",
    async (commit) => {
      const fixture = artifacts();
      const input = {
        ...fixture,
        publisher: { ...fixture.publisher, commit },
        receiptSetPublisher: { ...fixture.receiptSetPublisher, commit },
      };
      let calls = 0;
      vi.mocked(defaultRunner).mockImplementation(async (argv, options) => {
        expect(argv).toContain("--deny-self-hosted-runners");
        expect(options).toMatchObject({ timeoutMs: 30_000, maxBufferBytes: 256 * 1024 });
        const publisher = calls++ === 0 ? input.publisher : input.receiptSetPublisher;
        const bytes = calls === 1 ? input.receiptBytes : input.receiptSetBytes;
        return { code: 0, stderr: "", stdout: ghResult(publisher, bytes) };
      });
      const prepared = await verifyCatalogQualificationArtifactsForPackagingV1(
        input.bundle,
        input.coreBindings,
        [input],
        "2026-09-02T00:00:00Z",
        "2026-09-02T00:00:00Z",
      );
      expect(calls).toBe(2);
      expect(
        catalogQualificationPreparedBundleV1(input.bundle, prepared)?.qualifications,
      ).toMatchObject({
        "aih/skill:review": { verifiedAt: "2026-09-02T00:00:00Z" },
      });
    },
  );

  it("rejects an attestation newer than the preserved package verification time", async () => {
    const input = artifacts();
    let calls = 0;
    vi.mocked(defaultRunner).mockImplementation(async () => {
      const publisher = calls++ === 0 ? input.publisher : input.receiptSetPublisher;
      const bytes = calls === 1 ? input.receiptBytes : input.receiptSetBytes;
      return { code: 0, stderr: "", stdout: ghResult(publisher, bytes) };
    });
    await expect(
      verifyCatalogQualificationArtifactsForPackagingV1(
        input.bundle,
        input.coreBindings,
        [input],
        "2026-09-02T00:00:00Z",
        "2026-09-01T00:00:00Z",
      ),
    ).resolves.toBeUndefined();
  });

  it("does not mint from a GH result bound to a different publisher", async () => {
    const input = artifacts();
    vi.mocked(defaultRunner).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: ghResult(input.publisher, input.receiptBytes),
    });
    (input.publisher as { repository: string }).repository = "forged/catalog";
    await expect(
      verifyCatalogQualificationArtifactsForPackagingV1(
        input.bundle,
        input.coreBindings,
        [input],
        "2026-09-02T00:00:00Z",
      ),
    ).resolves.toBeUndefined();
  });

  it("builds source-file bindings only from complete registered Core coverage", () => {
    const input = artifacts();
    const binding = input.coreBindings["aih/skill:review"]!;
    const coverage = {
      source: {
        id: "source:core",
        revisionId: "release-1",
        contentDigest: input.bundle.sources["source:core"]!.revision.contentDigest,
      },
      components: [
        {
          componentId: "review",
          componentTreeSha256:
            binding.material.kind === "source-files"
              ? binding.material.treeDigest.slice("sha256:".length)
              : "",
          paths: ["skills/review/SKILL.md"],
          files: binding.material.kind === "source-files" ? binding.material.files : [],
          subject: binding.asset,
        },
      ],
      unmappedDerivedAssets: [],
    };
    expect(
      compilerQualificationBindingsFromRegisteredCoverageV1(input.bundle, coverage, {
        "aih/skill:review": binding.subject,
      }),
    ).toEqual(input.coreBindings);
    coverage.components[0]!.files[0]!.digest = "not-a-digest";
    expect(
      compilerQualificationBindingsFromRegisteredCoverageV1(input.bundle, coverage, {
        "aih/skill:review": binding.subject,
      }),
    ).toBeUndefined();
  });

  it("binds compiler qualification to the actual LICENSE material without changing Scanner coverage", () => {
    const input = artifacts();
    const root = mkdtempSync(join(tmpdir(), "aih-qualification-license-"));
    try {
      mkdirSync(join(root, "skills", "review"), { recursive: true });
      writeFileSync(join(root, "skills", "review", "SKILL.md"), "skill bytes");
      writeFileSync(join(root, "LICENSE"), "license one");
      const scanned = hashComponentTree(root, ["skills/review/SKILL.md"]);
      const coverage = {
        source: {
          id: "source:core",
          revisionId: "release-1",
          contentDigest: input.bundle.sources["source:core"]!.revision.contentDigest,
        },
        components: [
          {
            componentId: "review",
            componentTreeSha256: scanned.treeSha256,
            paths: ["skills/review/SKILL.md"],
            files: scanned.files.map((file) => ({
              path: file.path,
              digest: `sha256:${file.sha256}`,
            })),
            subject: input.coreBindings["aih/skill:review"]!.asset,
          },
        ],
        unmappedDerivedAssets: [],
      };
      const qualified = qualificationMaterialCoverageFromRegisteredCoverageV1(root, coverage);
      expect(coverage.components[0]!.files.map((file) => file.path)).toEqual([
        "skills/review/SKILL.md",
      ]);
      expect(hashComponentTree(root, ["skills/review/SKILL.md"]).treeSha256).toBe(
        coverage.components[0]!.componentTreeSha256,
      );
      expect(qualified.components[0]!.files.map((file) => file.path)).toEqual([
        "LICENSE",
        "skills/review/SKILL.md",
      ]);
      const subjects = { "aih/skill:review": input.coreBindings["aih/skill:review"]!.subject };
      const first = compilerQualificationBindingsFromRegisteredCoverageV1(
        input.bundle,
        qualified,
        subjects,
      );
      expect(first?.["aih/skill:review"]?.material).toMatchObject({
        kind: "source-files",
        files: expect.arrayContaining([{ path: "LICENSE", digest: expect.any(String) }]),
      });
      writeFileSync(join(root, "LICENSE"), "license two");
      expect(hashComponentTree(root, ["skills/review/SKILL.md"]).treeSha256).toBe(
        coverage.components[0]!.componentTreeSha256,
      );
      const second = compilerQualificationBindingsFromRegisteredCoverageV1(
        input.bundle,
        qualificationMaterialCoverageFromRegisteredCoverageV1(root, coverage),
        subjects,
      );
      expect(compilerQualificationBindingDigestV1(first!["aih/skill:review"]!)).not.toBe(
        compilerQualificationBindingDigestV1(second!["aih/skill:review"]!),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps supported registered Git assets eligible while explicitly skipping unsupported kinds", () => {
    const input = bundle();
    const original = input.assets["aih/skill:review"]!;
    input.sources["source:core"]!.upstreamOrigin = {
      kind: "git",
      locator: "affaan-m/ECC",
    };
    input.sources["source:core"]!.revision.id = "0123456789abcdef0123456789abcdef01234567";
    input.assets = {
      "mattpocock/skill:review": {
        ...original,
        id: "mattpocock/skill:review",
        sourceRevisionId: input.sources["source:core"]!.revision.id,
      },
      "mattpocock/hook:setup": {
        ...original,
        id: "mattpocock/hook:setup",
        sourceRevisionId: input.sources["source:core"]!.revision.id,
        kind: "hook",
      },
    };
    const coverage = {
      source: {
        id: "source:core",
        revisionId: input.sources["source:core"]!.revision.id,
        contentDigest: input.sources["source:core"]!.revision.contentDigest,
      },
      components: [
        {
          componentId: "skill:review",
          componentTreeSha256: "0".repeat(64),
          paths: ["skills/review/SKILL.md"],
          files: [{ path: "skills/review/SKILL.md", digest: digest("skill bytes") }],
          subject: {
            assetId: "mattpocock/skill:review",
            sourceId: "source:core",
            sourceRevisionId: input.sources["source:core"]!.revision.id,
            contentDigest: original.contentDigest,
          },
        },
        {
          componentId: "hook:setup",
          componentTreeSha256: "1".repeat(64),
          paths: ["hooks/setup.js"],
          files: [{ path: "hooks/setup.js", digest: digest("hook bytes") }],
          subject: {
            assetId: "mattpocock/hook:setup",
            sourceId: "source:core",
            sourceRevisionId: input.sources["source:core"]!.revision.id,
            contentDigest: original.contentDigest,
          },
        },
      ],
      unmappedDerivedAssets: [],
    };
    expect(Object.keys(registeredCoverageGovernanceSubjectsV1(input, coverage) ?? {})).toEqual([
      "mattpocock/skill:review",
    ]);
  });

  it("creates an authoring-only qualification summary after attested receipt, member, closure and exact bundle joins", async () => {
    const input = artifacts();
    const summaries = inspectCatalogQualificationArtifactV1(
      input.bundle,
      input,
      input.coreBindings,
      "2026-09-02T00:00:00Z",
    );
    expect(summaries).toMatchObject({
      "aih/skill:review": expect.objectContaining({
        state: "qualified",
        originalIssuedAt: "2026-09-01T00:00:00Z",
        validUntil: "2026-11-30T00:00:00Z",
      }),
    });
    expect(input.bundle.evidence).toEqual({});
    expect(catalogQualificationPreparedBundleV1(input.bundle, summaries)).toBeUndefined();
  });

  it.each([
    "forged member hash",
    "receipt-set receipt hash drift",
    "forged closure digest",
    "compiler binding drift",
    "bundle content pin drift",
    "closure file drift",
  ])("fails closed for %s", async (caseName) => {
    const input = artifacts();
    if (caseName === "forged member hash")
      input.receiptBytes = Buffer.from(stable(receipt(digest("other"))), "utf8");
    if (caseName === "receipt-set receipt hash drift")
      input.receiptSetBytes = Buffer.from(
        input.receiptSetBytes.toString("utf8").replace(/a/g, "b"),
        "utf8",
      );
    if (caseName === "forged closure digest")
      input.memberBytes = Buffer.from(
        input.memberBytes.toString("utf8").replace(/a/g, "b"),
        "utf8",
      );
    if (caseName === "compiler binding drift")
      input.coreBindings["aih/skill:review"] = {
        ...input.coreBindings["aih/skill:review"],
        material: {
          kind: "source-files",
          treeDigest: digest("other tree"),
          files: [{ path: "skills/review/other.md", digest: digest("other bytes") }],
        },
      };
    if (caseName === "bundle content pin drift")
      input.bundle.assets["aih/skill:review"]!.contentDigest = digest("other");
    if (caseName === "closure file drift")
      input.closureBytesByIdentity["artifact:artifacts/review-closure.json"] = Buffer.from(
        input.closureBytesByIdentity["artifact:artifacts/review-closure.json"]!.toString(
          "utf8",
        ).replace("skills/review/SKILL.md", "skills/review/other.md"),
        "utf8",
      );
    expect(
      inspectCatalogQualificationArtifactV1(
        input.bundle,
        input,
        input.coreBindings,
        "2026-09-02T00:00:00Z",
      ),
    ).toBeUndefined();
  });

  it("rejects a structural qualification summary from the opaque output path", () => {
    const input = artifacts();
    const summaries = inspectCatalogQualificationArtifactV1(
      input.bundle,
      input,
      input.coreBindings,
      "2026-09-02T00:00:00Z",
    );
    expect(
      catalogQualificationPreparedBundleV1(input.bundle, structuredClone(summaries)),
    ).toBeUndefined();
  });

  it("uses the signed earlier expiry and never creates scan evidence", async () => {
    const input = artifacts();
    input.receiptBytes = Buffer.from(
      stable(
        receipt(
          digest(`aih-supported-catalog-member/v2\0${input.memberBytes.toString("utf8")}`),
          "2026-09-15T00:00:00Z",
        ),
      ),
      "utf8",
    );
    input.receiptSetBytes = Buffer.from(
      stable(
        receiptSet(
          digest(`aih-supported-catalog-member/v2\0${input.memberBytes.toString("utf8")}`),
          input.receiptBytes,
        ),
      ),
      "utf8",
    );
    const summaries = inspectCatalogQualificationArtifactV1(
      input.bundle,
      input,
      input.coreBindings,
      "2026-09-02T00:00:00Z",
    );
    expect(summaries?.["aih/skill:review"]?.validUntil).toBe("2026-09-15T00:00:00Z");
    expect(input.bundle.evidence).toEqual({});
  });

  it("expires qualification at its signed boundary independently of scan evidence", async () => {
    const input = artifacts();
    expect(
      inspectCatalogQualificationArtifactV1(
        input.bundle,
        input,
        input.coreBindings,
        "2026-11-30T00:00:00Z",
      ),
    ).toBeUndefined();
    expect(input.bundle.evidence).toEqual({});
  });

  it("ships no inputless qualification for the historical public Catalog fixture", () => {
    expect(preparePackagedCatalogQualificationV1(bundle())).toBeUndefined();
  });
});
