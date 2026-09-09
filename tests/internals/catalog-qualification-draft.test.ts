import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogQualificationDraftDataV1 } from "../../src/internals/prepare-workbench-catalog-qualification.js";

describe("authenticated Catalog qualification draft encoding", () => {
  it("writes the package loader shape and excludes unrelated compiler bindings", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../fixtures/catalog-qualification-package-input-v1.json", import.meta.url),
        "utf8",
      ),
    );
    const binding = fixture.bindings[0];
    const unrelated = structuredClone(binding);
    unrelated.asset.assetId = "unrelated/skill:other";
    const prepared = {
      records: fixture.records.map((record: any) => ({
        receiptBytes: Buffer.from(record.receiptBytesBase64, "base64"),
        receiptSetBytes: Buffer.from(record.receiptSetBytesBase64, "base64"),
        memberBytes: Buffer.from(record.memberBytesBase64, "base64"),
        closureBytesByIdentity: Object.fromEntries(
          Object.entries(record.closureBytesByIdentityBase64).map(([identity, bytes]) => [
            identity,
            Buffer.from(bytes as string, "base64"),
          ]),
        ),
        publisher: record.publisher,
        receiptSetPublisher: record.receiptSetPublisher,
      })),
      bindings: { [binding.asset.assetId]: binding, [unrelated.asset.assetId]: unrelated },
      projection: { summary: fixture.projections[0] },
    };
    expect(catalogQualificationDraftDataV1(prepared)).toEqual(fixture);
  });
});
