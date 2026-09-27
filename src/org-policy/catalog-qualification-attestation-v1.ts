/**
 * The publisher pin and the pure statement matcher for an outer GitHub
 * attestation over exact qualification-receipt bytes.
 *
 * Both live here rather than under `workbench/` so that a consumption path can
 * match a verified statement without importing the workbench's packaged catalog
 * machinery. Nothing in this module verifies a signature, runs a process or
 * reads a file: it decides only whether a statement a caller already verified
 * names the pinned publisher and the exact bytes in hand.
 */
import { createHash } from "node:crypto";
import { CATALOG_RECEIPT_SET_MAX_ENTRIES } from "./workbench/core/catalog-qualification-limits.js";

const BARE_DIGEST = /^[0-9a-f]{64}$/;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function bareSha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The exact publisher an operator trusts; never derived from the material. */
export interface CatalogQualificationPublisherV1 {
  readonly repository: string;
  readonly workflow: string;
  readonly ref: string;
  readonly issuer: string;
  readonly commit: string;
  readonly subjectName: string;
}

export function catalogQualificationAttestationMatchesV1(
  output: string,
  publisher: CatalogQualificationPublisherV1,
  bytes: Uint8Array,
  now: number,
): string | undefined {
  try {
    const results = JSON.parse(output);
    if (!Array.isArray(results) || results.length !== 1) return undefined;
    const verification = object(object(results[0])?.verificationResult);
    const signature = object(verification?.signature);
    const certificate = object(signature?.certificate);
    const statement = object(verification?.statement);
    const workflowUri = `https://github.com/${publisher.workflow}@${publisher.ref}`;
    if (
      certificate?.subjectAlternativeName !== workflowUri ||
      certificate?.buildSignerURI !== workflowUri ||
      certificate?.buildConfigURI !== workflowUri ||
      certificate?.issuer !== publisher.issuer ||
      certificate?.sourceRepositoryURI !== `https://github.com/${publisher.repository}` ||
      certificate?.sourceRepositoryRef !== publisher.ref ||
      (certificate?.sourceRepositoryDigest !== publisher.commit &&
        certificate?.sourceRepositoryDigest !== `sha1:${publisher.commit}`) ||
      certificate?.runnerEnvironment !== "github-hosted" ||
      statement?._type !== "https://in-toto.io/Statement/v1" ||
      statement?.predicateType !== "https://slsa.dev/provenance/v1" ||
      !Array.isArray(statement?.subject) ||
      statement.subject.length < 1 ||
      statement.subject.length > CATALOG_RECEIPT_SET_MAX_ENTRIES ||
      (publisher.subjectName === "qualification-receipt-set.json" && statement.subject.length !== 1)
    )
      return undefined;
    const names = new Set<string>();
    for (const raw of statement.subject) {
      const item = object(raw);
      const itemDigest = object(item?.digest);
      if (
        typeof item?.name !== "string" ||
        !/^[a-z][a-z0-9.-]{0,63}\.json$/.test(item.name) ||
        names.has(item.name) ||
        Object.keys(itemDigest ?? {}).join("\0") !== "sha256" ||
        typeof itemDigest?.sha256 !== "string" ||
        !BARE_DIGEST.test(itemDigest.sha256)
      )
        return undefined;
      names.add(item.name);
    }
    const subject = object(
      statement.subject.find((item) => object(item)?.name === publisher.subjectName),
    );
    const subjectDigest = object(subject?.digest);
    if (
      Object.keys(subjectDigest ?? {}).join("\0") !== "sha256" ||
      subject?.name !== publisher.subjectName ||
      subjectDigest?.sha256 !== bareSha256(bytes)
    )
      return undefined;
    const timestamps = verification?.verifiedTimestamps;
    if (!Array.isArray(timestamps) || timestamps.length === 0 || timestamps.length > 16)
      return undefined;
    const moments = timestamps.map((entry) => {
      const value = object(entry)?.timestamp;
      return typeof value === "string" ? Date.parse(value) : Number.NaN;
    });
    if (moments.some((value) => !Number.isFinite(value) || value > now)) return undefined;
    const latest = Math.max(...moments);
    return Number.isFinite(latest)
      ? new Date(latest).toISOString().replace(".000Z", "Z")
      : undefined;
  } catch {
    return undefined;
  }
}
