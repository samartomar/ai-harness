import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encodeCatalogQualificationPackageInputV2,
  expandCatalogQualificationPackageInputV2,
} from "../../../../src/org-policy/workbench/core/catalog-qualification-compact.js";
import { decodeCatalogQualificationPackageInputV1 } from "../../../../src/org-policy/workbench/core/catalog-qualification-package-v1.js";
import fixture from "../../../fixtures/catalog-qualification-package-input-v1.json";

describe("shared Catalog qualification proof transport", () => {
  it("rejects extra closure references even when they reuse the same artifact bytes", () => {
    const compact = encodeCatalogQualificationPackageInputV2(fixture);
    const record = compact.records[0];
    if (!record) throw new Error("Missing compact record");
    const digest = Object.values(record.closures)[0];
    if (!digest) throw new Error("Missing closure");
    record.closures["artifact:unused.json"] = digest;
    expect(() => expandCatalogQualificationPackageInputV2(compact)).toThrow();
    for (let index = 0; index < 4096; index++)
      record.closures[`artifact:extra-${index}.json`] = digest;
    expect(() => expandCatalogQualificationPackageInputV2(compact)).toThrow();
    const legacy = structuredClone(fixture);
    const original = legacy.records[0];
    if (!original) throw new Error("Missing original record");
    const value = Object.values(original.closureBytesByIdentityBase64)[0];
    if (!value) throw new Error("Missing original closure");
    const closures = original.closureBytesByIdentityBase64 as Record<string, string>;
    closures["artifact:unused.json"] = value;
    expect(() => decodeCatalogQualificationPackageInputV1(legacy)).toThrow();
    for (const key of Object.keys(closures)) delete closures[key];
    closures["artifact:unused.json"] = value;
    expect(() => decodeCatalogQualificationPackageInputV1(legacy)).toThrow(/does not match/);
  });
  it("round-trips original bytes without changing existing qualification validation", () => {
    const compact = encodeCatalogQualificationPackageInputV2(fixture);
    expect(expandCatalogQualificationPackageInputV2(compact)).toEqual(fixture);
    expect(decodeCatalogQualificationPackageInputV1(compact)).toEqual(
      decodeCatalogQualificationPackageInputV1(fixture),
    );
  });
  it("stores one shared receipt set even when hundreds of records refer to it", () => {
    const record = fixture.records[0];
    if (!record) throw new Error("Missing fixture record");
    const input = {
      ...fixture,
      records: Array.from({ length: 433 }, () => structuredClone(record)),
    };
    const compact = encodeCatalogQualificationPackageInputV2(input);
    const once = encodeCatalogQualificationPackageInputV2(fixture);
    expect(Object.keys(compact.artifacts)).toEqual(Object.keys(once.artifacts));
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(input).length / 2);
    // Encoding is not authority: duplicate receipts still fail the real decoder.
    expect(() => decodeCatalogQualificationPackageInputV1(compact)).toThrow();
  });
  it("rejects wrong hashes, missing references, unused bytes and oversized record sets", () => {
    const compact = encodeCatalogQualificationPackageInputV2(fixture);
    const key = Object.keys(compact.artifacts)[0];
    if (!key) throw new Error("Missing artifact");
    const changed = structuredClone(compact);
    changed.artifacts[key] = Buffer.from("changed").toString("base64");
    expect(() => expandCatalogQualificationPackageInputV2(changed)).toThrow(/identity/);
    const missing = structuredClone(compact);
    delete missing.artifacts[key];
    expect(() => expandCatalogQualificationPackageInputV2(missing)).toThrow(/Missing/);
    const unused = structuredClone(compact);
    const bytes = Buffer.from("unreferenced");
    unused.artifacts[createHash("sha256").update(bytes).digest("hex")] = bytes.toString("base64");
    expect(() => expandCatalogQualificationPackageInputV2(unused)).toThrow(/Unreferenced/);
    const overflow = { ...compact, records: Array(513).fill(compact.records[0]) };
    expect(() => expandCatalogQualificationPackageInputV2(overflow)).toThrow();
  });
});
