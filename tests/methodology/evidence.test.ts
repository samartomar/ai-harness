import { describe, expect, it } from "vitest";
import { joinExactEvidence } from "../../src/methodology/evidence.js";

const source = {
  repository: "garrytan/gstack",
  root: "C:/research/gstack",
  resolvedCommit: "a".repeat(40),
  treeSha256: "b".repeat(64),
};

const evidence = {
  repository: source.repository,
  resolvedCommit: source.resolvedCommit,
  treeSha256: source.treeSha256,
  paths: ["skills", "hooks"],
  verdict: "pass" as const,
};

describe("methodology evidence joins", () => {
  it("joins only exact source and path identity", () => {
    expect(joinExactEvidence(source, ["hooks", "skills"], [evidence])).toEqual(evidence);
  });

  it.each([
    ["repository", { repository: "other/gstack" }],
    ["commit", { resolvedCommit: "c".repeat(40) }],
    ["tree", { treeSha256: "d".repeat(64) }],
    ["paths", { paths: ["skills"] }],
  ])("excludes evidence with a mismatched %s", (_label, mismatch) => {
    expect(joinExactEvidence(source, ["hooks", "skills"], [{ ...evidence, ...mismatch }])).toBeUndefined();
  });
});
