import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { canonicalStrictJsonSha256V1 } from "../../../contract/strict-json-v1.js";
import { findOnPath } from "../../../live/runner.js";
import { parseAihSupportedQualificationReceiptV2Bytes } from "../../supported-qualification-receipt-v2.js";
import type { AuthoringCatalogBundleV1 } from "../contracts.js";
import {
  type CatalogQualificationPublisherV1,
  decodeCatalogQualificationPackageInputV1,
} from "./catalog-qualification-package-v1.js";
import {
  CATALOG_QUALIFICATION_RELEASE_POLICIES_V1,
  CATALOG_QUALIFICATION_RELEASE_POLICY_V1,
} from "./catalog-qualification-policy-v1.js";
import {
  catalogQualificationAttestationMatchesV1,
  inspectCatalogQualificationArtifactV1,
} from "./catalog-qualification-v1.js";

export const SourceDataQualificationProofV1Schema = z
  .object({
    packageInput: z.unknown(),
    receiptAttestation: z.string().min(1).max(512_000),
    receiptSetAttestation: z.string().min(1).max(512_000),
  })
  .strict();
const verified = new Set<string>();
function fail(): never {
  throw new TypeError(
    "Workbench source data: independent Catalog qualification verification failed",
  );
}
function publisherPolicy(
  publisher: CatalogQualificationPublisherV1,
  subjectName: string,
  commits: readonly string[],
) {
  const fixed = CATALOG_QUALIFICATION_RELEASE_POLICY_V1.publisher;
  return (
    publisher.repository === fixed.repository &&
    publisher.workflow === fixed.workflow &&
    publisher.ref === fixed.ref &&
    publisher.issuer === fixed.issuer &&
    publisher.subjectName === subjectName &&
    commits.includes(publisher.commit)
  );
}
export function verifySourceDataArtifactWithGithubV1(
  bytes: Uint8Array,
  attestation: string,
  publisher: CatalogQualificationPublisherV1,
  directory: string,
  label: string,
): string {
  const gh = findOnPath("gh", process.env, process.platform, {
    excludeRoot: process.cwd(),
    windowsExeOnly: true,
  });
  if (!gh)
    throw new TypeError(
      "Workbench source data preparation requires GitHub CLI (gh) on PATH; no cache was activated.",
    );
  const path = join(directory, `${label}.json`),
    proof = join(directory, `${label}.jsonl`);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  writeFileSync(proof, attestation, { flag: "wx", mode: 0o600 });
  return execFileSync(
    gh,
    [
      "attestation",
      "verify",
      path,
      "--bundle",
      proof,
      "--repo",
      publisher.repository,
      "--cert-identity",
      `https://github.com/${publisher.workflow}@${publisher.ref}`,
      "--cert-oidc-issuer",
      publisher.issuer,
      "--source-ref",
      publisher.ref,
      "--source-digest",
      publisher.commit,
      "--deny-self-hosted-runners",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 512_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}
/** Independently authenticates Catalog artifacts; a source-data signature alone cannot mint qualification. */
export function verifySourceDataQualificationV1(
  bundle: AuthoringCatalogBundleV1,
  input: unknown,
  issuedAt: string,
  authorizedCommits: readonly string[] = CATALOG_QUALIFICATION_RELEASE_POLICIES_V1.map(
    (policy) => policy.catalogCommit,
  ),
): void {
  const summaries = bundle.qualifications ?? {};
  if (Object.keys(summaries).length === 0) {
    if (input !== undefined) fail();
    return;
  }
  const proof = SourceDataQualificationProofV1Schema.parse(input);
  const cacheKey = canonicalStrictJsonSha256V1({ bundle, proof, issuedAt, authorizedCommits });
  if (verified.has(cacheKey)) return;
  const decoded = decodeCatalogQualificationPackageInputV1(proof.packageInput);
  if (
    canonicalStrictJsonSha256V1(decoded.projections[0]?.summary) !==
      canonicalStrictJsonSha256V1(summaries) ||
    decoded.records.length === 0
  )
    fail();
  const bindings = Object.fromEntries(
    decoded.bindings.map((binding) => [binding.asset.assetId, binding]),
  );
  const first = decoded.records[0]!;
  for (const record of decoded.records) {
    const receipt = parseAihSupportedQualificationReceiptV2Bytes(record.receiptBytes);
    if (
      receipt === undefined ||
      !publisherPolicy(record.publisher, `${receipt.entryId}.json`, authorizedCommits) ||
      !publisherPolicy(
        record.receiptSetPublisher,
        CATALOG_QUALIFICATION_RELEASE_POLICY_V1.receiptSetPublisher.subjectName,
        authorizedCommits,
      ) ||
      record.publisher.commit !== record.receiptSetPublisher.commit
    )
      fail();
  }
  const directory = mkdtempSync(join(tmpdir(), "aih-source-catalog-proof-"));
  try {
    // The protected Catalog workflow binds all per-entry receipts in one signed statement.
    // Verify it once cryptographically, then bind each exact subject to that verified statement.
    const receipts = verifySourceDataArtifactWithGithubV1(
      first.receiptBytes,
      proof.receiptAttestation,
      first.publisher,
      directory,
      "receipt",
    );
    const set = verifySourceDataArtifactWithGithubV1(
      first.receiptSetBytes,
      proof.receiptSetAttestation,
      first.receiptSetPublisher,
      directory,
      "receipt-set",
    );
    for (const record of decoded.records) {
      const summary = Object.values(summaries).find(
        (summary) => summary.receiptDigest === `sha256:${canonicalBytesHash(record.receiptBytes)}`,
      );
      if (!summary || Date.parse(summary.verifiedAt) > Date.parse(issuedAt)) fail();
      if (
        !catalogQualificationAttestationMatchesV1(
          receipts,
          record.publisher,
          record.receiptBytes,
          Date.parse(summary.verifiedAt),
        ) ||
        !catalogQualificationAttestationMatchesV1(
          set,
          record.receiptSetPublisher,
          record.receiptSetBytes,
          Date.parse(summary.verifiedAt),
        )
      )
        fail();
      const inspected = inspectCatalogQualificationArtifactV1(
        bundle,
        record,
        bindings,
        summary.verifiedAt,
        summary.verifiedAt,
      );
      if (
        inspected === undefined ||
        canonicalStrictJsonSha256V1(inspected[summary.assetId]) !==
          canonicalStrictJsonSha256V1(summary)
      )
        fail();
    }
    verified.add(cacheKey);
    if (verified.size > 16) verified.delete(verified.values().next().value!);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

import { createHash } from "node:crypto";

function canonicalBytesHash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
