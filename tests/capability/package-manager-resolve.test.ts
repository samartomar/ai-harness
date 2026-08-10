import { describe, expect, it } from "vitest";
import {
  buildPackageGraphIndex,
  type PackageGraphAuthorityDocument,
  type PackageGraphIndex,
} from "../../src/capability/package-graph/build.js";
import type { PackageGraphSourceDigest } from "../../src/capability/package-graph/schema.js";
import {
  CapabilityPackageResolutionError,
  resolveCapabilityPackages,
} from "../../src/capability/package-manager/resolve.js";

const SHA1_A = "a".repeat(40);
const SHA1_B = "b".repeat(40);
const SHA256_A = "a".repeat(64);
const SHA256_B = "b".repeat(64);
const SHA256_C = "c".repeat(64);

function surface(id: string, digest = SHA1_A) {
  return {
    id,
    source: { provider: "github", repository: "owner/repo" },
    sourceDigest: { algorithm: "git-sha1" as const, value: digest },
    declaredRisk: [],
    observedRisk: [],
  };
}

function pkg(id: string, members: string[], digest = SHA1_A) {
  return {
    id,
    source: { provider: "github", repository: "owner/repo" },
    sourceDigest: { algorithm: "git-sha1" as const, value: digest },
    members,
    declaredRisk: [],
    observedRisk: [],
  };
}

function document(
  authorityId: string,
  packages: ReturnType<typeof pkg>[],
  surfaces: ReturnType<typeof surface>[],
  sourceDigest = SHA256_A,
): PackageGraphAuthorityDocument {
  return {
    authority: {
      id: authorityId,
      kind: "catalog",
      sourceDigest: { algorithm: "sha256", value: sourceDigest },
    },
    graph: { schemaVersion: 1, surfaces, packages },
  };
}

interface NodeSpec {
  id: string;
  authorityId?: string;
  dependencies?: string[];
}

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[Key] extends object
      ? Mutable<T[Key]>
      : T[Key];
};

function mutableClone<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing fixture value");
  return value;
}

function manifest(index: PackageGraphIndex, roots: string[], specs: NodeSpec[]) {
  const authorityIds = new Set(specs.map((spec) => spec.authorityId ?? "catalog:main"));
  return {
    schemaVersion: 1 as const,
    authorities: index.authorities
      .filter((authority) => authorityIds.has(authority.id))
      .map((authority) => mutableClone(authority)),
    roots,
    packages: specs.map((spec) => {
      const authorityId = spec.authorityId ?? "catalog:main";
      const claim = index.claims.find(
        (candidate) =>
          candidate.entityKind === "package" &&
          candidate.id === spec.id &&
          candidate.authorityId === authorityId,
      );
      if (claim?.entityKind !== "package") throw new Error("missing fixture package claim");
      return {
        kind: "package" as const,
        id: spec.id,
        authorityId,
        claimDigest: claim.claimDigest,
        sourceDigest: mutableClone(claim.entity.sourceDigest),
        dependencies: spec.dependencies ?? [],
        members: [...claim.entity.members],
      };
    }),
  };
}

function baseIndex(): PackageGraphIndex {
  return buildPackageGraphIndex([
    document("catalog:main", [pkg("package:demo/root", ["skill:root"])], [surface("skill:root")]),
  ]);
}

function baseInput() {
  const index = baseIndex();
  return {
    manifest: manifest(index, ["package:demo/root"], [{ id: "package:demo/root" }]),
    index,
  };
}

function diamondInput() {
  const ids = ["leaf", "left", "right", "root"];
  const surfaces = ids.map((id) => surface(`skill:${id}`));
  const index = buildPackageGraphIndex([
    document(
      "catalog:main",
      ids.map((id) => pkg(`package:demo/${id}`, [`skill:${id}`])),
      surfaces,
    ),
  ]);
  return {
    manifest: manifest(
      index,
      ["package:demo/root"],
      [
        { id: "package:demo/root", dependencies: ["package:demo/right", "package:demo/left"] },
        { id: "package:demo/right", dependencies: ["package:demo/leaf"] },
        { id: "package:demo/left", dependencies: ["package:demo/leaf"] },
        { id: "package:demo/leaf" },
      ],
    ),
    index,
  };
}

function expectCode(input: unknown, code: string): void {
  try {
    resolveCapabilityPackages(input);
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityPackageResolutionError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected resolver refusal ${code}`);
}

describe("Capability Package Manager pure resolver", () => {
  it("resolves one package and a diamond closure in stable dependency-first order", () => {
    const single = resolveCapabilityPackages(baseInput());
    expect(single).toMatchObject({
      schemaVersion: 1,
      roots: ["package:demo/root"],
      installOrder: ["package:demo/root"],
    });
    expect(single.packages[0]).toMatchObject({
      id: "package:demo/root",
      source: { provider: "github", repository: "owner/repo" },
      directMembers: [
        {
          entityKind: "surface",
          id: "skill:root",
          authorityId: "catalog:main",
        },
      ],
    });

    const diamond = resolveCapabilityPackages(diamondInput());
    expect(diamond.installOrder).toEqual([
      "package:demo/leaf",
      "package:demo/left",
      "package:demo/right",
      "package:demo/root",
    ]);
    expect(diamond.packages.map(({ id }) => id)).toEqual([
      "package:demo/leaf",
      "package:demo/left",
      "package:demo/right",
      "package:demo/root",
    ]);
  });

  it("emits byte-equivalent output for shuffled manifest and authority-document inputs", () => {
    const forward = diamondInput();
    const documents = [
      document(
        "catalog:main",
        [
          pkg("package:demo/root", ["skill:root"]),
          pkg("package:demo/right", ["skill:right"]),
          pkg("package:demo/left", ["skill:left"]),
          pkg("package:demo/leaf", ["skill:leaf"]),
        ],
        [
          surface("skill:root"),
          surface("skill:right"),
          surface("skill:left"),
          surface("skill:leaf"),
        ],
      ),
    ];
    const onlyDocument = required(documents[0]);
    const shuffledIndex = buildPackageGraphIndex([
      {
        ...onlyDocument,
        graph: {
          ...onlyDocument.graph,
          surfaces: [...onlyDocument.graph.surfaces].reverse(),
          packages: [...onlyDocument.graph.packages].reverse(),
        },
      },
    ]);
    const shuffledManifest = {
      ...forward.manifest,
      packages: [...forward.manifest.packages].reverse().map((node) => ({
        ...node,
        dependencies: [...node.dependencies].reverse(),
        members: [...node.members].reverse(),
      })),
    };
    expect(JSON.stringify(resolveCapabilityPackages(forward))).toBe(
      JSON.stringify(
        resolveCapabilityPackages({ manifest: shuffledManifest, index: shuffledIndex }),
      ),
    );
  });

  it.each([
    [
      "authority-source-mismatch",
      (input: ReturnType<typeof baseInput>) =>
        (required(input.manifest.authorities[0]).sourceDigest.value = SHA256_B),
    ],
    [
      "authority-projection-mismatch",
      (input: ReturnType<typeof baseInput>) =>
        (required(input.manifest.authorities[0]).projectionDigest = SHA256_B),
    ],
    [
      "missing-authority",
      (input: ReturnType<typeof baseInput>) =>
        (required(input.manifest.authorities[0]).id = "catalog:missing"),
    ],
    [
      "missing-package",
      (input: ReturnType<typeof baseInput>) => {
        required(input.manifest.packages[0]).id = "package:demo/missing";
        input.manifest.roots[0] = "package:demo/missing";
      },
    ],
    [
      "missing-root",
      (input: ReturnType<typeof baseInput>) => (input.manifest.roots[0] = "package:demo/missing"),
    ],
    [
      "missing-dependency",
      (input: ReturnType<typeof baseInput>) =>
        required(input.manifest.packages[0]).dependencies.push("package:demo/missing"),
    ],
    [
      "claim-pin-mismatch",
      (input: ReturnType<typeof baseInput>) =>
        (required(input.manifest.packages[0]).claimDigest = SHA256_B),
    ],
    [
      "source-pin-mismatch",
      (input: ReturnType<typeof baseInput>) =>
        ((
          required(input.manifest.packages[0]).sourceDigest as Mutable<PackageGraphSourceDigest>
        ).value = SHA1_B),
    ],
    [
      "member-pin-mismatch",
      (input: ReturnType<typeof baseInput>) =>
        (required(input.manifest.packages[0]).members = ["skill:missing"]),
    ],
  ])("refuses %s without partial output", (code, mutate) => {
    const input = structuredClone(baseInput());
    mutate(input);
    expectCode(input, code);
  });

  it("refuses a missing same-authority member claim", () => {
    const index = buildPackageGraphIndex([
      document("catalog:main", [pkg("package:demo/root", ["skill:root"])], [surface("skill:root")]),
    ]);
    const input = {
      manifest: manifest(index, ["package:demo/root"], [{ id: "package:demo/root" }]),
      index: mutableClone(index),
    };
    input.index.claims = input.index.claims.filter((claim) => claim.entityKind !== "surface");
    expectCode(input, "invalid-index");
  });

  it("refuses relevant package and surface conflicts but ignores unrelated conflicts", () => {
    const conflicting = buildPackageGraphIndex([
      document("catalog:main", [pkg("package:demo/root", ["skill:root"])], [surface("skill:root")]),
      document(
        "catalog:other",
        [pkg("package:demo/root", ["skill:root"], SHA1_B)],
        [surface("skill:root", SHA1_B)],
        SHA256_B,
      ),
    ]);
    const packageInput = {
      manifest: manifest(conflicting, ["package:demo/root"], [{ id: "package:demo/root" }]),
      index: conflicting,
    };
    expectCode(packageInput, "relevant-package-conflict");

    const surfaceConflict = buildPackageGraphIndex([
      document("catalog:main", [pkg("package:demo/root", ["skill:root"])], [surface("skill:root")]),
      document(
        "catalog:other",
        [pkg("package:demo/other", ["skill:root"], SHA1_B)],
        [surface("skill:root", SHA1_B)],
        SHA256_B,
      ),
    ]);
    expectCode(
      {
        manifest: manifest(surfaceConflict, ["package:demo/root"], [{ id: "package:demo/root" }]),
        index: surfaceConflict,
      },
      "relevant-member-conflict",
    );

    const unrelated = buildPackageGraphIndex([
      document("catalog:main", [pkg("package:demo/root", ["skill:root"])], [surface("skill:root")]),
      document(
        "catalog:other",
        [pkg("package:demo/other", ["skill:other"], SHA1_B)],
        [surface("skill:other", SHA1_B)],
        SHA256_B,
      ),
      document(
        "catalog:third",
        [pkg("package:demo/other", ["skill:other"], SHA1_A)],
        [surface("skill:other", SHA1_A)],
        SHA256_C,
      ),
    ]);
    expect(
      resolveCapabilityPackages({
        manifest: manifest(unrelated, ["package:demo/root"], [{ id: "package:demo/root" }]),
        index: unrelated,
      }).installOrder,
    ).toEqual(["package:demo/root"]);
  });

  it("refuses orphan packages and authorities", () => {
    const input = diamondInput();
    required(input.manifest.packages[0]).dependencies = [];
    expectCode(input, "orphan-package");

    const orphanIndex = buildPackageGraphIndex([
      document("catalog:main", [pkg("package:demo/root", ["skill:root"])], [surface("skill:root")]),
      document(
        "catalog:extra",
        [pkg("package:demo/extra", ["skill:extra"])],
        [surface("skill:extra")],
        SHA256_B,
      ),
    ]);
    const orphanAuthority = {
      manifest: manifest(orphanIndex, ["package:demo/root"], [{ id: "package:demo/root" }]),
      index: orphanIndex,
    };
    orphanAuthority.manifest.authorities.push(
      mutableClone(
        required(orphanIndex.authorities.find((authority) => authority.id === "catalog:extra")),
      ),
    );
    expectCode(orphanAuthority, "orphan-authority");
  });

  it("uses a global code-unit tie break for dependency-first install order", () => {
    const ids = ["b", "c", "z"];
    const index = buildPackageGraphIndex([
      document(
        "catalog:main",
        ids.map((id) => pkg(`package:demo/${id}`, [`skill:${id}`])),
        ids.map((id) => surface(`skill:${id}`)),
      ),
    ]);
    const input = {
      manifest: manifest(
        index,
        ["package:demo/b", "package:demo/c"],
        [
          { id: "package:demo/b", dependencies: ["package:demo/z"] },
          { id: "package:demo/c" },
          { id: "package:demo/z" },
        ],
      ),
      index,
    };
    expect(resolveCapabilityPackages(input).installOrder).toEqual([
      "package:demo/c",
      "package:demo/z",
      "package:demo/b",
    ]);
  });

  it("refuses self and multi-package dependency cycles", () => {
    const self = baseInput();
    required(self.manifest.packages[0]).dependencies = ["package:demo/root"];
    expectCode(self, "dependency-cycle");
    const multi = diamondInput();
    const leaf = required(multi.manifest.packages.find(({ id }) => id === "package:demo/leaf"));
    leaf.dependencies = ["package:demo/root"];
    expectCode(multi, "dependency-cycle");
  });

  it("deep-freezes copied output and isolates it from caller mutation", () => {
    const input = baseInput();
    const output = resolveCapabilityPackages(input);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.packages)).toBe(true);
    expect(Object.isFrozen(output.packages[0]?.directMembers[0]?.entity)).toBe(true);
    input.manifest.roots[0] = "package:demo/mutated";
    expect(output.roots).toEqual(["package:demo/root"]);
    expect(Reflect.set(output.packages[0] as object, "id", "package:demo/mutated")).toBe(false);
  });

  it("never invokes accessors or inherited and own toJSON hooks", () => {
    const input = baseInput();
    let calls = 0;
    Object.defineProperty(input, "manifest", {
      enumerable: true,
      get: () => {
        calls += 1;
        return baseInput().manifest;
      },
    });
    expectCode(input, "invalid-input");
    expect(calls).toBe(0);

    const inherited = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value: () => {
        calls += 1;
        return {};
      },
    });
    try {
      expect(resolveCapabilityPackages(baseInput()).roots).toEqual(["package:demo/root"]);
    } finally {
      if (inherited === undefined) Reflect.deleteProperty(Object.prototype, "toJSON");
      else Object.defineProperty(Object.prototype, "toJSON", inherited);
    }
    const own = baseInput();
    Object.defineProperty(own.manifest, "toJSON", {
      enumerable: true,
      value: () => {
        calls += 1;
        return {};
      },
    });
    expectCode(own, "invalid-input");
    expect(calls).toBe(0);
  });

  it.each([
    [
      "cyclic",
      () => {
        const input = baseInput() as Record<string, unknown>;
        input.self = input;
        return input;
      },
    ],
    ["custom prototype", () => Object.assign(Object.create({ inherited: true }), baseInput())],
    ["symbol key", () => Object.assign(baseInput(), { [Symbol("hidden")]: true })],
    [
      "sparse array",
      () => {
        const input = baseInput();
        input.manifest.roots = new Array(2) as string[];
        input.manifest.roots[1] = "package:demo/root";
        return input;
      },
    ],
    [
      "decorated array",
      () => {
        const input = baseInput();
        Object.assign(input.manifest.roots, { extra: true });
        return input;
      },
    ],
    ["undefined", () => ({ ...baseInput(), extra: undefined })],
    ["function", () => ({ ...baseInput(), extra: () => undefined })],
    ["symbol", () => ({ ...baseInput(), extra: Symbol("x") })],
    ["bigint", () => ({ ...baseInput(), extra: 1n })],
    ["nonfinite", () => ({ ...baseInput(), extra: Number.POSITIVE_INFINITY })],
    ["negative zero", () => ({ ...baseInput(), extra: -0 })],
  ])("rejects hostile/non-JSON boundary input: %s", (_label, candidate) => {
    expectCode(candidate(), "invalid-input");
  });

  it("refuses depth and total-node boundary excess", () => {
    const deep = baseInput() as Record<string, unknown>;
    let cursor = deep;
    for (let index = 0; index < 65; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.extra = next;
      cursor = next;
    }
    expectCode(deep, "input-limit");
    expectCode(
      { manifest: baseInput().manifest, index: new Array(100_001).fill(null) },
      "input-limit",
    );
  });
});
