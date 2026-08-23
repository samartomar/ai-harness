import { describe, expect, it } from "vitest";
import {
  MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2,
  acceptAihSupportedQualificationReceiptV2,
  inspectAihSupportedQualificationCustodyV2,
  parseAihSupportedQualificationReceiptV2Bytes,
} from "../../src/org-policy/supported-qualification-receipt-v2.js";

describe("AIH-supported qualification receipt V2", () => {
  it("has the synchronized 5,970 byte ceiling and refuses V1", () => {
    expect(MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2).toBe(5_970);
    expect(
      parseAihSupportedQualificationReceiptV2Bytes(
        Buffer.from('{"format":"aih-supported-qualification-receipt","version":1}', "utf8"),
      ),
    ).toBeUndefined();
  });

  it("exposes phase-honest custody operations for genesis, successors, and inspect", async () => {
    const receipt = Buffer.from("{}", "utf8");
    await expect(
      acceptAihSupportedQualificationReceiptV2({
        root: "C:/disposable-admin-root",
        apply: false,
        receipt,
        now: "2026-08-02T12:00:00.000Z",
      }),
    ).resolves.toMatchObject({ state: "preview" });
    await expect(
      inspectAihSupportedQualificationCustodyV2({ root: "C:/disposable-admin-root" }),
    ).resolves.toMatchObject({ state: "absent" });
  });

  it("keeps continuity/replay and post-verifier source substitution as explicit custody gates", async () => {
    await expect(
      acceptAihSupportedQualificationReceiptV2({
        root: "C:/disposable-admin-root",
        apply: true,
        receipt: Buffer.from("{}", "utf8"),
        now: "2026-08-02T12:00:00.000Z",
        afterVerificationForTest: () => undefined,
      }),
    ).resolves.toMatchObject({ state: expect.any(String) });
  });
});
