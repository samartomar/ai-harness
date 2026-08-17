import { describe, expect, it } from "vitest";
import {
  buildPackageGraphIndex,
  canonicalizeObjectKeys,
  canonicalJson,
  canonicalSha256,
  PackageGraphAuthorityDocumentSchema,
  PackageGraphIndexSchema,
  serializePackageGraphIndex,
} from "../../src/capability/package-graph/index.js";

const SHA1_A = "a".repeat(40);
const SHA1_C = "c".repeat(40);
const SHA256_B = "b".repeat(64);
const SHA256_D = "d".repeat(64);
const SHA256_E = "e".repeat(64);

function risk(
  name: string,
  version: string,
  evidenceSha256: string,
  subjectValue = SHA1_A,
): Record<string, unknown> {
  return {
    detector: { name, version },
    evidence: {
      sha256: evidenceSha256,
      subjectDigest: { algorithm: "git-sha1", value: subjectValue },
    },
    verdict: "warn",
    findings: [{ code: "trust.zeta", count: 2 }, { code: "trust.alpha" }],
  };
}

function graph(
  suffix: string,
  options: { reverse?: boolean; divergent?: boolean } = {},
): Record<string, unknown> {
  const surfaceId = `skill:security-${suffix}`;
  const sourceDigest = {
    algorithm: "git-sha1",
    value: options.divergent ? SHA1_C : SHA1_A,
  };
  const observedRisk = [
    risk("scanner-z", "2.0.0", SHA256_E, sourceDigest.value),
    risk("scanner-a", "1.0.0", SHA256_D, sourceDigest.value),
  ];
  const declaredRisk = [
    { axis: "supply-chain", value: "pinned" },
    { axis: "egress", value: options.divergent ? "third-party" : "none" },
  ];
  const surfaces = [
    {
      id: surfaceId,
      source: { repository: "acme/security-skills", provider: "github" },
      sourceDigest,
      declaredRisk: options.reverse ? [...declaredRisk].reverse() : declaredRisk,
      observedRisk: options.reverse ? [...observedRisk].reverse() : observedRisk,
    },
  ];
  const packages = [
    {
      members: [surfaceId],
      sourceDigest: { value: SHA256_B, algorithm: "sha256" },
      source: { repository: "acme/security-skills", provider: "github" },
      id: `package:baseline/${suffix}`,
      observedRisk: [],
      declaredRisk: [],
    },
  ];
  return {
    packages: options.reverse ? [...packages].reverse() : packages,
    schemaVersion: 1,
    surfaces: options.reverse ? [...surfaces].reverse() : surfaces,
  };
}

function document(
  kind: "catalog" | "lock" | "receipt",
  name: string,
  graphValue: Record<string, unknown>,
  sourceDigest = SHA256_B,
): Record<string, unknown> {
  return {
    graph: graphValue,
    authority: {
      id: `${kind}:${name}`,
      kind,
      sourceDigest: { algorithm: "sha256", value: sourceDigest },
    },
  };
}

interface MutableIndexFixture {
  schemaVersion: number;
  authorities: Array<{
    id: string;
    kind: string;
    sourceDigest: { algorithm: string; value: string };
    projectionDigest: string;
  }>;
  claims: Array<{
    entityKind: string;
    id: string;
    authorityId: string;
    claimDigest: string;
    entity: Record<string, unknown>;
  }>;
  conflicts: Array<Record<string, unknown>>;
}

function mutableIndexFixture(value: unknown): MutableIndexFixture {
  return structuredClone(value) as MutableIndexFixture;
}

function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("expected non-empty test fixture");
  return value;
}

describe("Package Graph v1 additive index", () => {
  it("strictly validates authority identity, kind, digest, and graph membership", () => {
    expect(
      PackageGraphAuthorityDocumentSchema.parse(document("catalog", "public", graph("ecc"))),
    ).toMatchObject({
      authority: {
        id: "catalog:public",
        kind: "catalog",
        sourceDigest: { algorithm: "sha256", value: SHA256_B },
      },
      graph: { schemaVersion: 1 },
    });

    for (const candidate of [
      document("catalog", "public", graph("ecc"), "B".repeat(64)),
      document("catalog", "public", graph("ecc"), "b".repeat(63)),
      { ...document("catalog", "public", graph("ecc")), extra: true },
      {
        ...document("catalog", "public", graph("ecc")),
        authority: {
          id: "receipt:public",
          kind: "catalog",
          sourceDigest: { algorithm: "sha256", value: SHA256_B },
        },
      },
      {
        ...document("catalog", "public", graph("ecc")),
        authority: {
          id: "catalog:../public",
          kind: "catalog",
          sourceDigest: { algorithm: "sha256", value: SHA256_B },
        },
      },
      {
        ...document("catalog", "public", graph("ecc")),
        authority: {
          id: "catalog:public",
          kind: "catalog",
          sourceDigest: { algorithm: "sha256", value: SHA256_B },
          extra: true,
        },
      },
    ]) {
      expect(PackageGraphAuthorityDocumentSchema.safeParse(candidate).success).toBe(false);
    }

    expect(() =>
      buildPackageGraphIndex([
        document("catalog", "public", {
          ...graph("ecc"),
          packages: [
            {
              ...((graph("ecc").packages as Record<string, unknown>[])[0] ?? {}),
              members: ["skill:not-declared"],
            },
          ],
        }),
      ]),
    ).toThrow();
  });

  it("rejects duplicate authority ids", () => {
    expect(() =>
      buildPackageGraphIndex([
        document("catalog", "public", graph("ecc")),
        document("catalog", "public", graph("other"), SHA256_D),
      ]),
    ).toThrow(/duplicate authority id/);
  });

  it("keeps asserted source digests separate from builder projection digests", () => {
    const sameGraph = buildPackageGraphIndex([
      document("catalog", "public", graph("ecc"), SHA256_B),
      document("lock", "workspace", graph("ecc"), SHA256_D),
    ]);
    const unchanged = buildPackageGraphIndex([
      document("catalog", "public", graph("ecc"), SHA256_B),
    ]);
    const changed = buildPackageGraphIndex([
      document("catalog", "public", graph("ecc", { divergent: true }), SHA256_B),
    ]);

    expect(sameGraph.authorities.map(({ sourceDigest }) => sourceDigest.value)).toEqual([
      SHA256_B,
      SHA256_D,
    ]);
    expect(sameGraph.authorities[0]?.projectionDigest).toBe(
      sameGraph.authorities[1]?.projectionDigest,
    );
    expect(unchanged.authorities[0]?.sourceDigest).toEqual(changed.authorities[0]?.sourceDigest);
    expect(unchanged.authorities[0]?.projectionDigest).not.toBe(
      changed.authorities[0]?.projectionDigest,
    );
    expect(() => serializePackageGraphIndex(sameGraph)).not.toThrow();
  });

  it("retains empty authorities in the canonical top-level list", () => {
    const index = buildPackageGraphIndex([
      document("receipt", "empty", { schemaVersion: 1, surfaces: [], packages: [] }, SHA256_D),
    ]);

    expect(index.authorities).toEqual([
      {
        id: "receipt:empty",
        kind: "receipt",
        sourceDigest: { algorithm: "sha256", value: SHA256_D },
        projectionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(index.claims).toEqual([]);
    expect(PackageGraphIndexSchema.parse(index)).toEqual(index);
  });

  it("deep-freezes output and isolates it from caller input mutation", () => {
    const input = document("catalog", "public", graph("ecc"), SHA256_B);
    const index = buildPackageGraphIndex([input]);
    const serialized = serializePackageGraphIndex(index);

    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(index.authorities)).toBe(true);
    expect(Object.isFrozen(index.authorities[0])).toBe(true);
    expect(Object.isFrozen(index.authorities[0]?.sourceDigest)).toBe(true);
    expect(Object.isFrozen(index.claims)).toBe(true);
    expect(Object.isFrozen(index.claims[0])).toBe(true);
    expect(Object.isFrozen(index.claims[0]?.entity)).toBe(true);
    expect(Reflect.set(index as object, "schemaVersion", 2)).toBe(false);
    expect(Reflect.set(index.authorities[0] as object, "projectionDigest", SHA256_E)).toBe(false);

    const inputAuthority = input.authority as {
      sourceDigest: { value: string };
    };
    inputAuthority.sourceDigest.value = SHA256_E;
    const inputGraph = input.graph as { surfaces: Array<Record<string, unknown>> };
    inputGraph.surfaces[0] = { id: "skill:caller-mutated" };

    expect(serializePackageGraphIndex(index)).toBe(serialized);
    expect(index.authorities[0]?.sourceDigest.value).toBe(SHA256_B);
    expect(index.claims.some(({ id }) => id === "skill:caller-mutated")).toBe(false);
  });

  it("retains and orders every authority claim, including identical claims", () => {
    const index = buildPackageGraphIndex([
      document("receipt", "install", graph("ecc"), SHA256_D),
      document("catalog", "public", graph("ecc"), SHA256_B),
    ]);

    expect(
      index.claims.map(({ entityKind, id, authorityId }) => [entityKind, id, authorityId]),
    ).toEqual([
      ["package", "package:baseline/ecc", "catalog:public"],
      ["package", "package:baseline/ecc", "receipt:install"],
      ["surface", "skill:security-ecc", "catalog:public"],
      ["surface", "skill:security-ecc", "receipt:install"],
    ]);
    expect(index.claims).toHaveLength(4);
    expect(index.claims[0]?.claimDigest).toBe(index.claims[1]?.claimDigest);
    expect(index.claims[2]?.claimDigest).toBe(index.claims[3]?.claimDigest);
    expect(index.conflicts).toEqual([]);
    expect(index.authorities.map(({ id }) => id)).toEqual(["catalog:public", "receipt:install"]);
    expect(index.claims.every((claim) => !("authority" in claim))).toBe(true);
  });

  it("reports only divergent canonical claims and never selects a winner", () => {
    const index = buildPackageGraphIndex([
      document("catalog", "public", graph("ecc"), SHA256_B),
      document("lock", "workspace", graph("ecc"), SHA256_D),
      document("receipt", "install", graph("ecc", { divergent: true }), SHA256_E),
    ]);

    expect(index.conflicts).toHaveLength(1);
    expect(index.conflicts[0]).toMatchObject({
      entityKind: "surface",
      id: "skill:security-ecc",
      claimDigests: [
        { authorityId: "catalog:public" },
        { authorityId: "lock:workspace" },
        { authorityId: "receipt:install" },
      ],
    });
    expect(new Set(index.conflicts[0]?.claimDigests.map(({ digest }) => digest)).size).toBe(2);
    expect(index.conflicts[0]).not.toHaveProperty("winner");
    expect(index.claims).toHaveLength(6);
  });

  it("normalizes graph arrays while preserving declared and observed risk separately", () => {
    const graphValue = graph("ecc", { reverse: true });
    const firstSurface = (graphValue.surfaces as Record<string, unknown>[])[0];
    const firstPackage = (graphValue.packages as Record<string, unknown>[])[0];
    if (firstSurface === undefined || firstPackage === undefined) {
      throw new Error("expected graph fixture entities");
    }
    graphValue.surfaces = [
      { ...firstSurface, id: "skill:security-zeta" },
      { ...firstSurface, id: "skill:security-alpha" },
    ];
    graphValue.packages = [
      {
        ...firstPackage,
        members: ["skill:security-zeta", "skill:security-alpha"],
      },
    ];
    const index = buildPackageGraphIndex([document("catalog", "public", graphValue)]);
    const surfaceClaim = index.claims.find((claim) => claim.entityKind === "surface");
    const packageClaim = index.claims.find((claim) => claim.entityKind === "package");

    expect(surfaceClaim?.entity.declaredRisk.map(({ axis }) => axis)).toEqual([
      "egress",
      "supply-chain",
    ]);
    expect(surfaceClaim?.entity.observedRisk.map(({ detector }) => detector.name)).toEqual([
      "scanner-a",
      "scanner-z",
    ]);
    expect(surfaceClaim?.entity.observedRisk[0]?.findings.map(({ code }) => code)).toEqual([
      "trust.alpha",
      "trust.zeta",
    ]);
    expect(packageClaim?.entity.members).toEqual(["skill:security-alpha", "skill:security-zeta"]);
    expect(surfaceClaim?.entity).toHaveProperty("declaredRisk");
    expect(surfaceClaim?.entity).toHaveProperty("observedRisk");
  });

  it("emits byte-identical output for shuffled inputs, arrays, and object insertion order", () => {
    const forward = buildPackageGraphIndex([
      document("catalog", "zeta", graph("zeta"), SHA256_E),
      document("lock", "alpha", graph("alpha"), SHA256_D),
    ]);
    const shuffled = buildPackageGraphIndex([
      document("lock", "alpha", graph("alpha", { reverse: true }), SHA256_D),
      document("catalog", "zeta", graph("zeta", { reverse: true }), SHA256_E),
    ]);

    expect(serializePackageGraphIndex(forward)).toBe(serializePackageGraphIndex(shuffled));
    expect(serializePackageGraphIndex(forward).endsWith("\n")).toBe(true);
    expect(serializePackageGraphIndex(forward).endsWith("\n\n")).toBe(false);
  });

  it("rejects forged or stale index integrity before serialization", () => {
    const valid = buildPackageGraphIndex([
      document("catalog", "public", graph("ecc"), SHA256_B),
      document("lock", "workspace", graph("ecc", { divergent: true }), SHA256_D),
    ]);
    const forgedEntityId = mutableIndexFixture(valid);
    first(forgedEntityId.claims).entity.id = "package:baseline/forged";
    const staleEntity = mutableIndexFixture(valid);
    const staleDeclaredRisk = staleEntity.claims.find(({ entityKind }) => entityKind === "surface")
      ?.entity.declaredRisk as Array<Record<string, unknown>>;
    first(staleDeclaredRisk).value = "tampered";
    const staleClaimDigest = mutableIndexFixture(valid);
    first(staleClaimDigest.claims).claimDigest = SHA256_E;
    const staleProjection = mutableIndexFixture(valid);
    first(staleProjection.authorities).projectionDigest = SHA256_E;
    const missingAuthorityRef = mutableIndexFixture(valid);
    first(missingAuthorityRef.claims).authorityId = "catalog:missing";
    const forgedConflict = mutableIndexFixture(valid);
    forgedConflict.conflicts = [];
    const deletedClaim = mutableIndexFixture(valid);
    deletedClaim.claims.splice(0, 1);
    const duplicateTuple = mutableIndexFixture(valid);
    duplicateTuple.claims.push(structuredClone(first(duplicateTuple.claims)));

    expect(PackageGraphIndexSchema.safeParse(valid).success).toBe(true);
    for (const candidate of [
      forgedEntityId,
      staleEntity,
      staleClaimDigest,
      staleProjection,
      missingAuthorityRef,
      forgedConflict,
      deletedClaim,
      duplicateTuple,
    ]) {
      expect(PackageGraphIndexSchema.safeParse(candidate).success).toBe(false);
      expect(() => serializePackageGraphIndex(candidate)).toThrow();
    }
  });

  it("canonicalizes recursive object keys and hashes canonical JSON", () => {
    const left = { z: 1, nested: { y: 2, x: [{ b: 2, a: 1 }] } };
    const right = { nested: { x: [{ a: 1, b: 2 }], y: 2 }, z: 1 };
    const nullPrototype: Record<string, unknown> = Object.create(null);
    nullPrototype.z = 1;
    nullPrototype.a = 2;

    expect(canonicalizeObjectKeys(left)).toEqual({
      nested: { x: [{ a: 1, b: 2 }], y: 2 },
      z: 1,
    });
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalSha256(left)).toBe(canonicalSha256(right));
    expect(canonicalSha256(left)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalSha256({ items: ["a", "b"] })).not.toBe(canonicalSha256({ items: ["b", "a"] }));
    expect(canonicalJson([null, true, false, 0, 1.5, "text"])).toBe(
      '[null,true,false,0,1.5,"text"]',
    );
    expect(canonicalJson(nullPrototype)).toBe('{"a":2,"z":1}');
    expect(canonicalJson({ "1": "integer-like", "\r": "control" })).toBe(
      '{"\\r":"control","1":"integer-like"}',
    );
  });

  it("ignores inherited object and array toJSON hooks for generic and index bytes", () => {
    const objectValue = { z: 2, a: [{ b: 2, a: 1 }] };
    const arrayValue = [{ b: 2, a: 1 }];
    const baselineObjectBytes = canonicalJson(objectValue);
    const baselineArrayBytes = canonicalJson(arrayValue);
    const baselineObjectHash = canonicalSha256(objectValue);
    const indexGraph = graph("prototype");
    const indexSurface = first(indexGraph.surfaces as Array<Record<string, unknown>>);
    indexSurface.observedRisk = [];
    const baselineIndex = buildPackageGraphIndex([
      document("catalog", "public", indexGraph, SHA256_B),
    ]);
    const baselineIndexBytes = serializePackageGraphIndex(baselineIndex);
    const baselineIndexHash = canonicalSha256(baselineIndex);
    const objectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const arrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    let objectCalls = 0;
    let arrayCalls = 0;
    let objectBytes = "";
    let arrayBytes = "";
    let objectHash = "";
    let indexBytes = "";
    let indexHash = "";

    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value() {
          objectCalls += 1;
          return "polluted-object";
        },
      });
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        value() {
          arrayCalls += 1;
          return "polluted-array";
        },
      });

      objectBytes = canonicalJson(objectValue);
      arrayBytes = canonicalJson(arrayValue);
      objectHash = canonicalSha256(objectValue);
      indexBytes = serializePackageGraphIndex(baselineIndex);
      indexHash = canonicalSha256(baselineIndex);
    } finally {
      if (objectToJSON === undefined) Reflect.deleteProperty(Object.prototype, "toJSON");
      else Object.defineProperty(Object.prototype, "toJSON", objectToJSON);
      if (arrayToJSON === undefined) Reflect.deleteProperty(Array.prototype, "toJSON");
      else Object.defineProperty(Array.prototype, "toJSON", arrayToJSON);
    }

    expect(objectCalls).toBe(0);
    expect(arrayCalls).toBe(0);
    expect(objectBytes).toBe(baselineObjectBytes);
    expect(arrayBytes).toBe(baselineArrayBytes);
    expect(objectHash).toBe(baselineObjectHash);
    expect(indexBytes).toBe(baselineIndexBytes);
    expect(indexHash).toBe(baselineIndexHash);
  });

  it.each([
    ["root undefined", undefined],
    ["nested undefined", { nested: [0, { value: undefined }] }],
    ["root function", () => "ignored"],
    ["nested function", { nested: [() => "ignored"] }],
    ["root symbol", Symbol("ignored")],
    ["nested symbol", { nested: [Symbol("ignored")] }],
    ["symbol key", { [Symbol("ignored")]: true }],
    ["root bigint", 1n],
    ["nested bigint", { nested: [1n] }],
    ["root NaN", Number.NaN],
    ["root negative zero", -0],
    ["nested Infinity", { nested: [Number.POSITIVE_INFINITY] }],
    ["nested negative Infinity", { nested: { value: Number.NEGATIVE_INFINITY } }],
    ["nested negative zero", { nested: [-0] }],
  ])("rejects non-JSON canonical input: %s", (_label, candidate) => {
    expect(() => canonicalizeObjectKeys(candidate)).toThrow(TypeError);
    expect(() => canonicalJson(candidate)).toThrow(TypeError);
    expect(() => canonicalSha256(candidate)).toThrow(TypeError);
  });

  it("rejects array holes at any depth", () => {
    const rootSparse: unknown[] = [];
    rootSparse.length = 2;
    rootSparse[1] = "present";
    const innerSparse: unknown[] = [];
    innerSparse.length = 1;
    const nestedSparse = ["present", innerSparse];

    for (const candidate of [rootSparse, { nested: nestedSparse }]) {
      expect(() => canonicalizeObjectKeys(candidate)).toThrow(/array holes/);
      expect(() => canonicalJson(candidate)).toThrow(/array holes/);
    }
  });

  it("rejects unsupported object and array prototypes", () => {
    class CustomRecord {
      value = 1;
    }
    const customArray = [1, 2];
    Object.setPrototypeOf(customArray, { map: Array.prototype.map });

    for (const candidate of [new Date(0), new Map(), new CustomRecord(), customArray]) {
      expect(() => canonicalizeObjectKeys(candidate)).toThrow(TypeError);
      expect(() => canonicalJson({ nested: candidate })).toThrow(TypeError);
    }
  });

  it("never executes an enumerable hostile toJSON function", () => {
    let calls = 0;
    const hostile = {
      value: "safe",
      toJSON() {
        calls += 1;
        throw new Error("hostile toJSON executed");
      },
    };

    expect(() => canonicalizeObjectKeys(hostile)).toThrow(TypeError);
    expect(calls).toBe(0);
    expect(() => canonicalJson({ nested: hostile })).toThrow(TypeError);
    expect(calls).toBe(0);
  });

  it("rejects enumerable accessors before invoking them", () => {
    let objectGetterCalls = 0;
    const objectWithAccessor = {};
    Object.defineProperty(objectWithAccessor, "value", {
      enumerable: true,
      get() {
        objectGetterCalls += 1;
        return "object";
      },
    });
    let arrayGetterCalls = 0;
    const arrayWithAccessor = ["initial"];
    Object.defineProperty(arrayWithAccessor, 0, {
      enumerable: true,
      get() {
        arrayGetterCalls += 1;
        return "array";
      },
    });

    expect(() => canonicalizeObjectKeys(objectWithAccessor)).toThrow(/accessor/);
    expect(objectGetterCalls).toBe(0);
    expect(() => canonicalJson({ nested: objectWithAccessor })).toThrow(/accessor/);
    expect(objectGetterCalls).toBe(0);
    expect(() => canonicalizeObjectKeys(arrayWithAccessor)).toThrow(/accessor/);
    expect(arrayGetterCalls).toBe(0);
    expect(() => canonicalJson({ nested: arrayWithAccessor })).toThrow(/accessor/);
    expect(arrayGetterCalls).toBe(0);
  });

  it("rejects arrays with extra enumerable string keys", () => {
    const decorated = ["value"];
    Object.defineProperty(decorated, "metadata", {
      enumerable: true,
      value: "not-json-array-data",
    });

    expect(() => canonicalizeObjectKeys(decorated)).toThrow(/extra enumerable/);
    expect(() => canonicalJson({ nested: decorated })).toThrow(/extra enumerable/);
    expect(() => canonicalSha256(decorated)).toThrow(/extra enumerable/);
  });
});
