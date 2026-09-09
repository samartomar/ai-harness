import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/org-policy/workbench/core/catalog-qualification-data.js", async () => {
  const { readFileSync } = await import("node:fs");
  return {
    catalogQualificationPackageInputV1: () =>
      JSON.parse(
        readFileSync(
          new URL("../../../fixtures/catalog-qualification-package-input-v1.json", import.meta.url),
          "utf8",
        ),
      ),
  };
});

import {
  packagedCatalogQualificationBindingsV1,
  packagedCatalogQualificationProjectionsV1,
  packagedCatalogQualificationRecordsV1,
} from "../../../../src/org-policy/workbench/core/catalog-qualification-package-v1.js";

describe("generated Catalog qualification package data", () => {
  it("loads only the code-owned generated module and decodes its bounded raw artifacts", () => {
    const [record] = packagedCatalogQualificationRecordsV1();
    expect(record).toBeDefined();
    expect(Buffer.from(record!.receiptBytes).toString("utf8")).toContain(
      "aih-supported-qualification-receipt",
    );
    expect(Buffer.from(record!.receiptSetBytes).toString("utf8")).toContain(
      "qualification-receipt-set",
    );
    expect(Buffer.from(record!.memberBytes).toString("utf8")).toContain("recipe.review");
    expect(
      Buffer.from(
        record!.closureBytesByIdentity["artifact:artifacts/review-closure.json"]!,
      ).toString("utf8"),
    ).toContain("aih-supported-catalog-member-closure");
    expect(packagedCatalogQualificationBindingsV1()).toHaveLength(1);
    expect(packagedCatalogQualificationProjectionsV1()[0]?.summary).toHaveProperty(
      "aih/skill:review",
    );
  });

  it("returns detached data, so a caller cannot change the package-owned loader state", () => {
    const first = packagedCatalogQualificationRecordsV1()[0]!;
    first.receiptBytes[0] = 0;
    const second = packagedCatalogQualificationRecordsV1()[0]!;
    expect(second.receiptBytes[0]).not.toBe(0);
    expect(Object.isFrozen(packagedCatalogQualificationProjectionsV1())).toBe(true);
    expect(Object.isFrozen(packagedCatalogQualificationBindingsV1())).toBe(true);
  });
});
