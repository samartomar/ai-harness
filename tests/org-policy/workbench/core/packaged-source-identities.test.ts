import { expect, it } from "vitest";
import { packagedWorkbenchSourceDataRecordsV1 } from "../../../../src/org-policy/workbench/core/packaged-source-data.js";
import { packagedWorkbenchSourceDataInputV1 } from "../../../../src/org-policy/workbench/core/packaged-source-data-data.js";
import identities from "../../../fixtures/workbench-initial-source-identities.json";

it("preserves retained source identities across compatible Core releases", () => {
  const actual = packagedWorkbenchSourceDataRecordsV1()
    .map((record) => {
      const source = Object.values(record.sourceBundle.sources)[0];
      if (!source) throw new Error("Missing initial source");
      return {
        id: source.id,
        inputFormat: source.inputFormat,
        compiler: source.compiler,
        upstreamOrigin: source.upstreamOrigin,
        revision: source.revision,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  expect(identities.compatibility).toBe("core-workbench-data/v1");
  const retainedIds = new Set(identities.identities.map((source) => source.id));
  expect(actual.filter((source) => retainedIds.has(source.id))).toEqual(identities.identities);
  expect(actual.map((source) => source.id)).not.toContain("source:ponytail");
});

it("keeps the authenticated ECC runtime descriptor within package and receipt bounds", () => {
  const record = packagedWorkbenchSourceDataInputV1().find((item) => {
    const parsed = JSON.parse(item.bytes) as {
      source?: { repository?: unknown; commit?: unknown };
    };
    return (
      parsed.source?.repository === "affaan-m/ECC" &&
      parsed.source.commit === "5064474d4d762dc9640234a41617cccb79185cec"
    );
  });
  if (!record) throw new Error("Missing packaged ECC record");
  const parsed = JSON.parse(record.bytes) as {
    runtimeDescriptor?: { bytesBase64: string; sha256: string };
  };
  const descriptor = parsed.runtimeDescriptor;
  if (!descriptor) throw new Error("Missing packaged ECC runtime descriptor");
  expect(record.sha256).toBe("d286c6e2dc716ad5fa615b5fd86841ef8d6b210faf2279c785fa934d41e26a51");
  expect(Buffer.byteLength(record.bytes)).toBe(8_107_477);
  expect(Buffer.byteLength(record.bytes)).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(descriptor.sha256).toBe(
    "sha256:ca007dbe7910425ccece63e57bc74c2029a8016532c5222002cae2de90ad2f49",
  );
  expect(Buffer.byteLength(descriptor.bytesBase64)).toBe(6_047_004);
  expect(Buffer.byteLength(descriptor.bytesBase64)).toBeLessThanOrEqual(16 * 1024 * 1024);
});
