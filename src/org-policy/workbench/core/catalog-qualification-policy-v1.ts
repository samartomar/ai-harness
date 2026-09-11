import type { CatalogQualificationPublisherV1 } from "./catalog-qualification-package-v1.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Protected Catalog attestation policy for the reviewed exact-source successor.
 * Membership never grants organization admission or clears Scanner findings.
 */
export const CATALOG_QUALIFICATION_RELEASE_POLICY_V1 = deepFreeze({
  version: 1,
  catalogCommit: "36f269266208661430fc37f167c86e534dabf893",
  publisher: {
    repository: "samartomar/aih-catalog",
    workflow: "samartomar/aih-catalog/.github/workflows/signed-catalog-v2.yml",
    ref: "refs/heads/main",
    issuer: "https://token.actions.githubusercontent.com",
    commit: "36f269266208661430fc37f167c86e534dabf893",
    /** Receipt basename is derived from its strict Catalog entryId at verification. */
    subjectName: "<entryId>.json",
  },
  receiptSetPublisher: {
    repository: "samartomar/aih-catalog",
    workflow: "samartomar/aih-catalog/.github/workflows/signed-catalog-v2.yml",
    ref: "refs/heads/main",
    issuer: "https://token.actions.githubusercontent.com",
    commit: "36f269266208661430fc37f167c86e534dabf893",
    subjectName: "qualification-receipt-set.json",
  },
} as const satisfies {
  version: number;
  catalogCommit: string;
  publisher: CatalogQualificationPublisherV1;
  receiptSetPublisher: CatalogQualificationPublisherV1;
});

/** Metadata may be displayed, but callers cannot supply or alter this policy. */
export const CATALOG_QUALIFICATION_RELEASE_POLICIES_V1 = deepFreeze([
  CATALOG_QUALIFICATION_RELEASE_POLICY_V1,
  {
    ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1,
    catalogCommit: "98d95263aa0901504c9d480628f6c06c4a1fe453",
    publisher: {
      ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1.publisher,
      commit: "98d95263aa0901504c9d480628f6c06c4a1fe453",
    },
    receiptSetPublisher: {
      ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1.receiptSetPublisher,
      commit: "98d95263aa0901504c9d480628f6c06c4a1fe453",
    },
  },
  {
    ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1,
    catalogCommit: "0ce02656d5e281262af2177571033449f277dc46",
    publisher: {
      ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1.publisher,
      commit: "0ce02656d5e281262af2177571033449f277dc46",
    },
    receiptSetPublisher: {
      ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1.receiptSetPublisher,
      commit: "0ce02656d5e281262af2177571033449f277dc46",
    },
  },
  {
    ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1,
    catalogCommit: "b019b4e9d6260915a49d177bcc22b58518305dd4",
    publisher: {
      ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1.publisher,
      commit: "b019b4e9d6260915a49d177bcc22b58518305dd4",
    },
    receiptSetPublisher: {
      ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1.receiptSetPublisher,
      commit: "b019b4e9d6260915a49d177bcc22b58518305dd4",
    },
  },
  {
    ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1,
    catalogCommit: "5e18dd66e42f91c30e4c5acd81d41f1e33cd987a",
    publisher: {
      ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1.publisher,
      commit: "5e18dd66e42f91c30e4c5acd81d41f1e33cd987a",
    },
    receiptSetPublisher: {
      ...CATALOG_QUALIFICATION_RELEASE_POLICY_V1.receiptSetPublisher,
      commit: "5e18dd66e42f91c30e4c5acd81d41f1e33cd987a",
    },
  },
] as const);

export const catalogQualificationReleasePolicyMetadataV1 = deepFreeze({
  version: CATALOG_QUALIFICATION_RELEASE_POLICY_V1.version,
  repository: CATALOG_QUALIFICATION_RELEASE_POLICY_V1.publisher.repository,
  workflow: CATALOG_QUALIFICATION_RELEASE_POLICY_V1.publisher.workflow,
  ref: CATALOG_QUALIFICATION_RELEASE_POLICY_V1.publisher.ref,
  catalogCommit: CATALOG_QUALIFICATION_RELEASE_POLICY_V1.catalogCommit,
});
