import { z } from "zod";
import {
  PackageGraphIndexAuthoritySchema,
  PackageGraphSourceDigestSchema,
  PackageIdSchema,
  SurfaceIdSchema,
} from "../package-graph/index.js";

const LOWER_SHA256 = /^[0-9a-f]{64}$/;
const MEMBER_ID_SEGMENT = "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?";
const SUPPORTED_MEMBER_ID = new RegExp(
  `^(?:skill|agent|rule|mcp):${MEMBER_ID_SEGMENT}(?:/${MEMBER_ID_SEGMENT})*$`,
);

export const CAPABILITY_PACKAGE_MANIFEST_LIMITS = Object.freeze({
  authorities: 256,
  roots: 128,
  packages: 512,
  dependencies: 128,
  members: 1_024,
  totalReferences: 16_384,
});

function uniqueBy(
  values: readonly string[],
  context: z.core.$RefinementCtx,
  message: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({ code: "custom", path: [index], message });
    }
    seen.add(value);
  }
}

const LowerSha256Schema = z
  .string({ error: "package digest must be a lowercase sha256" })
  .regex(LOWER_SHA256, { error: "package digest must be a lowercase sha256" });

const AuthoritySourceDigestSchema = z.strictObject(
  {
    algorithm: z.literal("sha256", { error: "authority digest algorithm is not supported" }),
    value: LowerSha256Schema,
  },
  { error: "unknown authority digest fields are not supported" },
);

const GitSha1SourceDigestSchema = z.strictObject(
  {
    algorithm: z.literal("git-sha1", {
      error: "package source digest algorithm is not supported",
    }),
    value: z
      .string({ error: "package source digest is malformed" })
      .regex(/^[0-9a-f]{40}$/, { error: "package source digest is malformed" }),
  },
  { error: "unknown package source digest fields are not supported" },
);

const Sha256SourceDigestSchema = z.strictObject(
  {
    algorithm: z.literal("sha256", {
      error: "package source digest algorithm is not supported",
    }),
    value: LowerSha256Schema,
  },
  { error: "unknown package source digest fields are not supported" },
);

const CapabilityPackageSourceDigestSchema = z
  .discriminatedUnion("algorithm", [GitSha1SourceDigestSchema, Sha256SourceDigestSchema], {
    error: "package source digest algorithm is not supported",
  })
  .pipe(PackageGraphSourceDigestSchema);

const SupportedMemberIdSchema = z
  .string({ error: "package member id is malformed or unsupported" })
  .min(3, { error: "package member id is malformed or unsupported" })
  .max(160, { error: "package member id is malformed or unsupported" })
  .regex(SUPPORTED_MEMBER_ID, { error: "package member id is malformed or unsupported" })
  .pipe(SurfaceIdSchema);

function authorityIdSchema(kind: "catalog" | "lock" | "receipt") {
  return z
    .string({ error: "package authority id is malformed" })
    .min(3, { error: "package authority id is malformed" })
    .max(160, { error: "package authority id is malformed" })
    .regex(new RegExp(`^${kind}:${MEMBER_ID_SEGMENT}(?:/${MEMBER_ID_SEGMENT})*$`), {
      error: "package authority id is malformed",
    })
    .pipe(SurfaceIdSchema);
}

const CapabilityPackageCatalogAuthoritySchema = z.strictObject(
  {
    id: authorityIdSchema("catalog"),
    kind: z.literal("catalog", { error: "package authority kind is not supported" }),
    sourceDigest: AuthoritySourceDigestSchema,
    projectionDigest: LowerSha256Schema,
  },
  { error: "unknown package authority fields are not supported" },
);

const CapabilityPackageLockAuthoritySchema = z.strictObject(
  {
    id: authorityIdSchema("lock"),
    kind: z.literal("lock", { error: "package authority kind is not supported" }),
    sourceDigest: AuthoritySourceDigestSchema,
    projectionDigest: LowerSha256Schema,
  },
  { error: "unknown package authority fields are not supported" },
);

const CapabilityPackageReceiptAuthoritySchema = z.strictObject(
  {
    id: authorityIdSchema("receipt"),
    kind: z.literal("receipt", { error: "package authority kind is not supported" }),
    sourceDigest: AuthoritySourceDigestSchema,
    projectionDigest: LowerSha256Schema,
  },
  { error: "unknown package authority fields are not supported" },
);

export const CapabilityPackageAuthoritySchema = z
  .discriminatedUnion(
    "kind",
    [
      CapabilityPackageCatalogAuthoritySchema,
      CapabilityPackageLockAuthoritySchema,
      CapabilityPackageReceiptAuthoritySchema,
    ],
    {
      error: "package authority kind is not supported",
    },
  )
  .pipe(PackageGraphIndexAuthoritySchema);

const DependencyListSchema = z
  .array(PackageIdSchema, { error: "package dependencies must be an explicit array" })
  .max(CAPABILITY_PACKAGE_MANIFEST_LIMITS.dependencies, {
    error: "package dependency count exceeds the manifest limit",
  })
  .superRefine((dependencies, context) =>
    uniqueBy(dependencies, context, "duplicate package dependency id"),
  );

const MemberListSchema = z
  .array(SupportedMemberIdSchema, { error: "package members must be an explicit array" })
  .min(1, { error: "package must declare at least one direct member" })
  .max(CAPABILITY_PACKAGE_MANIFEST_LIMITS.members, {
    error: "package member count exceeds the manifest limit",
  })
  .superRefine((members, context) => uniqueBy(members, context, "duplicate package member id"));

export const CapabilityPackageNodeSchema = z.strictObject(
  {
    kind: z.literal("package", { error: "capability package kind is not supported" }),
    id: PackageIdSchema,
    authorityId: SurfaceIdSchema,
    claimDigest: LowerSha256Schema,
    sourceDigest: CapabilityPackageSourceDigestSchema,
    dependencies: DependencyListSchema,
    members: MemberListSchema,
  },
  { error: "unknown capability package fields are not supported" },
);

const AuthorityListSchema = z
  .array(CapabilityPackageAuthoritySchema, {
    error: "package authorities must be an explicit array",
  })
  .min(1, { error: "package manifest must declare at least one authority" })
  .max(CAPABILITY_PACKAGE_MANIFEST_LIMITS.authorities, {
    error: "package authority count exceeds the manifest limit",
  })
  .superRefine((authorities, context) =>
    uniqueBy(
      authorities.map((authority) => authority.id),
      context,
      "duplicate package authority id",
    ),
  );

const RootListSchema = z
  .array(PackageIdSchema, { error: "package roots must be an explicit array" })
  .min(1, { error: "package manifest must declare at least one root" })
  .max(CAPABILITY_PACKAGE_MANIFEST_LIMITS.roots, {
    error: "package root count exceeds the manifest limit",
  })
  .superRefine((roots, context) => uniqueBy(roots, context, "duplicate package root id"));

const PackageListSchema = z
  .array(CapabilityPackageNodeSchema, {
    error: "packages must be an explicit array",
  })
  .min(1, { error: "package manifest must declare at least one package" })
  .max(CAPABILITY_PACKAGE_MANIFEST_LIMITS.packages, {
    error: "package count exceeds the manifest limit",
  })
  .superRefine((packages, context) =>
    uniqueBy(
      packages.map((pkg) => pkg.id),
      context,
      "duplicate package id",
    ),
  );

export const CapabilityPackageManifestSchema = z
  .strictObject(
    {
      schemaVersion: z.literal(1, {
        error: "capability package manifest schema version is not supported",
      }),
      authorities: AuthorityListSchema,
      roots: RootListSchema,
      packages: PackageListSchema,
    },
    { error: "unknown capability package manifest fields are not supported" },
  )
  .superRefine((manifest, context) => {
    const totalReferences = manifest.packages.reduce(
      (total, pkg) => total + pkg.dependencies.length + pkg.members.length,
      0,
    );
    if (totalReferences > CAPABILITY_PACKAGE_MANIFEST_LIMITS.totalReferences) {
      context.addIssue({
        code: "custom",
        path: ["packages"],
        message: "package manifest direct reference count exceeds the manifest limit",
      });
    }
  });

export type CapabilityPackageAuthority = z.infer<typeof CapabilityPackageAuthoritySchema>;
export type CapabilityPackageNode = z.infer<typeof CapabilityPackageNodeSchema>;
export type CapabilityPackageManifest = z.infer<typeof CapabilityPackageManifestSchema>;
