import { describe, expect, it } from "vitest";
import {
  eccDescriptorSectionOf,
  readEccDescriptor,
  readEccHookControlInventory,
} from "../src/descriptor.js";
import {
  descriptorFromDocument,
  descriptorOf,
  PINNED_COMMIT,
  pinnedDescriptorDocument,
} from "./context.js";

function document() {
  return {
    format: "aih-catalog-framework-descriptor",
    version: 1,
    frameworkId: "ecc",
    sections: {
      vendorLock: {
        id: "ecc",
        owner: "affaan-m",
        repo: "ECC",
        pinnedSha: PINNED_COMMIT,
      },
    },
  };
}

describe("ECC descriptor boundary", () => {
  it("accepts the exact pinned source and refuses an absent required section", () => {
    const parsed = readEccDescriptor(descriptorFromDocument(document()));
    expect(parsed.source).toEqual({ owner: "affaan-m", repo: "ECC", commit: PINNED_COMMIT });
    expect(() => eccDescriptorSectionOf(parsed, "hookControlInventory")).toThrow(
      "sections.hookControlInventory is missing",
    );
  });

  it("refuses changed bytes, malformed JSON, and a mismatched framework identity", () => {
    const valid = descriptorFromDocument(document());
    expect(() => readEccDescriptor({ ...valid, sha256: "0".repeat(64) })).toThrow(
      "descriptor digest",
    );
    expect(() => readEccDescriptor(descriptorOf(new TextEncoder().encode("{broken")))).toThrow(
      "not strict JSON",
    );
    expect(() => readEccDescriptor({ ...valid, frameworkId: "superpowers" })).toThrow(
      "the bytes are for framework",
    );
  });

  it("refuses unsupported envelopes and a changed Catalog source pin", () => {
    expect(() => readEccDescriptor(descriptorFromDocument({ ...document(), extra: true }))).toThrow(
      "unknown key extra",
    );
    expect(() =>
      readEccDescriptor(descriptorFromDocument({ ...document(), format: "other" })),
    ).toThrow("descriptor format");
    expect(() => readEccDescriptor(descriptorFromDocument({ ...document(), version: 2 }))).toThrow(
      "descriptor version",
    );
    expect(() =>
      readEccDescriptor(descriptorFromDocument({ ...document(), frameworkId: "other" })),
    ).toThrow("descriptor names framework");
    expect(() =>
      readEccDescriptor(
        descriptorFromDocument({
          ...document(),
          sections: {
            vendorLock: { ...document().sections.vendorLock, pinnedSha: "b".repeat(40) },
          },
        }),
      ),
    ).toThrow("Catalog pins");
  });

  it("requires a shaped vendor lock before consulting hook data", () => {
    expect(() => readEccDescriptor(descriptorFromDocument({ ...document(), sections: 1 }))).toThrow(
      "sections must be an object",
    );
    expect(() =>
      readEccDescriptor(descriptorFromDocument({ ...document(), sections: {} })),
    ).toThrow("sections.vendorLock must be an object");
    expect(() =>
      readEccDescriptor(
        descriptorFromDocument({
          ...document(),
          sections: { vendorLock: { ...document().sections.vendorLock, id: "other" } },
        }),
      ),
    ).toThrow("vendorLock.id");
  });

  it("binds the hook inventory to its pinned source and source-list digest", () => {
    const original = pinnedDescriptorDocument();
    expect(
      readEccHookControlInventory(readEccDescriptor(descriptorFromDocument(original))).hooks.length,
    ).toBeGreaterThan(0);
    const wrongPin = structuredClone(original);
    const wrongPinInventory = wrongPin.sections.hookControlInventory as {
      provenance: { commit: string; contentSha256: string };
    };
    wrongPinInventory.provenance.commit = "b".repeat(40);
    expect(() =>
      readEccHookControlInventory(readEccDescriptor(descriptorFromDocument(wrongPin))),
    ).toThrow("is not the pinned source");
    const wrongDigest = structuredClone(original);
    const wrongDigestInventory = wrongDigest.sections.hookControlInventory as {
      provenance: { contentSha256: string };
    };
    wrongDigestInventory.provenance.contentSha256 = "0".repeat(64);
    expect(() =>
      readEccHookControlInventory(readEccDescriptor(descriptorFromDocument(wrongDigest))),
    ).toThrow("is not the digest");
    const malformed = structuredClone(original);
    malformed.sections.hookControlInventory = {};
    expect(() =>
      readEccHookControlInventory(readEccDescriptor(descriptorFromDocument(malformed))),
    ).toThrow("hookControlInventory is malformed");
  });
});
