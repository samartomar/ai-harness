import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AihError } from "../../src/errors.js";
import { executePlan, summarizeResult } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/report/index.js";
import { aggregateOrg, type OrgDigestData, parseOrgAnalytics } from "../../src/report/org.js";
import { cacheSavings } from "../../src/report/pricing.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-report-org-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    ...over,
  };
}

/** A combined export as `fetch-analytics.mjs --run` would emit it. */
const EXPORT = {
  usage_report: {
    data: [
      {
        model: "claude-opus-4-8",
        uncached_input_tokens: 1_000_000,
        cache_read_input_tokens: 9_000_000,
        cache_creation_input_tokens: 500_000,
        output_tokens: 200_000,
        estimated_cost: 50,
        tool_actions: { edit: { accepted: 80, rejected: 20 } },
      },
      {
        model: "claude-sonnet-4-6",
        uncached_input_tokens: 2_000_000,
        cache_read_input_tokens: 3_000_000,
        cache_creation_input_tokens: 100_000,
        output_tokens: 400_000,
        estimated_cost: 10,
      },
    ],
  },
  skills: {
    data: [
      { skill_name: "unit-test-generation", distinct_user_count: 40, session_count: 320 },
      { skill_name: "codebase-refactoring", distinct_user_count: 5, session_count: 12 },
    ],
  },
};

describe("parseOrgAnalytics", () => {
  it("sums tokens across records and groups by model (largest first)", () => {
    const a = parseOrgAnalytics(EXPORT);
    expect(a.records).toBe(2);
    expect(a.tokens).toEqual({
      input: 3_000_000,
      output: 600_000,
      cacheRead: 12_000_000,
      cacheCreation: 600_000,
    });
    expect(a.byModel.map((m) => m.model)).toEqual(["claude-opus-4-8", "claude-sonnet-4-6"]);
  });

  it("sums estimated cost and folds tool-action accept/reject", () => {
    const a = parseOrgAnalytics(EXPORT);
    expect(a.estimatedCostUsd).toBe(60);
    expect(a.toolActions).toEqual({ accepted: 80, rejected: 20 });
  });

  it("ranks skills by distinct users", () => {
    const a = parseOrgAnalytics(EXPORT);
    expect(a.skills.map((s) => s.name)).toEqual(["unit-test-generation", "codebase-refactoring"]);
    expect(a.skills[0]).toEqual({ name: "unit-test-generation", users: 40, sessions: 320 });
  });

  it("tolerates alternate token field names and a bare array", () => {
    const a = parseOrgAnalytics({
      usage_report: [{ model: "x", input_tokens: 100, cacheRead: 50 }],
    });
    expect(a.records).toBe(1);
    expect(a.tokens.input).toBe(100);
    expect(a.tokens.cacheRead).toBe(50);
  });

  it("flattens a nested {data:[{results:[…]}]} shape", () => {
    const a = parseOrgAnalytics({
      usage_report: { data: [{ results: [{ model: "claude-opus-4-8", input_tokens: 7 }] }] },
    });
    expect(a.records).toBe(1);
    expect(a.tokens.input).toBe(7);
  });

  it("returns empty, safe results for garbage / missing input", () => {
    for (const bad of [null, {}, { usage_report: {} }, 42, "nope"]) {
      const a = parseOrgAnalytics(bad);
      expect(a.records).toBe(0);
      expect(a.skills).toEqual([]);
      expect(a.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    }
  });
});

describe("cacheSavings", () => {
  it("nets the write premium out of the read win, per model", () => {
    const a = parseOrgAnalytics(EXPORT);
    const s = cacheSavings(a.byModel, a.tokens);
    expect(s.efficiency).toBeCloseTo(0.8, 5); // 12M / (12M + 3M), rate-independent
    // Opus 4.5 ($5/$0.5/$6.25), Sonnet 4.5 ($3/$0.3/$3.75):
    expect(s.grossAvoidedUsd).toBeCloseTo(48.6, 4); // opus 40.5 + sonnet 8.1
    expect(s.writePremiumUsd).toBeCloseTo(0.7, 4); // opus 0.625 + sonnet 0.075
    expect(s.netSavedUsd).toBeCloseTo(47.9, 4);
    expect(s.unpricedModels).toEqual([]);
  });

  it("counts unpriced models in the percent but excludes them from the dollars", () => {
    const byModel = [
      {
        model: "mystery-model",
        tokens: { input: 100, output: 0, cacheRead: 900, cacheCreation: 0 },
      },
    ];
    const totals = { input: 100, output: 0, cacheRead: 900, cacheCreation: 0 };
    const s = cacheSavings(byModel, totals);
    expect(s.efficiency).toBeCloseTo(0.9, 5);
    expect(s.grossAvoidedUsd).toBe(0);
    expect(s.unpricedModels).toEqual(["mystery-model"]);
  });

  it("aggregateOrg attaches savings to the parsed analytics", () => {
    const d = aggregateOrg(EXPORT);
    expect(d.records).toBe(2);
    expect(d.savings.netSavedUsd).toBeCloseTo(47.9, 4);
  });
});

describe("report --org command", () => {
  function writeExport(): string {
    writeFileSync(join(dir, "org.json"), JSON.stringify(EXPORT));
    return "org.json";
  }

  it("emits an org digest with headline, skills, cache efficiency, and structured data", async () => {
    const file = writeExport();
    const d = (await command.plan(ctx({ options: { org: file } }))).actions.find(
      (a) => a.kind === "digest",
    );
    if (d?.kind !== "digest") throw new Error("expected a digest action");
    expect(d.describe).toContain("Org usage");
    expect(d.text).toContain("unit-test-generation");
    expect(d.text).toContain("80%"); // org-wide cache efficiency
    // per-model sub-panel: opus cache-served = 9M / (9M + 1M)
    expect(d.text).toContain("By model");
    expect(d.text).toContain("claude-opus-4-8");
    expect(d.text).toContain("90% cache-served");
    expect(d.data).toMatchObject({ records: 2 });
    const data = d.data as OrgDigestData;
    expect(data.savings.efficiency).toBeCloseTo(0.8, 5);
  });

  it("surfaces the org digest through the executor + summary (the --json data path)", async () => {
    const file = writeExport();
    const c = ctx({ options: { org: file } });
    const result = await executePlan(await command.plan(c), c);
    expect(result.digests).toHaveLength(1);
    expect(result.digests[0]?.data).toMatchObject({ records: 2 });
    expect(summarizeResult(result)).toContain("Top skills");
  });

  it("throws a clean AihError when the --org export is missing", async () => {
    await expect(command.plan(ctx({ options: { org: "does-not-exist.json" } }))).rejects.toThrow(
      AihError,
    );
  });

  it("throws a clean AihError when the --org export is not JSON", async () => {
    writeFileSync(join(dir, "bad.json"), "{ not json");
    await expect(command.plan(ctx({ options: { org: "bad.json" } }))).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("still defaults to the local context footprint when no --org is given", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "x".repeat(40));
    const d = (await command.plan(ctx())).actions.find((a) => a.kind === "digest");
    if (d?.kind !== "digest") throw new Error("expected a digest action");
    expect(d.describe).toContain("Context footprint");
  });
});
