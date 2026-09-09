import { createHash } from "node:crypto";
import { z } from "zod";
import { SCANNER_BASELINE_ANALYZER_VERSIONS } from "../baseline-evidence/scanner-profile.js";
import { readVendorBaselineLock, vendorBaselineLockSha256 } from "../baseline-evidence/vendor.js";
import { canonicalStrictJsonBytesV1, parseStrictJsonObjectV1 } from "../contract/strict-json-v1.js";
import { projectBaselineDisplayEvidenceV1 } from "./baseline-display-projection-v1.js";
import {
  PACKAGED_PUBLIC_BASELINE_BYTES_V1,
  PACKAGED_PUBLIC_BASELINE_SHA256_V1,
} from "./packaged-public-baseline-data.js";
import type { AuthoringCatalogBundleV1 } from "./workbench/contracts.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const PUBLIC_BASELINE_PUBLISHER_V1 = Object.freeze({
  repository: "samartomar/ai-harness",
  workflow: "samartomar/ai-harness/.github/workflows/vendor-baseline-evidence.yml",
  ref: "refs/heads/main",
  environment: "baseline-evidence-publish",
  issuer: "https://token.actions.githubusercontent.com",
});

/** Display proof under the shipped Core package's trust, never organization authority. */
export const PackagedPublicBaselineEvidenceV1Schema = z
  .object({
    version: z.literal("packaged-public-baseline-evidence/v1"),
    authority: z.literal("display-only"),
    publisher: z
      .object({
        repository: z.literal(PUBLIC_BASELINE_PUBLISHER_V1.repository),
        workflow: z.literal(PUBLIC_BASELINE_PUBLISHER_V1.workflow),
        ref: z.literal(PUBLIC_BASELINE_PUBLISHER_V1.ref),
        environment: z.literal(PUBLIC_BASELINE_PUBLISHER_V1.environment),
        issuer: z.literal(PUBLIC_BASELINE_PUBLISHER_V1.issuer),
      })
      .strict(),
    artifactSubjectDigest: digest,
    lockDigest: digest,
    signedAt: z.string().datetime(),
    verifiedAt: z.string().datetime(),
    validUntil: z.string().datetime(),
    contextDigest: digest,
    // Expected analyzer policy is not a retained claim about a Scanner run.
    expectedAnalyzerPolicy: z.record(z.string(), z.string().min(1).max(256)),
  })
  .strict()
  .superRefine((value, ctx) => {
    const signed = Date.parse(value.signedAt);
    const verified = Date.parse(value.verifiedAt);
    const until = Date.parse(value.validUntil);
    if (signed > verified || verified >= until)
      ctx.addIssue({
        code: "custom",
        message: "Public evidence requires ordered original validity.",
      });
  });

/** Parser/validator only; returning parsed JSON cannot issue operational custody. */
export function inspectPackagedPublicBaselineBytesV1(bytes: string, seal: string) {
  if (
    Buffer.byteLength(bytes, "utf8") > 4 * 1024 * 1024 ||
    !/^sha256:[a-f0-9]{64}$/.test(seal) ||
    `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}` !== seal
  )
    throw new TypeError("Packaged public evidence seal mismatch.");
  const parsed = PackagedPublicBaselineEvidenceV1Schema.parse(
    parseStrictJsonObjectV1(bytes, "Packaged public evidence"),
  );
  if (!canonicalStrictJsonBytesV1(parsed).equals(Buffer.from(bytes, "utf8")))
    throw new TypeError("Packaged public evidence must use canonical bytes.");
  if (parsed.lockDigest !== `sha256:${vendorBaselineLockSha256()}`)
    throw new TypeError("Packaged public evidence does not cover the shipped vendor lock.");
  if (
    !canonicalStrictJsonBytesV1(parsed.expectedAnalyzerPolicy).equals(
      canonicalStrictJsonBytesV1(SCANNER_BASELINE_ANALYZER_VERSIONS),
    )
  )
    throw new TypeError("Packaged public evidence analyzer policy mismatch.");
  return parsed;
}

/** Inputless package loader. It never reads a caller's evidence file or starts a process. */
export function packagedPublicBaselineEvidenceV1() {
  if (PACKAGED_PUBLIC_BASELINE_BYTES_V1 === null && PACKAGED_PUBLIC_BASELINE_SHA256_V1 === null)
    return undefined;
  if (PACKAGED_PUBLIC_BASELINE_BYTES_V1 === null || PACKAGED_PUBLIC_BASELINE_SHA256_V1 === null)
    throw new TypeError("Packaged public evidence is incomplete.");
  return inspectPackagedPublicBaselineBytesV1(
    PACKAGED_PUBLIC_BASELINE_BYTES_V1,
    PACKAGED_PUBLIC_BASELINE_SHA256_V1,
  );
}

export function packagedPublicBaselineOverlayV1(bundle: AuthoringCatalogBundleV1) {
  const prepared = packagedPublicBaselineEvidenceV1();
  if (!prepared) return {};
  // Facts come from the exact shipped lock, not editable report copies in proof JSON.
  // Retain original verified dates; the UI evaluates currency when it displays them.
  return projectBaselineDisplayEvidenceV1(
    {
      lock: readVendorBaselineLock(),
      evidenceDigest: prepared.lockDigest.slice(7),
      contextDigest: prepared.contextDigest,
      verifiedAt: prepared.verifiedAt,
      validUntil: prepared.validUntil,
    },
    bundle,
    prepared.verifiedAt,
  );
}
