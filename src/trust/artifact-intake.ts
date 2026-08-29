import { z } from "zod";
import {
  assertSafeRelativePosixPathV1,
  canonicalStrictJsonSha256V1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import { ExactSemverV2Schema } from "../org-policy/governance-decision-v2.js";

const ITEM_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;

const itemId = z.string().regex(ITEM_ID);
const accountableOwner = z.string().email().max(320);
const discoveryUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}, "discovery URL must use HTTPS without credentials");
const safePath = z
  .string()
  .max(1024)
  .superRefine((value, context) => {
    try {
      assertSafeRelativePosixPathV1(value, "artifact source path");
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "artifact source path is invalid",
      });
    }
  });
const sha512Sri = z.string().refine((value) => {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (match?.[1] === undefined) return false;
  const decoded = Buffer.from(match[1], "base64");
  return decoded.length === 64 && decoded.toString("base64") === match[1];
}, "integrity must be a canonical SHA-512 SRI digest");

const npmRegistry = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname === "/" &&
      (value === url.origin || value === `${url.origin}/`)
    );
  } catch {
    return false;
  }
}, "npm registry must be a canonical HTTPS origin");

export const ArtifactIntakeNpmSourceV1Schema = z
  .object({
    type: z.literal("npm"),
    registry: npmRegistry,
    package: z.string().regex(PACKAGE_NAME),
    version: ExactSemverV2Schema,
    integrity: sha512Sri.optional(),
    path: safePath.optional(),
  })
  .strict();

export const ArtifactIntakeGithubSourceV1Schema = z
  .object({
    type: z.literal("github"),
    repository: z.string().regex(REPOSITORY),
    commit: z.string().regex(GIT_COMMIT),
    path: safePath,
  })
  .strict();

export const ArtifactIntakeSourceV1Schema = z.discriminatedUnion("type", [
  ArtifactIntakeNpmSourceV1Schema,
  ArtifactIntakeGithubSourceV1Schema,
]);

const commonItem = {
  id: itemId,
  discoveryUrl: discoveryUrl.optional(),
  accountableOwner: accountableOwner.optional(),
  source: ArtifactIntakeSourceV1Schema,
  clarification: z.string().min(1).max(1000).optional(),
};

export const ArtifactIntakeItemV1Schema = z.discriminatedUnion("kind", [
  z.object({ ...commonItem, kind: z.literal("mcp") }).strict(),
  z.object({ ...commonItem, kind: z.literal("skill") }).strict(),
  z.object({ ...commonItem, kind: z.literal("agent") }).strict(),
]);

export const ArtifactIntakeV1Schema = z
  .object({
    format: z.literal("aih-artifact-intake"),
    version: z.literal(1),
    authority: z.object({ state: z.literal("not-authority") }).strict(),
    defaults: z
      .object({
        accountableOwner: accountableOwner.optional(),
      })
      .strict()
      .optional(),
    items: z.array(ArtifactIntakeItemV1Schema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, item] of value.items.entries()) {
      if (ids.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: `duplicate artifact intake item id: ${item.id}`,
        });
      }
      ids.add(item.id);
      if (item.accountableOwner === undefined && value.defaults?.accountableOwner === undefined) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "accountableOwner"],
          message: "accountable owner is required on the item or in defaults",
        });
      }
    }
  });

export type ArtifactIntakeV1 = z.infer<typeof ArtifactIntakeV1Schema>;
export type ArtifactIntakeItemV1 = z.infer<typeof ArtifactIntakeItemV1Schema>;
export type ArtifactIntakeSourceV1 = z.infer<typeof ArtifactIntakeSourceV1Schema>;

export type EffectiveArtifactIntakeItemV1 = ArtifactIntakeItemV1 & {
  accountableOwner: string;
};

export type ArtifactIntakeAcquisitionSourceV1 =
  | Omit<z.infer<typeof ArtifactIntakeNpmSourceV1Schema>, "path">
  | Omit<z.infer<typeof ArtifactIntakeGithubSourceV1Schema>, "path">;

export interface ArtifactIntakeSourceGroupV1 {
  key: string;
  source: ArtifactIntakeAcquisitionSourceV1;
  items: EffectiveArtifactIntakeItemV1[];
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function acquisitionSource(source: ArtifactIntakeSourceV1): ArtifactIntakeAcquisitionSourceV1 {
  if (source.type === "github") {
    return { type: source.type, repository: source.repository, commit: source.commit };
  }
  const result: ArtifactIntakeAcquisitionSourceV1 = {
    type: source.type,
    registry: source.registry,
    package: source.package,
    version: source.version,
  };
  if (source.integrity !== undefined && result.type === "npm") result.integrity = source.integrity;
  return result;
}

export function parseArtifactIntakeV1Text(text: string): ArtifactIntakeV1 {
  return ArtifactIntakeV1Schema.parse(parseStrictJsonObjectV1(text, "artifact intake"));
}

export function effectiveArtifactIntakeItemsV1(
  value: ArtifactIntakeV1,
): EffectiveArtifactIntakeItemV1[] {
  return value.items.map((item) => ({
    ...item,
    accountableOwner: item.accountableOwner ?? value.defaults?.accountableOwner ?? "",
  }));
}

export function artifactIntakeDigestV1(value: ArtifactIntakeV1): string {
  const canonical = {
    format: value.format,
    version: value.version,
    authority: value.authority,
    items: effectiveArtifactIntakeItemsV1(value).sort((left, right) =>
      ordinalCompare(left.id, right.id),
    ),
  };
  return `sha256:${canonicalStrictJsonSha256V1(canonical)}`;
}

export function artifactIntakeItemSourceDigestV1(item: ArtifactIntakeItemV1): string {
  return `sha256:${canonicalStrictJsonSha256V1(item.source)}`;
}

export function artifactIntakeSourceGroupsV1(
  value: ArtifactIntakeV1,
): ArtifactIntakeSourceGroupV1[] {
  const groups = new Map<string, ArtifactIntakeSourceGroupV1>();
  for (const item of effectiveArtifactIntakeItemsV1(value)) {
    const source = acquisitionSource(item.source);
    const key = `sha256:${canonicalStrictJsonSha256V1(source)}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { key, source, items: [item] });
    } else {
      existing.items.push(item);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: group.items.sort((left, right) => ordinalCompare(left.id, right.id)),
    }))
    .sort((left, right) => ordinalCompare(left.key, right.key));
}

export function artifactEvidenceRecordIdV1(itemIdValue: string, sourceDigest: string): string {
  const parsedId = itemId.parse(itemIdValue);
  const match = /^sha256:([a-f0-9]{64})$/.exec(sourceDigest);
  if (match?.[1] === undefined) throw new TypeError("source digest must be a lowercase SHA-256");
  return `scan-${parsedId}-${match[1].slice(0, 12)}`;
}
