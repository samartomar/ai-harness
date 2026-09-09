import { afterEach, describe, expect, it, vi } from "vitest";

const dataPath = "../../../../src/org-policy/workbench/core/catalog-qualification-data.js";
const packagePath = "../../../../src/org-policy/workbench/core/catalog-qualification-package-v1.js";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock(dataPath);
});

describe("Catalog qualification package completeness", () => {
  it("throws for malformed generated input instead of silently replacing it with empty claims", async () => {
    vi.doMock(dataPath, () => ({
      catalogQualificationPackageInputV1: () => ({
        version: 2,
        records: [],
        bindings: [],
        projections: [],
      }),
    }));
    const packageModule = await import(packagePath);
    expect(() => packageModule.packagedCatalogQualificationRecordsV1()).toThrow(
      /input is malformed/,
    );
  });

  it("rejects a positive projection when no authenticated raw record was packaged", async () => {
    vi.doMock(dataPath, () => ({
      catalogQualificationPackageInputV1: () => ({
        version: 1,
        records: [],
        bindings: [],
        projections: [{ "aih/skill:review": { state: "qualified" } }],
      }),
    }));
    const packageModule = await import(packagePath);
    expect(() => packageModule.packagedCatalogQualificationRecordsV1()).toThrow(
      /wholly empty or complete/,
    );
  });

  it("rejects raw records without their Core binding and display projection", async () => {
    vi.doMock(dataPath, () => ({
      catalogQualificationPackageInputV1: () => ({
        version: 1,
        records: [
          {
            receiptBytesBase64: Buffer.from("receipt").toString("base64"),
            receiptSetBytesBase64: Buffer.from("set").toString("base64"),
            memberBytesBase64: Buffer.from("member").toString("base64"),
            closureBytesByIdentityBase64: {
              "closure:one": Buffer.from("closure").toString("base64"),
            },
            publisher: {
              repository: "samartomar/aih-catalog",
              workflow: "workflow",
              ref: "refs/heads/main",
              issuer: "issuer",
              commit: "a".repeat(40),
              subjectName: "recipe.review.json",
            },
            receiptSetPublisher: {
              repository: "samartomar/aih-catalog",
              workflow: "workflow",
              ref: "refs/heads/main",
              issuer: "issuer",
              commit: "a".repeat(40),
              subjectName: "qualification-receipt-set.json",
            },
          },
        ],
        bindings: [],
        projections: [],
      }),
    }));
    const packageModule = await import(packagePath);
    expect(() => packageModule.packagedCatalogQualificationRecordsV1()).toThrow(
      /lacks raw record, binding, or projection coverage/,
    );
  });
});
