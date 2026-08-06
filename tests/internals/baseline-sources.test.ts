import { describe, expect, it } from "vitest";
import {
  BASELINE_OPTION,
  BASELINE_SOURCES,
  baselineSourceIds,
  describeBaselineSource,
  resolveBaselineSource,
} from "../../src/internals/baseline-sources.js";

describe("baseline source registry", () => {
  it("ships the v1 selectable baselines with pinned delegated sources", () => {
    // The registry ships ecc only.
    expect(BASELINE_SOURCES.map((s) => s.id)).toEqual(["ecc"]);
    for (const source of BASELINE_SOURCES) {
      expect(source.sources.length).toBeGreaterThan(0);
      for (const repo of source.sources) {
        expect(repo.owner).toMatch(/^[A-Za-z0-9_.-]+$/);
        expect(repo.repo).toMatch(/^[A-Za-z0-9_.-]+$/);
        expect(repo.pinnedSha).toMatch(/^[a-f0-9]{40}$/);
      }
    }
  });

  it("derives valid --baseline choices from the registry", () => {
    expect(BASELINE_OPTION.description).toContain(baselineSourceIds().join("|"));
    expect(
      baselineSourceIds([
        ...BASELINE_SOURCES,
        {
          id: "example",
          label: "Example baseline",
          sources: [{ owner: "example", repo: "rules", pinnedSha: "a".repeat(40) }],
          installVerb: "follow example/rules",
        },
      ]),
    ).toContain("example");
  });

  it("resolves absent baselines to ecc and rejects unknown ids", () => {
    expect(resolveBaselineSource({}).id).toBe("ecc");
    expect(resolveBaselineSource({ baseline: "ecc" }).id).toBe("ecc");
    expect(() => resolveBaselineSource({ baseline: "gstack" })).toThrow(
      'unsupported legacy configuration "gstack"; migrate to a supported framework before continuing',
    );
    expect(() => resolveBaselineSource({ baseline: "missing" })).toThrow(/unknown --baseline/);
  });

  it("describes delegated sources with owner/repo and short pins", () => {
    const source = resolveBaselineSource({ baseline: "ecc" });
    expect(source.sources).toEqual([
      {
        owner: "affaan-m",
        repo: "ecc",
        pinnedSha: "623f2c020f052319657674e4e6c29ab5d0ad566b",
      },
      {
        owner: "obra",
        repo: "Superpowers",
        pinnedSha: "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9",
      },
    ]);
    expect(describeBaselineSource(source)).toContain("affaan-m/ecc@");
  });
});
