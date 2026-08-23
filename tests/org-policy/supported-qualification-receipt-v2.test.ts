import { describe, expect, it } from "vitest";
import {
  MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2,
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
});
