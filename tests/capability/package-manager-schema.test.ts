import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CAPABILITY_PACKAGE_MANIFEST_LIMITS,
  CapabilityPackageManifestSchema,
} from "../../src/capability/package-manager/schema.js";

const SHA1 = "a".repeat(40);
const SHA256 = "b".repeat(64);

function authority(index = 0): Record<string, unknown> {
  return {
    id: `catalog:authority-${index}`,
    kind: "catalog",
    sourceDigest: { algorithm: "sha256", value: SHA256 },
    projectionDigest: "c".repeat(64),
  };
}

function packageNode(index = 0, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "package",
    id: `package:baseline/package-${index}`,
    authorityId: "catalog:authority-0",
    claimDigest: "d".repeat(64),
    sourceDigest: { algorithm: "git-sha1", value: SHA1 },
    dependencies: [],
    members: ["skill:security-review"],
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    authorities: [authority()],
    roots: ["package:baseline/package-0"],
    packages: [packageNode()],
    ...overrides,
  };
}

function uniquePackageIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `package:dependency/item-${index}`);
}

function uniqueMembers(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `skill:member-${index}`);
}

describe("Capability Package Manifest v1 schema", () => {
  it("parses a strict manifest with exact authority facts and supported direct members", () => {
    const parsed = CapabilityPackageManifestSchema.parse(
      manifest({
        packages: [
          packageNode(0, {
            members: [
              "skill:security-review",
              "agent:code-reviewer",
              "rule:secure-defaults",
              "mcp:context7",
            ],
          }),
        ],
      }),
    );

    expect(parsed).toEqual({
      schemaVersion: 1,
      authorities: [authority()],
      roots: ["package:baseline/package-0"],
      packages: [
        packageNode(0, {
          members: [
            "skill:security-review",
            "agent:code-reviewer",
            "rule:secure-defaults",
            "mcp:context7",
          ],
        }),
      ],
    });
    expect(parsed.packages[0]).not.toHaveProperty("source");
    expect(parsed.packages[0]).not.toHaveProperty("provider");
  });

  it("requires every explicit array and never supplies defaults", () => {
    for (const key of ["authorities", "roots", "packages"] as const) {
      const candidate = manifest();
      delete candidate[key];
      expect(CapabilityPackageManifestSchema.safeParse(candidate).success, key).toBe(false);
    }
    for (const key of ["dependencies", "members"] as const) {
      const node = packageNode();
      delete node[key];
      expect(
        CapabilityPackageManifestSchema.safeParse(manifest({ packages: [node] })).success,
        key,
      ).toBe(false);
    }
  });

  it("rejects empty required collections while allowing explicit empty dependencies", () => {
    for (const candidate of [
      manifest({ authorities: [] }),
      manifest({ roots: [] }),
      manifest({ packages: [] }),
      manifest({ packages: [packageNode(0, { members: [] })] }),
    ]) {
      expect(CapabilityPackageManifestSchema.safeParse(candidate).success).toBe(false);
    }
    expect(
      CapabilityPackageManifestSchema.safeParse(
        manifest({ packages: [packageNode(0, { dependencies: [] })] }),
      ).success,
    ).toBe(true);
  });

  it("rejects unknown fields at every object boundary", () => {
    const candidates = [
      { ...manifest(), unexpected: true },
      manifest({ authorities: [{ ...authority(), unexpected: true }] }),
      manifest({
        authorities: [
          {
            ...authority(),
            sourceDigest: { algorithm: "sha256", value: SHA256, unexpected: true },
          },
        ],
      }),
      manifest({ packages: [{ ...packageNode(), unexpected: true }] }),
      manifest({
        packages: [
          packageNode(0, {
            sourceDigest: { algorithm: "git-sha1", value: SHA1, unexpected: true },
          }),
        ],
      }),
    ];

    for (const candidate of candidates) {
      expect(CapabilityPackageManifestSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("rejects malformed versions, ids, authority namespaces, and digests", () => {
    const candidates = [
      manifest({ schemaVersion: 2 }),
      manifest({ roots: ["baseline/package-0"] }),
      manifest({ packages: [packageNode(0, { id: "skill:not-a-package" })] }),
      manifest({ packages: [packageNode(0, { authorityId: "../catalog" })] }),
      manifest({ authorities: [{ ...authority(), id: "receipt:authority-0" }] }),
      manifest({ authorities: [{ ...authority(), projectionDigest: "C".repeat(64) }] }),
      manifest({
        authorities: [
          { ...authority(), sourceDigest: { algorithm: "sha256", value: "b".repeat(63) } },
        ],
      }),
      manifest({ packages: [packageNode(0, { claimDigest: "D".repeat(64) })] }),
      manifest({
        packages: [
          packageNode(0, { sourceDigest: { algorithm: "git-sha1", value: "a".repeat(39) } }),
        ],
      }),
    ];

    for (const candidate of candidates) {
      expect(CapabilityPackageManifestSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("rejects unsupported package kinds and member namespaces", () => {
    for (const candidate of [
      packageNode(0, { kind: "surface" }),
      packageNode(0, { kind: "tool" }),
      packageNode(0, { members: ["hook:pre-commit"] }),
      packageNode(0, { members: ["package:baseline/other"] }),
      packageNode(0, { members: ["skill:../escape"] }),
      packageNode(0, { members: ["skill:security//review"] }),
      packageNode(0, { members: ["skill:security-"] }),
    ]) {
      expect(
        CapabilityPackageManifestSchema.safeParse(manifest({ packages: [candidate] })).success,
      ).toBe(false);
    }
  });

  it("exports the exact supported-member grammar to JSON Schema", () => {
    const jsonSchema = z.toJSONSchema(CapabilityPackageManifestSchema, { io: "input" });
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(jsonSchema);

    expect(validate(manifest())).toBe(true);
    for (const member of [
      "hook:pre-commit",
      "package:baseline/other",
      "skill:../escape",
      "skill:security//review",
      "skill:security-",
      `skill:${"a".repeat(155)}`,
    ]) {
      expect(
        validate(manifest({ packages: [packageNode(0, { members: [member] })] })),
        member,
      ).toBe(false);
    }
  });

  it("exports exact authority kind namespaces to JSON Schema", () => {
    const jsonSchema = z.toJSONSchema(CapabilityPackageManifestSchema, { io: "input" });
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(jsonSchema);

    for (const kind of ["catalog", "lock", "receipt"] as const) {
      const candidate = manifest({
        authorities: [{ ...authority(), id: `${kind}:authority-0`, kind }],
        packages: [packageNode(0, { authorityId: `${kind}:authority-0` })],
      });
      expect(CapabilityPackageManifestSchema.safeParse(candidate).success, `${kind} runtime`).toBe(
        true,
      );
      expect(validate(candidate), `${kind} JSON Schema`).toBe(true);
    }

    for (const [kind, id] of [
      ["catalog", "receipt:authority-0"],
      ["lock", "catalog:authority-0"],
      ["receipt", "lock:authority-0"],
    ] as const) {
      const candidate = manifest({
        authorities: [{ ...authority(), id, kind }],
        packages: [packageNode(0, { authorityId: id })],
      });
      expect(
        CapabilityPackageManifestSchema.safeParse(candidate).success,
        `${kind} runtime mismatch`,
      ).toBe(false);
      expect(validate(candidate), `${kind} JSON Schema mismatch`).toBe(false);
    }
  });

  it("rejects duplicate authority, root, package, dependency, and member identities", () => {
    const duplicateCandidates = [
      manifest({ authorities: [authority(), authority()] }),
      manifest({ roots: ["package:baseline/package-0", "package:baseline/package-0"] }),
      manifest({ packages: [packageNode(), packageNode()] }),
      manifest({
        packages: [
          packageNode(0, {
            dependencies: ["package:baseline/other", "package:baseline/other"],
          }),
        ],
      }),
      manifest({ packages: [packageNode(0, { members: ["skill:a", "skill:a"] })] }),
    ];

    for (const candidate of duplicateCandidates) {
      expect(CapabilityPackageManifestSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("enforces every per-array bound", () => {
    const limits = CAPABILITY_PACKAGE_MANIFEST_LIMITS;
    const cases: Array<[string, unknown, unknown]> = [
      [
        "authorities",
        manifest({
          authorities: Array.from({ length: limits.authorities }, (_, index) => authority(index)),
        }),
        manifest({
          authorities: Array.from({ length: limits.authorities + 1 }, (_, index) =>
            authority(index),
          ),
        }),
      ],
      [
        "roots",
        manifest({ roots: uniquePackageIds(limits.roots) }),
        manifest({ roots: uniquePackageIds(limits.roots + 1) }),
      ],
      [
        "packages",
        manifest({
          packages: Array.from({ length: limits.packages }, (_, index) => packageNode(index)),
        }),
        manifest({
          packages: Array.from({ length: limits.packages + 1 }, (_, index) => packageNode(index)),
        }),
      ],
      [
        "dependencies",
        manifest({
          packages: [packageNode(0, { dependencies: uniquePackageIds(limits.dependencies) })],
        }),
        manifest({
          packages: [packageNode(0, { dependencies: uniquePackageIds(limits.dependencies + 1) })],
        }),
      ],
      [
        "members",
        manifest({ packages: [packageNode(0, { members: uniqueMembers(limits.members) })] }),
        manifest({ packages: [packageNode(0, { members: uniqueMembers(limits.members + 1) })] }),
      ],
    ];

    for (const [label, atLimit, overLimit] of cases) {
      expect(CapabilityPackageManifestSchema.safeParse(atLimit).success, `${label} at limit`).toBe(
        true,
      );
      expect(
        CapabilityPackageManifestSchema.safeParse(overLimit).success,
        `${label} over limit`,
      ).toBe(false);
    }
  });

  it("enforces the total direct-reference bound without violating a per-node bound", () => {
    const limits = CAPABILITY_PACKAGE_MANIFEST_LIMITS;
    const packageCount = 128;
    const dependenciesPerPackage = 127;
    const packages = Array.from({ length: packageCount }, (_, index) =>
      packageNode(index, {
        dependencies: uniquePackageIds(dependenciesPerPackage).map((id) => `${id}-from-${index}`),
        members: [`skill:member-${index}`],
      }),
    );
    expect(packageCount * (dependenciesPerPackage + 1)).toBe(limits.totalReferences);
    expect(CapabilityPackageManifestSchema.safeParse(manifest({ packages })).success).toBe(true);

    const overLimit = structuredClone(packages);
    const firstPackage = overLimit[0];
    if (firstPackage === undefined) throw new Error("expected package fixture");
    (firstPackage.dependencies as string[]).push("package:dependency/one-more");
    expect(
      CapabilityPackageManifestSchema.safeParse(manifest({ packages: overLimit })).success,
    ).toBe(false);
  });

  it("uses fixed control-safe validation messages without echoing hostile values", () => {
    const hostile = "hook:bad\u001b[2J\u202e";
    const result = CapabilityPackageManifestSchema.safeParse({
      ...manifest({ packages: [packageNode(0, { members: [hostile] })] }),
      [hostile]: true,
      authorities: [
        {
          ...authority(),
          [hostile]: true,
          sourceDigest: { algorithm: "sha256", value: SHA256, [hostile]: true },
        },
      ],
      packages: [
        {
          ...packageNode(0, { members: [hostile] }),
          [hostile]: true,
          sourceDigest: { algorithm: "git-sha1", value: SHA1, [hostile]: true },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected hostile member rejection");
    for (const issue of result.error.issues) {
      expect(issue.message).not.toContain(hostile);
      expect(issue.message).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    }
  });
});
