import { describe, expect, it } from "vitest";
import { adaptSkillPackageGraph } from "../../src/capability/package-graph/adapters/skills.js";
import { buildPackageGraphIndex } from "../../src/capability/package-graph/build.js";
import {
  CapabilityPackageSkillPackError,
  resolveSkillPackAuthorityBindings,
} from "../../src/capability/package-manager/domains/skill-pack.js";
import {
  type CapabilityPackageResolution,
  resolveCapabilityPackages,
} from "../../src/capability/package-manager/resolve.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function bytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function fixture(
  overrides: { lock?: unknown; packs?: unknown; resolveCatalogOnly?: boolean } = {},
) {
  const adapted = adaptSkillPackageGraph({
    lockAuthorityId: "lock:aih-skills",
    catalogAuthorityId: "catalog:aih-packs",
    hostSource: { provider: "github", repository: "host/project" },
    lockBytes: bytes(
      overrides.lock ?? {
        schemaVersion: 1,
        skills: [
          {
            name: "clean",
            source: `owner/repo@${SHA_A}`,
            commit: SHA_A,
            verdict: "GREEN",
            scope: "repo",
            card: "ai-coding/skill-cards/clean.json",
            evidenceSha256: "e".repeat(64),
            approvedBy: "docs-platform",
            approvedAt: "2026-08-09T00:00:00.000Z",
          },
        ],
      },
    ),
    packsBytes: bytes(
      overrides.packs ?? {
        schemaVersion: 1,
        packs: [
          {
            name: "docs-quality",
            skills: [{ name: "clean", source: `owner/repo@${SHA_A}`, commit: SHA_A }],
          },
        ],
      },
    ),
  });
  const index = buildPackageGraphIndex(adapted.documents);
  const resolutionIndex = overrides.resolveCatalogOnly
    ? buildPackageGraphIndex(
        adapted.documents.filter(({ authority }) => authority.kind === "catalog"),
      )
    : index;
  const authority = resolutionIndex.authorities.find(({ kind }) => kind === "catalog");
  const claims = resolutionIndex.claims.flatMap((candidate) =>
    candidate.entityKind === "package" && candidate.authorityId === authority?.id
      ? [candidate]
      : [],
  );
  if (authority === undefined || claims.length === 0) {
    throw new Error("expected catalog package fixture");
  }
  const resolution = resolveCapabilityPackages({
    manifest: {
      schemaVersion: 1,
      authorities: [authority],
      roots: claims.map(({ id }) => id),
      packages: claims.map((claim) => ({
        kind: "package",
        id: claim.id,
        authorityId: claim.authorityId,
        claimDigest: claim.claimDigest,
        sourceDigest: claim.entity.sourceDigest,
        dependencies: [],
        members: claim.entity.members,
      })),
    },
    index: resolutionIndex,
  });
  return { adapted, index, resolution };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("expected skill-pack bridge refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityPackageSkillPackError);
    expect((error as CapabilityPackageSkillPackError).code).toBe(code);
  }
}

describe("Capability Package Manager skill-pack authority bridge", () => {
  it("binds an exact catalog pack only when every skill has exact lock corroboration", () => {
    const { adapted, index, resolution } = fixture();
    const bindings = resolveSkillPackAuthorityBindings({
      resolution,
      index,
      diagnostics: adapted.diagnostics,
    });

    expect(bindings).toEqual([
      expect.objectContaining({
        id: "package:skill-pack/docs-quality",
        authorityId: "catalog:aih-packs",
        members: [
          expect.objectContaining({
            id: "skill:clean",
            authorityRefs: [expect.objectContaining({ authorityId: "lock:aih-skills" })],
          }),
        ],
      }),
    ]);
    expect(Object.isFrozen(bindings)).toBe(true);
    expect(Object.isFrozen(bindings[0]?.members)).toBe(true);
  });

  it("rejects catalog-only and divergent member identities", () => {
    const catalogOnly = fixture({ lock: { schemaVersion: 1, skills: [] } });
    expectCode(
      () =>
        resolveSkillPackAuthorityBindings({
          resolution: catalogOnly.resolution,
          index: catalogOnly.index,
          diagnostics: catalogOnly.adapted.diagnostics,
        }),
      "missing-lock-claim",
    );

    const divergent = fixture({
      resolveCatalogOnly: true,
      packs: {
        schemaVersion: 1,
        packs: [
          {
            name: "docs-quality",
            skills: [{ name: "clean", source: `other/repo@${SHA_B}`, commit: SHA_B }],
          },
        ],
      },
    });
    const clean = fixture();
    expectCode(
      () =>
        resolveSkillPackAuthorityBindings({
          resolution: clean.resolution,
          index: divergent.index,
          diagnostics: divergent.adapted.diagnostics,
        }),
      "relevant-member-conflict",
    );
  });

  it("cannot bind an authority-fatal requiredChecks pack when diagnostics are omitted", () => {
    const clean = fixture();
    const unsupported = adaptSkillPackageGraph({
      lockAuthorityId: "lock:aih-skills",
      catalogAuthorityId: "catalog:aih-packs",
      hostSource: { provider: "github", repository: "host/project" },
      lockBytes: bytes({
        schemaVersion: 1,
        skills: [
          {
            name: "clean",
            source: `owner/repo@${SHA_A}`,
            commit: SHA_A,
            verdict: "GREEN",
            scope: "repo",
            card: "ai-coding/skill-cards/clean.json",
            evidenceSha256: "e".repeat(64),
            approvedBy: "docs-platform",
            approvedAt: "2026-08-09T00:00:00.000Z",
          },
        ],
      }),
      packsBytes: bytes({
        schemaVersion: 1,
        packs: [
          {
            name: "docs-quality",
            requiredChecks: ["no-exec"],
            skills: [{ name: "clean", source: `owner/repo@${SHA_A}`, commit: SHA_A }],
          },
        ],
      }),
    });
    const unsupportedIndex = buildPackageGraphIndex(unsupported.documents);
    expect(unsupported.documents.some(({ authority }) => authority.kind === "catalog")).toBe(false);
    expectCode(
      () =>
        resolveSkillPackAuthorityBindings({
          resolution: clean.resolution,
          index: unsupportedIndex,
          diagnostics: [],
        }),
      "package-authority-not-catalog",
    );
  });

  it("rejects non-skill-pack packages, non-skill members, and non-GitHub sources", () => {
    const value = fixture();
    const base = structuredClone(value.resolution);
    const unsupportedId = structuredClone(base) as unknown as CapabilityPackageResolution;
    const unsupportedPackage = unsupportedId.packages[0];
    if (unsupportedPackage === undefined) throw new Error("expected package fixture");
    unsupportedPackage.id = "package:baseline/repo";
    expectCode(
      () =>
        resolveSkillPackAuthorityBindings({
          resolution: unsupportedId,
          index: value.index,
          diagnostics: [],
        }),
      "unsupported-package-family",
    );

    const unsupportedMember = structuredClone(base) as unknown as CapabilityPackageResolution;
    const memberPackage = unsupportedMember.packages[0];
    const member = memberPackage?.directMembers[0];
    if (memberPackage === undefined || member === undefined) {
      throw new Error("expected member fixture");
    }
    memberPackage.directMembers[0] = {
      ...member,
      id: "agent:clean",
      entity: { ...member.entity, id: "agent:clean" },
    };
    expectCode(
      () =>
        resolveSkillPackAuthorityBindings({
          resolution: unsupportedMember,
          index: value.index,
          diagnostics: [],
        }),
      "unsupported-member-family",
    );

    const local = structuredClone(base) as unknown as CapabilityPackageResolution;
    const localPackage = local.packages[0];
    if (localPackage === undefined) throw new Error("expected package fixture");
    localPackage.source.provider = "local";
    expectCode(
      () =>
        resolveSkillPackAuthorityBindings({
          resolution: local,
          index: value.index,
          diagnostics: [],
        }),
      "unsupported-source",
    );
  });

  it("rejects structurally forged resolution values with a fixed error", () => {
    const value = fixture();
    expectCode(
      () =>
        resolveSkillPackAuthorityBindings({
          resolution: { schemaVersion: 1, packages: [null] } as never,
          index: value.index,
          diagnostics: [],
        }),
      "invalid-resolution",
    );
  });

  it("rejects accessor-backed index state and malformed diagnostics without reading them", () => {
    const value = fixture();
    let calls = 0;
    const index = structuredClone(value.index);
    Object.defineProperty(index, "claims", {
      enumerable: true,
      get() {
        calls += 1;
        return [];
      },
    });
    expectCode(
      () =>
        resolveSkillPackAuthorityBindings({
          resolution: value.resolution,
          index,
          diagnostics: [],
        }),
      "invalid-index",
    );
    expect(calls).toBe(0);

    expectCode(
      () =>
        resolveSkillPackAuthorityBindings({
          resolution: value.resolution,
          index: value.index,
          diagnostics: [
            {
              authorityKind: "catalog",
              code: "package-graph.required-checks-unsupported",
              message: "required checks unsupported",
              entityId: "package:skill-pack/docs-quality",
              extra: true,
            } as never,
          ],
        }),
      "invalid-diagnostics",
    );
  });

  it("does not re-enumerate the caller bridge object after guarded cloning", () => {
    const value = fixture();
    let calls = 0;
    const input = {
      resolution: value.resolution,
      index: value.index,
      diagnostics: value.adapted.diagnostics,
    };
    Object.defineProperty(input, "unrelated", {
      enumerable: true,
      get() {
        calls += 1;
        return "hostile";
      },
    });

    expect(resolveSkillPackAuthorityBindings(input).map(({ id }) => id)).toEqual([
      "package:skill-pack/docs-quality",
    ]);
    expect(calls).toBe(0);
  });

  it("sorts bindings and members with code-unit order", () => {
    const value = fixture({
      lock: {
        schemaVersion: 1,
        skills: [
          {
            name: "zeta",
            source: `owner/repo@${SHA_A}`,
            commit: SHA_A,
            verdict: "GREEN",
            scope: "repo",
            card: "ai-coding/skill-cards/zeta.json",
            evidenceSha256: "e".repeat(64),
            approvedBy: "docs-platform",
            approvedAt: "2026-08-09T00:00:00.000Z",
          },
          {
            name: "alpha",
            source: `owner/repo@${SHA_A}`,
            commit: SHA_A,
            verdict: "GREEN",
            scope: "repo",
            card: "ai-coding/skill-cards/alpha.json",
            evidenceSha256: "f".repeat(64),
            approvedBy: "docs-platform",
            approvedAt: "2026-08-09T00:00:00.000Z",
          },
        ],
      },
      packs: {
        schemaVersion: 1,
        packs: [
          {
            name: "zeta",
            skills: [{ name: "zeta", source: `owner/repo@${SHA_A}`, commit: SHA_A }],
          },
          {
            name: "alpha",
            skills: [{ name: "alpha", source: `owner/repo@${SHA_A}`, commit: SHA_A }],
          },
        ],
      },
    });
    const bindings = resolveSkillPackAuthorityBindings({
      resolution: value.resolution,
      index: value.index,
      diagnostics: [],
    });
    expect(bindings.map(({ id }) => id)).toEqual([
      "package:skill-pack/alpha",
      "package:skill-pack/zeta",
    ]);
  });
});
