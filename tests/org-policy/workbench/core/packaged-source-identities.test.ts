import { expect, it } from "vitest";
import { packagedWorkbenchSourceDataRecordsV1 } from "../../../../src/org-policy/workbench/core/packaged-source-data.js";
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
