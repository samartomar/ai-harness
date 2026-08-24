import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertSafeRelativePosixPathV1,
  canonicalStrictJsonBytesV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import { ExactSemverV2Schema, GovernanceDecisionEffectV2Schema } from "./governance-decision-v2.js";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_MANIFEST_PATH_SOURCE =
  "^(?!\\.[aA][iI][hH][. ]*(?:/|$))(?![aA][iI][hH]~[0-9]+[. ]*(?:/|$))(?![A-Za-z]:)(?!/)(?!.*\\\\)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)(?!.*/$)[^\\x00-\\x1F\\x7F]+$";
const SAFE_MANIFEST_PATH = new RegExp(SAFE_MANIFEST_PATH_SOURCE);
const stableId = z.string().regex(ID, "must be a bounded stable identifier");
const digest = z.string().regex(SHA256, "must be a sha256 digest");

export const MAX_UPSTREAM_ARTIFACT_MANIFEST_BYTES_V1 = 512 * 1024;
export const MAX_UPSTREAM_ARTIFACT_FILES_V1 = 256;

function safePath(value: string): boolean {
  try {
    assertSafeRelativePosixPathV1(value, "upstream artifact path");
    const firstSegment =
      value
        .split("/", 1)[0]
        ?.replace(/[. ]+$/u, "")
        .toLowerCase() ?? "";
    return value.length <= 500 && firstSegment !== ".aih" && !/^aih~[0-9]+$/u.test(firstSegment);
  } catch {
    return false;
  }
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const UpstreamArtifactManifestV1Schema = z
  .object({
    format: z.literal("aih-upstream-artifact-manifest"),
    version: z.literal(1),
    // The decision binds the evidence digest and the evidence binds this manifest.
    // Binding a decision digest here would create an impossible digest cycle.
    decisionId: stableId,
    subject: z
      .object({
        kind: z.enum(["tool", "skill", "mcp", "package"]),
        id: stableId,
        sourceDigest: digest,
        subjectDigest: digest,
      })
      .strict(),
    target: stableId,
    effect: GovernanceDecisionEffectV2Schema,
    integration: z.object({ owner: stableId, version: ExactSemverV2Schema }).strict(),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(500).regex(SAFE_MANIFEST_PATH).refine(safePath),
            sha256: digest,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_UPSTREAM_ARTIFACT_FILES_V1)
      .refine(
        (files) =>
          files.every(
            (file, index) =>
              index === 0 || ordinalCompare(files[index - 1]?.path ?? "", file.path) < 0,
          ),
        "files must be sorted by path and duplicate-free",
      ),
  })
  .strict();

export type UpstreamArtifactManifestV1 = z.infer<typeof UpstreamArtifactManifestV1Schema>;

export function canonicalUpstreamArtifactManifestV1(value: unknown): string {
  return canonicalStrictJsonBytesV1(UpstreamArtifactManifestV1Schema.parse(value)).toString("utf8");
}

export function upstreamArtifactManifestDigestV1(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update("aih-upstream-artifact-manifest/v1\0", "utf8")
    .update(canonicalUpstreamArtifactManifestV1(value), "utf8")
    .digest("hex")}`;
}

export function parseUpstreamArtifactManifestV1Bytes(
  bytes: Uint8Array,
): UpstreamArtifactManifestV1 | undefined {
  if (bytes.byteLength > MAX_UPSTREAM_ARTIFACT_MANIFEST_BYTES_V1) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const parsed = UpstreamArtifactManifestV1Schema.parse(
      parseStrictJsonObjectV1(text, "upstream artifact manifest"),
    );
    return text === canonicalUpstreamArtifactManifestV1(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
