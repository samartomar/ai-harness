import { describe, expect, it } from "vitest";
import { classifyPackageGraphResidue } from "../../src/capability/package-graph/adapters/residue.js";
import { buildPackageGraphIndex } from "../../src/capability/package-graph/build.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SOURCE = { provider: "github", repository: "acme/skills" };

function surface(
  id: string,
  digest: string,
  repository = SOURCE.repository,
): Record<string, unknown> {
  return {
    id,
    source: { provider: "github", repository },
    sourceDigest: { algorithm: "git-sha1", value: digest },
    declaredRisk: [],
    observedRisk: [],
  };
}

function document(
  kind: "catalog" | "lock" | "receipt",
  name: string,
  surfaces: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    authority: {
      id: `${kind}:${name}`,
      kind,
      sourceDigest: { algorithm: "sha256", value: "0".repeat(64) },
    },
    graph: { schemaVersion: 1, surfaces, packages: [] },
  };
}

function index(): ReturnType<typeof buildPackageGraphIndex> {
  return buildPackageGraphIndex([
    document("catalog", "baseline", [
      surface("skill:catalog-only", SHA_B),
      surface("skill:registered", SHA_A),
    ]),
    document("lock", "approvals", [surface("skill:registered", SHA_A)]),
    document("receipt", "install", [surface("skill:receipt", SHA_C)]),
  ]);
}

function discovered(): Array<Record<string, unknown>> {
  return [
    {
      id: "skill:registered",
      kind: "skill",
      rootKind: "promoted",
      source: SOURCE,
      sourceDigest: { algorithm: "git-sha1", value: SHA_A },
    },
    {
      id: "skill:receipt",
      kind: "skill",
      rootKind: "repo",
      source: SOURCE,
      sourceDigest: { algorithm: "git-sha1", value: SHA_C },
    },
    {
      id: "skill:catalog-only",
      kind: "skill",
      rootKind: "repo",
      source: SOURCE,
      sourceDigest: { algorithm: "git-sha1", value: SHA_B },
    },
    {
      id: "skill:undeclared",
      kind: "skill",
      rootKind: "machine",
      source: { provider: "github", repository: "other/skill" },
      sourceDigest: { algorithm: "git-sha1", value: SHA_C },
    },
    {
      id: "mcp:remote-tool",
      kind: "mcp",
      rootKind: "repo",
      source: { provider: "remote", repository: "example/tool" },
    },
  ];
}

describe("Package Graph physical discovery residue", () => {
  it("registers only exact immutable lock or receipt matches", () => {
    const result = classifyPackageGraphResidue(index(), discovered());

    expect(result.registered).toEqual([
      expect.objectContaining({
        id: "skill:receipt",
        authorityIds: ["receipt:install"],
      }),
      expect.objectContaining({
        id: "skill:registered",
        authorityIds: ["lock:approvals"],
      }),
    ]);
    expect(result.catalogOnly).toEqual([
      expect.objectContaining({
        id: "skill:catalog-only",
        authorityIds: ["catalog:baseline"],
      }),
    ]);
    expect(result.registered.map(({ id }) => id)).not.toContain("skill:catalog-only");
  });

  it("separates undeclared immutable facts, divergent pins, and incomplete observations", () => {
    const facts = discovered();
    facts.push({
      id: "skill:divergent",
      kind: "skill",
      rootKind: "repo",
      source: SOURCE,
      sourceDigest: { algorithm: "git-sha1", value: SHA_B },
    });
    const graph = buildPackageGraphIndex([
      ...indexDocuments(),
      document("lock", "divergent", [surface("skill:divergent", SHA_A)]),
    ]);

    const result = classifyPackageGraphResidue(graph, facts);

    expect(result.undeclared).toEqual([
      expect.objectContaining({
        id: "skill:undeclared",
        sourceDigest: expect.objectContaining({ value: SHA_C }),
      }),
    ]);
    expect(result.divergent).toEqual([
      expect.objectContaining({
        id: "skill:divergent",
        authorityIds: ["lock:divergent"],
      }),
    ]);
    expect(result.unsupported).toEqual([
      {
        id: "mcp:remote-tool",
        kind: "mcp",
        rootKind: "repo",
        reason: "missing-source-digest",
      },
    ]);
  });

  it("keeps mutable local, remote MCP, and identity-free observations unsupported without leaks", () => {
    const secret = "Bearer should-never-appear";
    const observations = [
      {
        id: "skill:local-tool",
        kind: "skill",
        rootKind: "machine",
        source: { provider: "local", repository: "workspace/tool" },
      },
      { id: "mcp:remote", kind: "mcp", rootKind: "repo" },
      {
        id: "mcp:quarantined",
        kind: "mcp",
        rootKind: "quarantine",
        sourceDigest: {
          algorithm: "sha256",
          value: "d".repeat(64),
        },
      },
    ];

    const result = classifyPackageGraphResidue(index(), observations);
    const rendered = JSON.stringify(result);

    expect(result.unsupported.map(({ id, reason }) => [id, reason])).toEqual([
      ["mcp:quarantined", "missing-source"],
      ["mcp:remote", "missing-source-and-digest"],
      ["skill:local-tool", "missing-source-digest"],
    ]);
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toMatch(/endpoint|header|env|absolute|Bearer/i);
  });

  it("classifies every mixed exact and divergent authority set as divergent without a winner", () => {
    const exactLockWithConflicts = buildPackageGraphIndex([
      document("lock", "exact", [surface("skill:mixed-governed", SHA_A)]),
      document("receipt", "different", [surface("skill:mixed-governed", SHA_B)]),
      document("catalog", "different", [surface("skill:mixed-governed", SHA_C)]),
    ]);
    const exactCatalogWithConflict = buildPackageGraphIndex([
      document("catalog", "exact", [surface("skill:mixed-catalog", SHA_A)]),
      document("catalog", "different", [surface("skill:mixed-catalog", SHA_B)]),
    ]);
    const governed = classifyPackageGraphResidue(exactLockWithConflicts, [
      {
        id: "skill:mixed-governed",
        kind: "skill",
        rootKind: "repo",
        source: SOURCE,
        sourceDigest: { algorithm: "git-sha1", value: SHA_A },
      },
    ]);
    const catalog = classifyPackageGraphResidue(exactCatalogWithConflict, [
      {
        id: "skill:mixed-catalog",
        kind: "skill",
        rootKind: "repo",
        source: SOURCE,
        sourceDigest: { algorithm: "git-sha1", value: SHA_A },
      },
    ]);

    expect(governed.registered).toEqual([]);
    expect(governed.catalogOnly).toEqual([]);
    expect(governed.divergent).toEqual([
      expect.objectContaining({
        id: "skill:mixed-governed",
        authorityIds: ["catalog:different", "lock:exact", "receipt:different"],
      }),
    ]);
    expect(catalog.registered).toEqual([]);
    expect(catalog.catalogOnly).toEqual([]);
    expect(catalog.divergent).toEqual([
      expect.objectContaining({
        id: "skill:mixed-catalog",
        authorityIds: ["catalog:different", "catalog:exact"],
      }),
    ]);
  });

  it("fails closed on duplicate, hostile, mismatched-kind, or free-form discovery facts", () => {
    const exact = discovered()[0];
    for (const candidate of [
      [exact, exact],
      [{ id: "skill:bad\u202ename", kind: "skill", rootKind: "repo" }],
      [{ id: "skill:wrong-kind", kind: "mcp", rootKind: "repo" }],
      [{ id: "mcp:tool", kind: "mcp", rootKind: "repo", detail: "secret endpoint" }],
    ]) {
      expect(() => classifyPackageGraphResidue(index(), candidate)).toThrow();
    }
  });

  it("emits byte-equivalent deterministic output for input permutations", () => {
    const forward = discovered();
    const reverse = [...forward].reverse();

    expect(JSON.stringify(classifyPackageGraphResidue(index(), forward))).toBe(
      JSON.stringify(classifyPackageGraphResidue(index(), reverse)),
    );
  });
});

function indexDocuments(): Record<string, unknown>[] {
  return [
    document("catalog", "baseline", [
      surface("skill:catalog-only", SHA_B),
      surface("skill:registered", SHA_A),
    ]),
    document("lock", "approvals", [surface("skill:registered", SHA_A)]),
    document("receipt", "install", [surface("skill:receipt", SHA_C)]),
  ];
}
