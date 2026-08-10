import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeGitHubRepository,
  parseGitHubSkillSource,
} from "../../src/capability/package-graph/adapters/github.js";
import {
  adaptSkillPackageGraph,
  type SkillPackageGraphAdapterInput,
} from "../../src/capability/package-graph/adapters/skills.js";
import { buildPackageGraphIndex } from "../../src/capability/package-graph/build.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function bytes(value: unknown, spacing?: number): Buffer {
  return Buffer.from(JSON.stringify(value, null, spacing), "utf8");
}

function exactSha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function lockEntry(
  overrides: Partial<{
    name: string;
    source: string;
    commit: string;
    verdict: "GREEN" | "YELLOW";
    extra: unknown;
  }> = {},
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: "clean",
    source: `Owner/Repo@${SHA_A}`,
    commit: SHA_A,
    verdict: "GREEN",
    scope: "repo",
    card: "ai-coding/skill-cards/clean.json",
    evidenceSha256: "e".repeat(64),
    approvedBy: "docs-platform",
    approvedAt: "2026-08-09T00:00:00.000Z",
  };
  return { ...entry, ...overrides };
}

function packRef(
  overrides: Partial<{ name: string; source: string; commit: string }> = {},
): Record<string, unknown> {
  return {
    name: "clean",
    source: `Owner/Repo@${SHA_A}`,
    commit: SHA_A,
    ...overrides,
  };
}

function input(
  overrides: Partial<SkillPackageGraphAdapterInput> = {},
): SkillPackageGraphAdapterInput {
  return {
    lockAuthorityId: "lock:aih-skills",
    catalogAuthorityId: "catalog:aih-packs",
    hostSource: { provider: "github", repository: "Host/Project" },
    lockBytes: bytes({ schemaVersion: 1, skills: [lockEntry()] }),
    packsBytes: bytes({
      schemaVersion: 1,
      packs: [{ name: "docs-quality", skills: [packRef()] }],
    }),
    ...overrides,
  };
}

describe("Package Graph GitHub skill identity", () => {
  it("requires an anchored source@lower40 identity matching commit and normalizes repository case", () => {
    expect(parseGitHubSkillSource(`Owner/Repo@${SHA_A}`, SHA_A)).toEqual({
      success: true,
      source: { provider: "github", repository: "owner/repo" },
      sourceDigest: { algorithm: "git-sha1", value: SHA_A },
    });
    expect(normalizeGitHubRepository("Host/Project")).toBe("host/project");

    for (const [source, commit] of [
      ["owner/repo", SHA_A],
      [`github:owner/repo@${SHA_A}`, SHA_A],
      [`https://github.com/owner/repo@${SHA_A}`, SHA_A],
      [`owner/repo@${SHA_A.toUpperCase()}`, SHA_A],
      [`owner/repo@${SHA_A}`, SHA_B],
      [`owner/repo@${SHA_A}/path`, SHA_A],
      [`owner/repo@${SHA_A}`, "local"],
    ] as const) {
      expect(parseGitHubSkillSource(source, commit).success).toBe(false);
    }

    for (const repository of ["owner", "owner/repo/path", "owner/re po", "owner/repo@main"]) {
      expect(normalizeGitHubRepository(repository)).toBeUndefined();
    }
  });
});

describe("Package Graph skill authority adapters", () => {
  it("projects matching lock and catalog claims without turning governance fields into risk", () => {
    const result = adaptSkillPackageGraph(input());

    expect(result.diagnostics).toEqual([]);
    expect(result.documents).toHaveLength(2);
    expect(result.documents[0]).toMatchObject({
      authority: { id: "lock:aih-skills", kind: "lock" },
      graph: {
        surfaces: [
          {
            id: "skill:clean",
            source: { provider: "github", repository: "owner/repo" },
            sourceDigest: { algorithm: "git-sha1", value: SHA_A },
            declaredRisk: [],
            observedRisk: [],
          },
        ],
        packages: [],
      },
    });
    expect(result.documents[1]).toMatchObject({
      authority: { id: "catalog:aih-packs", kind: "catalog" },
      graph: {
        surfaces: [{ id: "skill:clean", declaredRisk: [], observedRisk: [] }],
        packages: [
          {
            id: "package:skill-pack/docs-quality",
            source: { provider: "github", repository: "host/project" },
            members: ["skill:clean"],
            declaredRisk: [],
            observedRisk: [],
          },
        ],
      },
    });

    const index = buildPackageGraphIndex(result.documents);
    expect(index.claims.filter(({ id }) => id === "skill:clean")).toHaveLength(2);
    expect(index.conflicts).toEqual([]);
  });

  it("hashes exact authority bytes while stable semantic projections ignore JSON formatting", () => {
    const lock = { schemaVersion: 1, skills: [lockEntry()] };
    const compact = adaptSkillPackageGraph(input({ lockBytes: bytes(lock) }));
    const pretty = adaptSkillPackageGraph(input({ lockBytes: bytes(lock, 2) }));
    const compactLock = compact.documents.find(({ authority }) => authority.kind === "lock");
    const prettyLock = pretty.documents.find(({ authority }) => authority.kind === "lock");
    if (compactLock === undefined || prettyLock === undefined)
      throw new Error("expected lock docs");

    expect(compactLock.authority.sourceDigest.value).toBe(exactSha256(input().lockBytes));
    expect(compactLock.authority.sourceDigest).not.toEqual(prettyLock.authority.sourceDigest);
    expect(compactLock.graph).toEqual(prettyLock.graph);
    expect(buildPackageGraphIndex([compactLock]).authorities[0]?.projectionDigest).toBe(
      buildPackageGraphIndex([prettyLock]).authorities[0]?.projectionDigest,
    );
  });

  it("retains a catalog-only ref as a catalog claim with an explicit diagnostic", () => {
    const result = adaptSkillPackageGraph(
      input({ lockBytes: bytes({ schemaVersion: 1, skills: [] }) }),
    );

    expect(result.documents).toHaveLength(2);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        authorityKind: "catalog",
        code: "package-graph.catalog-only-ref",
        entityId: "skill:clean",
      }),
    ]);
    expect(
      result.documents
        .find(({ authority }) => authority.kind === "catalog")
        ?.graph.surfaces.map(({ id }) => id),
    ).toEqual(["skill:clean"]);
  });

  it("preserves a catalog-lock source mismatch as divergent claims and a diagnostic", () => {
    const result = adaptSkillPackageGraph(
      input({
        packsBytes: bytes({
          schemaVersion: 1,
          packs: [
            {
              name: "docs-quality",
              skills: [packRef({ source: `Other/Repo@${SHA_B}`, commit: SHA_B })],
            },
          ],
        }),
      }),
    );

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        authorityKind: "catalog",
        code: "package-graph.catalog-lock-mismatch",
        entityId: "skill:clean",
      }),
    ]);
    const index = buildPackageGraphIndex(result.documents);
    expect(index.conflicts).toEqual([
      expect.objectContaining({ entityKind: "surface", id: "skill:clean" }),
    ]);
    expect(index.claims.filter(({ id }) => id === "skill:clean")).toHaveLength(2);
  });

  it("fails the catalog authority when requiredChecks cannot be represented", () => {
    const packsBytes = bytes({
      schemaVersion: 1,
      packs: [{ name: "docs-quality", requiredChecks: ["no-exec"], skills: [packRef()] }],
    });
    const result = adaptSkillPackageGraph(input({ packsBytes }));
    const catalog = result.documents.find(({ authority }) => authority.kind === "catalog");

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        authorityKind: "catalog",
        code: "package-graph.required-checks-unsupported",
        entityId: "package:skill-pack/docs-quality",
      }),
    ]);
    expect(catalog).toBeUndefined();
  });

  it("rejects malformed lock input at document granularity with no partial lock claim", () => {
    const invalidUtf8 = Buffer.from([0x7b, 0xff, 0x7d]);
    const cases: Array<{ bytes: Buffer; code: string }> = [
      { bytes: invalidUtf8, code: "package-graph.invalid-utf8" },
      { bytes: Buffer.from("{broken", "utf8"), code: "package-graph.invalid-json" },
      {
        bytes: bytes({ schemaVersion: 1, skills: [lockEntry()], extra: true }),
        code: "package-graph.invalid-schema",
      },
      {
        bytes: bytes({ schemaVersion: 1, skills: [lockEntry({ extra: true })] }),
        code: "package-graph.invalid-schema",
      },
      {
        bytes: bytes({
          schemaVersion: 1,
          skills: [
            {
              ...lockEntry(),
              sourceScope: {
                selectedSkillNames: ["clean"],
                includedPaths: ["skills/clean"],
                excludedSkillPaths: [],
                extra: true,
              },
            },
          ],
        }),
        code: "package-graph.invalid-schema",
      },
      {
        bytes: bytes({ schemaVersion: 1, skills: [lockEntry(), lockEntry()] }),
        code: "package-graph.duplicate-lock-name",
      },
      {
        bytes: bytes({
          schemaVersion: 1,
          skills: [
            lockEntry(),
            lockEntry({ name: "local", source: "/tmp/local", commit: "local" }),
          ],
        }),
        code: "package-graph.unsupported-source",
      },
      {
        bytes: bytes({ schemaVersion: 1, skills: [lockEntry({ name: "Unsafe Name" })] }),
        code: "package-graph.invalid-surface-id",
      },
    ];

    for (const candidate of cases) {
      const result = adaptSkillPackageGraph(input({ lockBytes: candidate.bytes }));
      expect(result.documents.some(({ authority }) => authority.kind === "lock")).toBe(false);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ authorityKind: "lock", code: candidate.code }),
        ]),
      );
    }
  });

  it("rejects malformed or ambiguous pack input at document granularity", () => {
    const cases: Array<{ value: unknown; code: string }> = [
      {
        value: { schemaVersion: 1, packs: [{ name: "docs", skills: [packRef()], extra: true }] },
        code: "package-graph.invalid-schema",
      },
      {
        value: {
          schemaVersion: 1,
          packs: [
            { name: "docs", skills: [packRef()] },
            { name: "docs", skills: [packRef({ name: "other" })] },
          ],
        },
        code: "package-graph.duplicate-pack-name",
      },
      {
        value: {
          schemaVersion: 1,
          packs: [{ name: "docs", skills: [packRef(), packRef()] }],
        },
        code: "package-graph.duplicate-pack-member",
      },
      {
        value: {
          schemaVersion: 1,
          packs: [
            { name: "docs", skills: [packRef()] },
            { name: "ops", skills: [packRef()] },
          ],
        },
        code: "package-graph.cross-pack-member",
      },
      {
        value: {
          schemaVersion: 1,
          packs: [
            {
              name: "docs",
              skills: [packRef(), packRef({ name: "local", source: "local", commit: "local" })],
            },
          ],
        },
        code: "package-graph.unsupported-source",
      },
      {
        value: {
          schemaVersion: 1,
          packs: [{ name: "Unsafe Name", skills: [packRef()] }],
        },
        code: "package-graph.invalid-package-id",
      },
    ];

    for (const candidate of cases) {
      const result = adaptSkillPackageGraph(input({ packsBytes: bytes(candidate.value) }));
      expect(result.documents.some(({ authority }) => authority.kind === "catalog")).toBe(false);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ authorityKind: "catalog", code: candidate.code }),
        ]),
      );
    }
  });

  it("rejects invalid host provenance without affecting the independent lock document", () => {
    const result = adaptSkillPackageGraph(
      input({ hostSource: { provider: "github", repository: "not-a-repository" } }),
    );

    expect(result.documents.map(({ authority }) => authority.kind)).toEqual(["lock"]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        authorityKind: "catalog",
        code: "package-graph.invalid-host-source",
      }),
    ]);
  });
  it("treats an absent pack artifact as a lock-only projection", () => {
    const { packsBytes: _packsBytes, ...withoutPacks } = input();

    const result = adaptSkillPackageGraph(withoutPacks);

    expect(result.documents.map(({ authority }) => authority.kind)).toEqual(["lock"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("reports invalid authority ids per document without throwing or hiding its sibling", () => {
    const invalidLock = adaptSkillPackageGraph(input({ lockAuthorityId: "catalog:not-a-lock" }));
    const invalidCatalog = adaptSkillPackageGraph(
      input({ catalogAuthorityId: "lock:not-a-catalog" }),
    );

    expect(invalidLock.documents.map(({ authority }) => authority.kind)).toEqual(["catalog"]);
    expect(invalidLock.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorityKind: "lock",
          code: "package-graph.invalid-authority-id",
        }),
      ]),
    );
    expect(invalidCatalog.documents.map(({ authority }) => authority.kind)).toEqual(["lock"]);
    expect(invalidCatalog.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorityKind: "catalog",
          code: "package-graph.invalid-authority-id",
        }),
      ]),
    );
  });
});
