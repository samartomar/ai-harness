import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalOrganizationEvidenceEnvelopeV1,
  organizationEvidenceEnvelopeDigestV1,
  parseOrganizationEvidenceEnvelopeV1Bytes,
} from "../../src/index.js";

const envelope = {
  format: "aih-organization-evidence" as const,
  version: 1 as const,
  subjectDigest: `sha256:${"a".repeat(64)}`,
  evidence: {
    kind: "scan-attestation-v2",
    id: "scanner-evidence-v2",
    summary: "Test transport only; no detector execution or authority.",
    payloadDigest: `sha256:${"b".repeat(64)}`,
    artifactDigests: [`sha256:${"c".repeat(64)}`],
  },
  attestor: "test-scanner",
  issuedAt: "2026-09-20T00:00:00.000Z",
  notBefore: "2026-09-20T00:00:00.000Z",
  expiresAt: "2026-09-21T00:00:00.000Z",
};

describe("public organization evidence API", () => {
  it("round trips canonical bytes and distinguishes the binding digest from the file hash", () => {
    const bytes = Buffer.from(canonicalOrganizationEvidenceEnvelopeV1(envelope));
    expect(parseOrganizationEvidenceEnvelopeV1Bytes(bytes)).toEqual(envelope);
    const binding = organizationEvidenceEnvelopeDigestV1(envelope);
    expect(binding).toBe(
      `sha256:${createHash("sha256").update("aih-organization-evidence/v1\0").update(bytes).digest("hex")}`,
    );
    expect(binding).not.toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  });

  it("refuses malformed, reformatted and unknown-version transports", () => {
    const canonical = canonicalOrganizationEvidenceEnvelopeV1(envelope);
    for (const text of [
      "{",
      `${canonical}\n`,
      JSON.stringify(envelope, null, 2),
      canonical.replace('"version":1', '"version":99'),
    ]) {
      expect(parseOrganizationEvidenceEnvelopeV1Bytes(Buffer.from(text))).toBeUndefined();
    }
  });
});
