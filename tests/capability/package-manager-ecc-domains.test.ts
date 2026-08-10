import { describe, expect, it } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { vendorBaselineLockBytes } from "../../src/baseline-evidence/vendor.js";
import { projectBaselinePackageGraphAuthority } from "../../src/capability/package-graph/adapters/baseline.js";
import { projectEccCapabilityPackageAuthority } from "../../src/capability/package-graph/adapters/ecc-domains.js";
import { buildPackageGraphIndex } from "../../src/capability/package-graph/build.js";
import { resolveEccDomainAuthorityBindings } from "../../src/capability/package-manager/domains/ecc.js";
import { planCapabilityPackageLifecycle } from "../../src/capability/package-manager/lifecycle.js";
import { resolveCapabilityPackages } from "../../src/capability/package-manager/resolve.js";
import type { CapabilityPackageManifest } from "../../src/capability/package-manager/schema.js";

function fixture(withReceipt = true) {
  const baseline = projectBaselinePackageGraphAuthority({
    authorityId: "lock:baseline-evidence",
    catalog: baselineCatalogById("ecc"),
    lockBytes: vendorBaselineLockBytes(),
  });
  const catalog = projectEccCapabilityPackageAuthority({
    authorityId: "lock:ecc-capability-packages",
    baseline,
  });
  const member = catalog.graph.surfaces.find(({ id }) => id === "agent:code-reviewer");
  const pkg = catalog.graph.packages.find(({ id }) => id === "package:ecc-agent/code-reviewer");
  if (member === undefined || pkg === undefined) throw new Error("fixture missing agent package");
  const receipt = {
    authority: {
      id: "receipt:ecc-materialization",
      kind: "receipt" as const,
      sourceDigest: { algorithm: "sha256" as const, value: "b".repeat(64) },
    },
    graph: { schemaVersion: 1 as const, surfaces: [structuredClone(member)], packages: [] },
  };
  const index = buildPackageGraphIndex(withReceipt ? [catalog, receipt] : [catalog]);
  const authority = index.authorities.find(({ id }) => id === catalog.authority.id);
  const claim = index.claims.find(
    (candidate) => candidate.entityKind === "package" && candidate.id === pkg.id,
  );
  if (authority === undefined || claim?.entityKind !== "package")
    throw new Error("invalid fixture");
  const manifest: CapabilityPackageManifest = {
    schemaVersion: 1,
    authorities: [structuredClone(authority)],
    roots: [pkg.id],
    packages: [
      {
        kind: "package",
        id: pkg.id,
        authorityId: claim.authorityId,
        claimDigest: claim.claimDigest,
        sourceDigest: structuredClone(claim.entity.sourceDigest),
        dependencies: [],
        members: [...claim.entity.members],
      },
    ],
  };
  return { index, manifest, resolution: resolveCapabilityPackages({ manifest, index }) };
}

describe("ECC capability package authority binding", () => {
  it("requires the baseline lock claim and an exact existing domain receipt claim", () => {
    const { index, resolution } = fixture();
    const bindings = resolveEccDomainAuthorityBindings({ resolution, index });

    expect(bindings).toEqual([
      expect.objectContaining({
        id: "package:ecc-agent/code-reviewer",
        authorityId: "lock:ecc-capability-packages",
        members: [
          expect.objectContaining({
            id: "agent:code-reviewer",
            authorityRefs: [
              expect.objectContaining({ authorityId: "receipt:ecc-materialization" }),
            ],
          }),
        ],
      }),
    ]);
  });

  it("uses the shared lifecycle to produce exact ownership metadata", () => {
    const { index, manifest } = fixture();
    const result = planCapabilityPackageLifecycle({
      intentBytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
      index,
      diagnostics: [],
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready lifecycle");
    expect(result.changes.add).toEqual(["package:ecc-agent/code-reviewer"]);
    expect(result.desiredReceipt?.receipt.packages[0]?.members[0]).toMatchObject({
      id: "agent:code-reviewer",
      authorityRefs: [{ authorityId: "receipt:ecc-materialization" }],
    });
  });

  it("refuses an absent receipt, a divergent receipt claim, and hostile input", () => {
    const absent = fixture(false);
    expect(() =>
      resolveEccDomainAuthorityBindings({ resolution: absent.resolution, index: absent.index }),
    ).toThrow(/receipt/i);

    const valid = fixture();
    const changed = structuredClone(valid.index);
    const receiptClaim = changed.claims.find(
      (claim) => claim.entityKind === "surface" && claim.authorityId.startsWith("receipt:"),
    );
    if (receiptClaim?.entityKind !== "surface") throw new Error("fixture missing receipt claim");
    (receiptClaim.entity.sourceDigest as { value: string }).value = "c".repeat(64);
    expect(() =>
      resolveEccDomainAuthorityBindings({ resolution: valid.resolution, index: changed }),
    ).toThrow();

    let calls = 0;
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          calls += 1;
          return Object.prototype;
        },
      },
    );
    expect(() => resolveEccDomainAuthorityBindings(hostile)).toThrow(/input/i);
    expect(calls).toBe(0);
  });

  it("fails closed on malformed resolution and authority shapes", () => {
    const valid = fixture();
    expect(() => resolveEccDomainAuthorityBindings({ resolution: {}, index: valid.index })).toThrow(
      /resolution/i,
    );
    expect(() =>
      resolveEccDomainAuthorityBindings({ resolution: valid.resolution, index: {} }),
    ).toThrow(/index/i);

    const unsupported = structuredClone(valid.resolution);
    if (unsupported.packages[0] === undefined) throw new Error("fixture package missing");
    (unsupported.packages[0] as { id: string }).id = "package:skill-pack/not-ecc";
    expect(() =>
      resolveEccDomainAuthorityBindings({ resolution: unsupported, index: valid.index }),
    ).toThrow(/family/i);

    const noMember = structuredClone(valid.resolution);
    if (noMember.packages[0] === undefined) throw new Error("fixture package missing");
    (noMember.packages[0] as unknown as { directMembers: unknown[] }).directMembers = [];
    expect(() =>
      resolveEccDomainAuthorityBindings({ resolution: noMember, index: valid.index }),
    ).toThrow(/resolution/i);

    const wrongKind = structuredClone(valid.resolution);
    if (wrongKind.packages[0] === undefined) throw new Error("fixture package missing");
    (wrongKind.packages[0] as { id: string }).id = "package:ecc-mcp/code-reviewer";
    expect(() =>
      resolveEccDomainAuthorityBindings({ resolution: wrongKind, index: valid.index }),
    ).toThrow(/lock/i);
  });

  it("rejects non-data JSON container shapes before authority parsing", () => {
    const valid = fixture();
    const extra = { resolution: valid.resolution, index: valid.index, extra: true };
    expect(() => resolveEccDomainAuthorityBindings(extra)).toThrow(/input/i);

    const custom = Object.assign(Object.create({ inherited: true }), {
      resolution: valid.resolution,
      index: valid.index,
    });
    expect(() => resolveEccDomainAuthorityBindings(custom)).toThrow(/input/i);

    const hidden = { resolution: valid.resolution, index: valid.index };
    Object.defineProperty(hidden, "hidden", { value: true, enumerable: false });
    expect(() => resolveEccDomainAuthorityBindings(hidden)).toThrow(/input/i);

    const arrayExtra = structuredClone({ resolution: valid.resolution, index: valid.index });
    Object.defineProperty(arrayExtra.resolution.packages, "extra", {
      value: true,
      enumerable: true,
    });
    expect(() => resolveEccDomainAuthorityBindings(arrayExtra)).toThrow(/input/i);

    const hiddenIndex = structuredClone({ resolution: valid.resolution, index: valid.index });
    const first = hiddenIndex.resolution.packages[0];
    Object.defineProperty(hiddenIndex.resolution.packages, "0", {
      value: first,
      enumerable: false,
    });
    expect(() => resolveEccDomainAuthorityBindings(hiddenIndex)).toThrow(/input/i);
  });
});
