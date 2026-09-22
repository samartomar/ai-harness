import { describe, expect, it } from "vitest";
import {
  isBoundedObservationInstallRootV1,
  type ObservedFileMappingV1,
  observedPathSetMatchesV1,
  requiredObservedPathsV1,
} from "../../src/org-policy/upstream-observed-files-v1.js";

// ---------------------------------------------------------------------------
// The installation mapping is explicit: an administrator names one bounded
// directory, and every sealed path must be installed at exactly one path under
// it. Nothing here reads a filesystem, and identical bytes under another name
// are a different path, never a match.
// ---------------------------------------------------------------------------

const sealed = [
  { path: "LICENSE", sha256: "a".repeat(64), byteLength: 598 },
  { path: "SKILL.md", sha256: "b".repeat(64), byteLength: 787 },
  { path: "profile.json", sha256: "c".repeat(64), byteLength: 1126 },
] as const;

function paths(mapping: readonly ObservedFileMappingV1[] | undefined): readonly string[] {
  return (mapping ?? []).map((file) => file.observedPath);
}

describe("observation installation mapping", () => {
  it("accepts only a bounded root-relative directory", () => {
    expect(isBoundedObservationInstallRootV1("packs/governance-quality/aih-gov-doctor")).toBe(true);
    expect(isBoundedObservationInstallRootV1(".claude/skills/aih-gov-doctor")).toBe(true);
    expect(isBoundedObservationInstallRootV1("packs")).toBe(true);

    for (const rejected of [
      "",
      "../x",
      "packs/../../x",
      "/packs",
      "C:/packs",
      "C:\\packs",
      "packs\\governance",
      "packs//governance",
      "packs/",
      "./packs",
      "packs/.",
      "packs/governance ",
      " packs/governance",
      "packs/governance.",
      ".aih/packs",
      ".AIH/packs",
      "packs/con/x",
      undefined,
      42,
      null,
    ]) {
      expect(isBoundedObservationInstallRootV1(rejected)).toBe(false);
    }
  });

  it("builds exactly one observed path per sealed file under the named root", () => {
    const mapping = requiredObservedPathsV1({
      installRoot: "packs/governance-quality/aih-gov-doctor",
      sealedFiles: sealed,
    });
    expect(mapping).toEqual([
      {
        sealedPath: "LICENSE",
        observedPath: "packs/governance-quality/aih-gov-doctor/LICENSE",
        sha256: "a".repeat(64),
        byteLength: 598,
      },
      {
        sealedPath: "SKILL.md",
        observedPath: "packs/governance-quality/aih-gov-doctor/SKILL.md",
        sha256: "b".repeat(64),
        byteLength: 787,
      },
      {
        sealedPath: "profile.json",
        observedPath: "packs/governance-quality/aih-gov-doctor/profile.json",
        sha256: "c".repeat(64),
        byteLength: 1126,
      },
    ]);
  });

  it("maps the same sealed closure under a different explicit root", () => {
    expect(
      paths(
        requiredObservedPathsV1({
          installRoot: ".claude/skills/aih-gov-doctor",
          sealedFiles: sealed,
        }),
      ),
    ).toEqual([
      ".claude/skills/aih-gov-doctor/LICENSE",
      ".claude/skills/aih-gov-doctor/SKILL.md",
      ".claude/skills/aih-gov-doctor/profile.json",
    ]);
  });

  it("orders the mapping by observed path whatever order the seal records", () => {
    expect(
      paths(requiredObservedPathsV1({ installRoot: "packs", sealedFiles: [...sealed].reverse() })),
    ).toEqual(["packs/LICENSE", "packs/SKILL.md", "packs/profile.json"]);
  });

  it("refuses a mapping it cannot build one-to-one", () => {
    expect(
      requiredObservedPathsV1({ installRoot: "../escape", sealedFiles: sealed }),
    ).toBeUndefined();
    expect(requiredObservedPathsV1({ installRoot: "packs", sealedFiles: [] })).toBeUndefined();
    expect(
      requiredObservedPathsV1({
        installRoot: "packs",
        sealedFiles: [sealed[0], sealed[0]],
      }),
    ).toBeUndefined();
    // Portable-case collisions are one installed file, never two.
    expect(
      requiredObservedPathsV1({
        installRoot: "packs",
        sealedFiles: [sealed[0], { ...sealed[1], path: "license" }],
      }),
    ).toBeUndefined();
    // A sealed path that cannot become a bounded observed path is not mappable.
    expect(
      requiredObservedPathsV1({
        installRoot: "packs",
        sealedFiles: [{ ...sealed[0], path: "../LICENSE" }],
      }),
    ).toBeUndefined();
    expect(
      requiredObservedPathsV1({
        installRoot: "packs",
        sealedFiles: [{ ...sealed[0], path: "nested/con.txt" }],
      }),
    ).toBeUndefined();
  });

  it("compares the declared set to the required set one-to-one", () => {
    const required = requiredObservedPathsV1({ installRoot: "packs", sealedFiles: sealed }) ?? [];
    expect(required).toHaveLength(3);

    expect(
      observedPathSetMatchesV1(required, ["packs/LICENSE", "packs/SKILL.md", "packs/profile.json"]),
    ).toBe(true);
    // Declaration order never matters; membership and count do.
    expect(
      observedPathSetMatchesV1(required, ["packs/profile.json", "packs/LICENSE", "packs/SKILL.md"]),
    ).toBe(true);

    // Missing.
    expect(observedPathSetMatchesV1(required, ["packs/LICENSE", "packs/SKILL.md"])).toBe(false);
    // Extra.
    expect(
      observedPathSetMatchesV1(required, [
        "packs/LICENSE",
        "packs/SKILL.md",
        "packs/profile.json",
        "packs/NOTICE",
      ]),
    ).toBe(false);
    // Duplicate substitution: the same path twice never covers a second file.
    expect(
      observedPathSetMatchesV1(required, ["packs/LICENSE", "packs/LICENSE", "packs/profile.json"]),
    ).toBe(false);
    // Renamed, even with identical bytes elsewhere: a different path is a mismatch.
    expect(
      observedPathSetMatchesV1(required, [
        "packs/LICENSE",
        "packs/SKILL.md.txt",
        "packs/profile.json",
      ]),
    ).toBe(false);
    // Another root entirely.
    expect(
      observedPathSetMatchesV1(required, ["other/LICENSE", "other/SKILL.md", "other/profile.json"]),
    ).toBe(false);
    expect(observedPathSetMatchesV1(required, [])).toBe(false);
  });
});
