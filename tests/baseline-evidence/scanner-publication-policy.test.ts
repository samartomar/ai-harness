import { describe, expect, it } from "vitest";
import { scannerBaselinePublicationPublisherForLocatorV1 } from "../../src/baseline-evidence/scanner-publication-policy.js";

const locator = (commit: string) =>
  `https://github.com/samartomar/aih-scan/releases/download/baseline-v1-${commit}-${"a".repeat(64)}/publication.json`;

describe("reviewed Scanner publisher identities", () => {
  it.each([
    "f6189c0211fe27369fb15672f00da76c2072361c",
    "3510a267916dbbe102e5d18094b0de5332aab02b",
    "68f15423725d3568f9ebabbfbad8309f47d06cd7",
    "6a39ac3134435b686181ec830e37d09d9d14ffa8",
    "981d50f19ec8923974597de28c4c7b7acf684ded",
  ])("retains exact reviewed publisher %s", (commit) => {
    const publisher = scannerBaselinePublicationPublisherForLocatorV1(locator(commit));
    expect(publisher?.commit).toBe(commit);
    expect(Object.isFrozen(publisher)).toBe(true);
  });
  it("retains immutable dated renewal locators accepted by the publication verifier", () => {
    const commit = "981d50f19ec8923974597de28c4c7b7acf684ded";
    expect(
      scannerBaselinePublicationPublisherForLocatorV1(
        locator(commit).replace("/publication.json", "-r20260914/publication.json"),
      )?.commit,
    ).toBe(commit);
    expect(
      scannerBaselinePublicationPublisherForLocatorV1(
        locator(commit).replace("/publication.json", "-rlatest/publication.json"),
      ),
    ).toBeUndefined();
  });
  it.each([
    locator("f".repeat(40)),
    locator("3510a267916dbbe102e5d18094b0de5332aab02b").replace("samartomar", "attacker"),
    `${locator("3510a267916dbbe102e5d18094b0de5332aab02b")}?mutable=1`,
    "https://github.com/samartomar/aih-scan/releases/latest/download/publication.json",
    undefined,
  ])("rejects unreviewed or mutable locator %s", (value) => {
    expect(scannerBaselinePublicationPublisherForLocatorV1(value)).toBeUndefined();
  });
});
