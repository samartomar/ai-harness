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
    // gsd was removed from the selectable baselines by the 2026-07-22 scope
    // decision (see the D3 amendments); the registry ships ecc + gstack.
    expect(BASELINE_SOURCES.map((s) => s.id)).toEqual(["ecc", "gstack"]);
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
    expect(resolveBaselineSource({ baseline: "gstack" }).id).toBe("gstack");
    expect(() => resolveBaselineSource({ baseline: "missing" })).toThrow(/unknown --baseline/);
  });

  it("describes delegated sources with owner/repo and short pins", () => {
    expect(describeBaselineSource(resolveBaselineSource({ baseline: "gstack" }))).toContain(
      "garrytan/gstack@",
    );
  });
});
