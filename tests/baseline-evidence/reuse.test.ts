import { describe, expect, it } from "vitest";
import {
  decideComponentReuse,
  findPriorSource,
  formatCatalogReuseSummary,
  formatTotalReuseSummary,
  spliceReusedComponent,
  tallyReuse,
} from "../../src/baseline-evidence/reuse.js";
import type {
  BaselineComponentEvidence,
  BaselineSourceEvidence,
} from "../../src/baseline-evidence/schema.js";

function component(overrides: Partial<BaselineComponentEvidence> = {}): BaselineComponentEvidence {
  return {
    id: "skill:example",
    paths: ["skills/example"],
    treeSha256: "a".repeat(64),
    verdict: "pass",
    analyzers: [
      { name: "aih-native", version: "native.aaaaaaaaaaaa" },
      { name: "skillspector@docker", version: "rev@sha256:deadbeef" },
    ],
    findings: [],
    ...overrides,
  };
}

function source(components: BaselineComponentEvidence[]): BaselineSourceEvidence {
  return {
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: "d".repeat(40),
    components,
  };
}

const analyzerVersions = {
  "aih-native": "native.aaaaaaaaaaaa",
  "skillspector@docker": "rev@sha256:deadbeef",
  "cisco@uvx": "2.0.12",
};

describe("findPriorSource", () => {
  it("matches by (id, owner, repo), ignoring pinnedSha", () => {
    const prior = source([component()]);
    const rebound = { id: "ecc", owner: "affaan-m", repo: "ECC" };
    expect(findPriorSource({ sources: [prior] }, rebound)).toBe(prior);
    expect(findPriorSource({ sources: [prior] }, { ...rebound, repo: "OTHER" })).toBeUndefined();
    expect(findPriorSource(undefined, rebound)).toBeUndefined();
  });
});

describe("decideComponentReuse", () => {
  const priorSource = source([component()]);

  it("reuses when id, paths, treeSha256, and every required analyzer identity are unchanged", () => {
    const decision = decideComponentReuse({
      priorSource,
      component: { id: "skill:example", paths: ["skills/example"] },
      currentTreeSha256: "a".repeat(64),
      requiredAnalyzers: ["aih-native", "skillspector@docker"],
      analyzerVersions,
      full: false,
    });
    expect(decision).toMatchObject({ reuse: true, reason: "unchanged" });
    expect(decision.priorEntry?.id).toBe("skill:example");
  });

  it("declines with new-component when no prior entry shares the id", () => {
    const decision = decideComponentReuse({
      priorSource,
      component: { id: "skill:new", paths: ["skills/new"] },
      currentTreeSha256: "b".repeat(64),
      requiredAnalyzers: ["aih-native"],
      analyzerVersions,
      full: false,
    });
    expect(decision).toEqual({ reuse: false, reason: "new-component" });
  });

  it("declines with content-changed when treeSha256 differs", () => {
    const decision = decideComponentReuse({
      priorSource,
      component: { id: "skill:example", paths: ["skills/example"] },
      currentTreeSha256: "b".repeat(64),
      requiredAnalyzers: ["aih-native", "skillspector@docker"],
      analyzerVersions,
      full: false,
    });
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toBe("content-changed");
    expect(decision.priorEntry).toBeDefined();
  });

  it("declines with content-changed when declared paths differ even if the id matches", () => {
    const decision = decideComponentReuse({
      priorSource,
      component: { id: "skill:example", paths: ["skills/example", "skills/extra"] },
      currentTreeSha256: "a".repeat(64),
      requiredAnalyzers: ["aih-native", "skillspector@docker"],
      analyzerVersions,
      full: false,
    });
    expect(decision.reason).toBe("content-changed");
  });

  it("declines with analyzer-identity-changed:<name> when a required analyzer's version moved", () => {
    const decision = decideComponentReuse({
      priorSource,
      component: { id: "skill:example", paths: ["skills/example"] },
      currentTreeSha256: "a".repeat(64),
      requiredAnalyzers: ["aih-native", "skillspector@docker"],
      analyzerVersions: { ...analyzerVersions, "aih-native": "native.bbbbbbbbbbbb" },
      full: false,
    });
    expect(decision.reason).toBe("analyzer-identity-changed:aih-native");
  });

  it("declines with analyzer-identity-changed:<name> when a component newly requires an analyzer absent from the prior receipt", () => {
    const decision = decideComponentReuse({
      priorSource,
      component: { id: "skill:example", paths: ["skills/example"] },
      currentTreeSha256: "a".repeat(64),
      requiredAnalyzers: ["aih-native", "skillspector@docker", "cisco@uvx"],
      analyzerVersions,
      full: false,
    });
    expect(decision.reason).toBe("analyzer-identity-changed:cisco@uvx");
  });

  it("declines with analyzer-identity-changed:<name> when the prior receipt carries an analyzer no longer required", () => {
    const withCisco = source([
      component({
        analyzers: [...component().analyzers, { name: "cisco@uvx", version: "2.0.12" }],
      }),
    ]);
    const decision = decideComponentReuse({
      priorSource: withCisco,
      component: { id: "skill:example", paths: ["skills/example"] },
      currentTreeSha256: "a".repeat(64),
      requiredAnalyzers: ["aih-native", "skillspector@docker"],
      analyzerVersions,
      full: false,
    });
    expect(decision.reason).toBe("analyzer-identity-changed:cisco@uvx");
  });

  it("forces reason=full and declines reuse whenever full is true, even for an otherwise-identical component", () => {
    const decision = decideComponentReuse({
      priorSource,
      component: { id: "skill:example", paths: ["skills/example"] },
      currentTreeSha256: "a".repeat(64),
      requiredAnalyzers: ["aih-native", "skillspector@docker"],
      analyzerVersions,
      full: true,
    });
    expect(decision).toEqual({ reuse: false, reason: "full" });
  });

  it("never reuses a hand-crafted pass entry whose treeSha256 does not match the current tree", () => {
    const staleHashPass = source([component({ verdict: "pass", treeSha256: "c".repeat(64) })]);
    const decision = decideComponentReuse({
      priorSource: staleHashPass,
      component: { id: "skill:example", paths: ["skills/example"] },
      currentTreeSha256: "d".repeat(64),
      requiredAnalyzers: ["aih-native", "skillspector@docker"],
      analyzerVersions,
      full: false,
    });
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toBe("content-changed");
  });
});

describe("spliceReusedComponent", () => {
  it("byte-equal reconstructs a blocked component preserving verdict, count, and fingerprint", () => {
    const blocked = component({
      verdict: "blocked",
      findings: [
        { code: "trust.hidden-unicode", count: 3, detail: "3 findings; first: x" },
        { code: "trust.prompt-injection", detail: "single finding", fingerprint: "fp:1" },
      ],
    });
    const spliced = spliceReusedComponent(blocked);
    expect(spliced).toEqual(blocked);
    expect(JSON.stringify(spliced)).toBe(JSON.stringify(blocked));
  });

  it("never flips a blocked verdict to pass and never drops findings", () => {
    const blocked = component({
      verdict: "blocked",
      findings: [{ code: "trust.malicious-code", detail: "danger" }],
    });
    const spliced = spliceReusedComponent(blocked);
    expect(spliced.verdict).toBe("blocked");
    expect(spliced.findings).toEqual(blocked.findings);
  });
});

describe("tallyReuse", () => {
  it("counts every component as rescanned when there is no prior source", () => {
    const evidence = source([component(), component({ id: "skill:two" })]);
    expect(tallyReuse(undefined, evidence, false)).toEqual({ total: 2, reused: 0, rescanned: 2 });
  });

  it("counts every component as rescanned in full mode even if identical to prior", () => {
    const prior = source([component()]);
    const evidence = source([component()]);
    expect(tallyReuse(prior, evidence, true)).toEqual({ total: 1, reused: 0, rescanned: 1 });
  });

  it("counts a component as reused only when the final entry is byte-identical to the matching prior entry", () => {
    const prior = source([
      component(),
      component({
        id: "skill:two",
        verdict: "blocked",
        findings: [{ code: "trust.x", detail: "d" }],
      }),
    ]);
    const evidence = source([
      component(),
      component({
        id: "skill:two",
        treeSha256: "b".repeat(64),
        verdict: "pass",
        findings: [],
      }),
    ]);
    expect(tallyReuse(prior, evidence, false)).toEqual({ total: 2, reused: 1, rescanned: 1 });
  });
});

describe("reuse summary formatting", () => {
  it("formats a per-catalog header and per-component reason lines", () => {
    const catalog = { id: "ecc", pinnedSha: "16563d4a30f17d097cc4629f6d97e02adf823016" };
    const lines = formatCatalogReuseSummary(catalog, [
      {
        componentId: "runtime:ecc-installer",
        decision: { reuse: true, reason: "unchanged" },
        currentTreeSha256: "a".repeat(64),
        priorTreeSha256: "a".repeat(64),
        analyzerNames: ["aih-native", "skillspector@docker"],
      },
      {
        componentId: "agent:security-reviewer",
        decision: { reuse: false, reason: "content-changed" },
        currentTreeSha256: "9f02".padEnd(64, "0"),
        priorTreeSha256: "41ab".padEnd(64, "0"),
        analyzerNames: ["aih-native", "skillspector@docker"],
      },
    ]);
    expect(lines[0]).toBe("baseline reuse [ecc @ 16563d4a30f1]: reused 1/2, rescanned 1/2");
    expect(
      lines.some((line) => line.includes("reused") && line.includes("runtime:ecc-installer")),
    ).toBe(true);
    expect(
      lines.some(
        (line) =>
          line.includes("rescan") &&
          line.includes("agent:security-reviewer") &&
          line.includes("reason=content-changed"),
      ),
    ).toBe(true);
  });

  it("formats the cross-catalog TOTAL line for incremental and full modes", () => {
    expect(
      formatTotalReuseSummary(
        [
          { total: 45, reused: 44, rescanned: 1 },
          { total: 15, reused: 15, rescanned: 0 },
        ],
        false,
      ),
    ).toBe("baseline reuse TOTAL: reused 59/60, rescanned 1/60   (mode=incremental)");
    expect(formatTotalReuseSummary([{ total: 60, reused: 0, rescanned: 60 }], true)).toBe(
      "baseline reuse TOTAL: reused 0/60, rescanned 60/60   (mode=full)",
    );
  });
});
