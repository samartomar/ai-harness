import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareSourceDataBaselineCoverageV1 } from "../../src/baseline-evidence/source-data-baseline-preparation.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aih-baseline-data-"));
  roots.push(root);
  mkdirSync(join(root, "skills"));
  mkdirSync(join(root, "skills", "one"));
  writeFileSync(join(root, "skills", "one", "SKILL.md"), "# One\n");
  writeFileSync(join(root, "skills", "one", "helper.md"), "Support\n");
  writeFileSync(join(root, "LICENSE"), "Fixture legal context\n");
  const input = {
    version: "pinned-baseline/v1",
    framework: {
      id: "ecc",
      repository: "affaan-m/ECC",
      commit: "a".repeat(40),
      assets: [
        {
          id: "skill:one",
          kind: "skill",
          source: { repository: "affaan-m/ECC", commit: "a".repeat(40), path: "skills/one" },
          sourcePaths: ["skills/one"],
        },
      ],
    },
  };
  return { root, input };
}
it("reconstructs baseline declaration identity from complete actual material without inventing a report", () => {
  const { root, input } = fixture();
  const prepared = prepareSourceDataBaselineCoverageV1(root, input);
  expect(prepared.coverage.components[0]?.files.map((file) => file.path)).toEqual([
    "skills/one/SKILL.md",
    "skills/one/helper.md",
  ]);
  expect(prepared.compiled.evidence).toEqual({});
  expect(prepared.coverage.unmappedDerivedAssets).toEqual(["ecc/profile:methodology"]);
  expect(prepared.coverage.source.inputFormat).toBe("pinned-baseline/v1");
  const before = prepared.coverage.components[0]?.subject.contentDigest;
  writeFileSync(join(root, "LICENSE"), "Changed legal context\n");
  expect(
    prepareSourceDataBaselineCoverageV1(root, input).coverage.components[0]?.subject.contentDigest,
  ).not.toBe(before);
});
it.each(["repository", "commit", "missing-primary", "duplicate", "report-claim"])(
  "rejects malformed baseline %s",
  (caseName) => {
    const { root, input } = fixture();
    const asset = input.framework.assets[0];
    if (!asset) throw Error("fixture");
    if (caseName === "repository") asset.source.repository = "other/repo";
    if (caseName === "commit") asset.source.commit = "b".repeat(40);
    if (caseName === "missing-primary") asset.source.path = "other/missing";
    if (caseName === "duplicate") input.framework.assets.push(structuredClone(asset));
    if (caseName === "report-claim") Object.assign(asset, { vet: { verdict: "pass" } });
    expect(() => prepareSourceDataBaselineCoverageV1(root, input)).toThrow();
  },
);

it("normalizes real overlapping closure paths but never hides a nonexistent child", () => {
  const { root, input } = fixture();
  const asset = input.framework.assets[0];
  if (!asset) throw new Error("fixture");
  asset.sourcePaths.push("skills/one/SKILL.md");
  expect(prepareSourceDataBaselineCoverageV1(root, input).coverage.components[0]?.paths).toEqual([
    "skills/one",
  ]);
  asset.sourcePaths.push("skills/one/missing.md");
  expect(() => prepareSourceDataBaselineCoverageV1(root, input)).toThrow();
});
