import { DEFAULT_EVIDENCE_MAX_AGE_SECONDS_V1 } from "../evidence-freshness.js";
import type { ScannerBaselinePublicationPublisherV1 } from "./scanner-publication.js";

// Data-only consumer policy: importing this file never loads the Scanner runtime.
export const SCANNER_BASELINE_PUBLICATION_MAX_AGE_SECONDS_V1 = DEFAULT_EVIDENCE_MAX_AGE_SECONDS_V1;
export const SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1 = Object.freeze({
  repository: "samartomar/aih-scan",
  workflow: "samartomar/aih-scan/.github/workflows/baseline-publication.yml",
  ref: "refs/heads/main",
  commit: "f6189c0211fe27369fb15672f00da76c2072361c",
} satisfies ScannerBaselinePublicationPublisherV1);

/** Independently reviewed publisher revisions; retaining old receipts does not renew them. */
export const SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1 = Object.freeze([
  SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1,
  Object.freeze({
    ...SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1,
    commit: "3510a267916dbbe102e5d18094b0de5332aab02b",
  }),
  Object.freeze({
    ...SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1,
    commit: "68f15423725d3568f9ebabbfbad8309f47d06cd7",
  }),
  Object.freeze({
    ...SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1,
    commit: "6a39ac3134435b686181ec830e37d09d9d14ffa8",
  }),
  Object.freeze({
    ...SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1,
    commit: "0248015935ecf91ed9b99670c049306bb7cfca18",
  }),
]);

/** Select policy, never trust, from an immutable locator; signature verification still follows. */
export function scannerBaselinePublicationPublisherForLocatorV1(
  locator: unknown,
): ScannerBaselinePublicationPublisherV1 | undefined {
  if (typeof locator !== "string" || locator.length > 2_048) return undefined;
  return SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1.find((publisher) => {
    const prefix = `https://github.com/${publisher.repository}/releases/download/baseline-v1-${publisher.commit}-`;
    return (
      locator.startsWith(prefix) &&
      /^[0-9a-f]{64}\/publication\.json$/.test(locator.slice(prefix.length))
    );
  });
}
