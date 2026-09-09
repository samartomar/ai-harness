import { expect, it } from "vitest";
import { packagedWorkbenchSourceDataRecordsV1 } from "../../../../src/org-policy/workbench/core/packaged-source-data.js";
import { PACKAGED_WORKBENCH_SOURCE_DATA_V1 } from "../../../../src/org-policy/workbench/core/packaged-source-data-data.js";
import identities from "../../../fixtures/workbench-initial-source-identities.json";

it("preserves initial source identities so compatible Core releases do not replace saved policy material", () => {
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
  expect(actual).toEqual(identities.identities);
});

it("keeps the authenticated ECC runtime descriptor within package and receipt bounds", () => {
  const record = PACKAGED_WORKBENCH_SOURCE_DATA_V1.find((item) => {
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
  expect(record.sha256).toBe("85d3f1c437bf5ba719588ec2aad512b53c89e6ce7562bf491cef6eb00d6fffde");
  expect(Buffer.byteLength(record.bytes)).toBe(8_709_096);
  expect(Buffer.byteLength(record.bytes)).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(descriptor.sha256).toBe(
    "sha256:158f63e265f1ca18a7e65c97e372b1259200d6fb60eab87d70c20600d9d9abf0",
  );
  expect(Buffer.byteLength(descriptor.bytesBase64)).toBe(6_431_736);
  expect(Buffer.byteLength(descriptor.bytesBase64)).toBeLessThanOrEqual(16 * 1024 * 1024);
});
