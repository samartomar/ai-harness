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
const AUTHORITY_REFUSAL = /framework differs from admitted Catalog authority/;

// Only the framework the installed Catalog admits can be prepared. Its positive
// path needs the real upstream bytes its metadata digests pin; a synthetic
// framework binds its actual material first and is then refused by authority.
it("binds complete actual material, then refuses a framework the installed Catalog does not admit", () => {
  const { root, input } = fixture();
  expect(() => prepareSourceDataBaselineCoverageV1(root, input)).toThrow(AUTHORITY_REFUSAL);
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
  // An existing redundant child passes material binding and reaches the authority check.
  expect(() => prepareSourceDataBaselineCoverageV1(root, input)).toThrow(AUTHORITY_REFUSAL);
  asset.sourcePaths.push("skills/one/missing.md");
  let refusal: unknown;
  try {
    prepareSourceDataBaselineCoverageV1(root, input);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(Error);
  expect((refusal as Error).message).not.toMatch(AUTHORITY_REFUSAL);
});
