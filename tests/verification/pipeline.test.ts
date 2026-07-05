import { describe, expect, it } from "vitest";
import {
  mergeVerificationResults,
  runVerificationPipeline,
  type VerificationPass,
  VerificationRegistry,
  type VerificationRegistrySelection,
  type VerificationResult,
} from "../../src/index.js";

function result(
  passName: string,
  overrides: Partial<Omit<VerificationResult, "passName">> = {},
): VerificationResult {
  return {
    passName,
    verdict: overrides.verdict ?? "pass",
    severity: overrides.severity ?? "info",
    confidence: overrides.confidence ?? "high",
    evidence: overrides.evidence ?? [],
    message: overrides.message ?? `${passName} complete`,
    category: overrides.category ?? "other",
  };
}

function verificationPass(
  name: string,
  output: VerificationResult,
  options: Pick<VerificationPass, "category" | "projectTypes"> = {},
): VerificationPass {
  return {
    name,
    category: options.category,
    projectTypes: options.projectTypes,
    async run() {
      return output;
    },
  };
}

describe("verification pipeline core", () => {
  it("registers, filters, and selects passes in a deterministic order", () => {
    const registry = new VerificationRegistry();
    registry.register(
      verificationPass("policy", result("policy", { category: "policy" }), {
        category: "policy",
        projectTypes: ["node"],
      }),
    );
    registry.register(
      verificationPass("docs", result("docs", { category: "doc" }), {
        category: "doc",
        projectTypes: ["node", "python"],
      }),
    );
    registry.register(
      verificationPass("deps", result("deps", { category: "dependency" }), {
        category: "dependency",
        projectTypes: ["python"],
      }),
    );

    expect(registry.list({ projectType: "node" }).map((pass) => pass.name)).toEqual([
      "policy",
      "docs",
    ]);
    const selection: VerificationRegistrySelection = {
      names: ["docs", "policy"],
      projectType: "node",
    };
    expect(registry.select(selection).map((pass) => pass.name)).toEqual(["docs", "policy"]);
    expect(() => registry.register(verificationPass("policy", result("policy")))).toThrow(
      /verification pass already registered: policy/,
    );
    expect(() =>
      registry.register(verificationPass("x".repeat(4097), result("x".repeat(4097)))),
    ).toThrow(/verification pass name is too long: 4097\/4096/);
    expect(() => registry.select({ names: ["deps"], projectType: "node" })).toThrow(
      /verification pass is not enabled for project type node: deps/,
    );
  });

  it("runs selected passes and returns merged structured evidence", async () => {
    const passes = [
      verificationPass(
        "docs",
        result("docs", {
          verdict: "warn",
          severity: "low",
          category: "doc",
          evidence: [{ id: "docs:setup", type: "file", source: "ai-coding/setup.md" }],
        }),
        { category: "doc" },
      ),
      verificationPass(
        "exec-locality",
        result("exec-locality", {
          verdict: "fail",
          severity: "high",
          category: "exec",
          evidence: [
            { id: "exec:remote", type: "source", source: "src/commands/run.ts", snippet: "curl" },
          ],
        }),
        { category: "exec" },
      ),
    ];

    const run = await runVerificationPipeline(
      { projectRoot: "D:/repo", projectType: "node" },
      { passes },
    );

    expect(run.results.map((entry) => entry.passName)).toEqual(["docs", "exec-locality"]);
    expect(run.summary.finalVerdict).toBe("fail");
    expect(run.summary.failedPasses).toEqual(["exec-locality"]);
    expect(run.summary.warnings).toEqual(["docs"]);
    expect(run.summary.aggregatedEvidence.map((evidence) => evidence.id)).toEqual([
      "exec:remote",
      "docs:setup",
    ]);
    expect(run.summary.trustScore).toBeLessThan(100);
  });

  it("fails closed when no passes are selected", async () => {
    await expect(
      runVerificationPipeline({ projectRoot: "D:/repo" }, { passes: [] }),
    ).rejects.toThrow(/runVerificationPipeline requires at least one pass/);
  });

  it("fails closed when too many passes are selected", async () => {
    const passes = Array.from({ length: 129 }, (_, index) =>
      verificationPass(`pass-${index}`, result(`pass-${index}`)),
    );

    await expect(runVerificationPipeline({ projectRoot: "D:/repo" }, { passes })).rejects.toThrow(
      /runVerificationPipeline received too many passes: 129\/128/,
    );
  });

  it("fails closed when a pass returns malformed output", async () => {
    const badPass: VerificationPass = {
      name: "bad",
      async run() {
        return { ...result("bad"), verdict: "skip" } as unknown as VerificationResult;
      },
    };

    await expect(
      runVerificationPipeline({ projectRoot: "D:/repo" }, { passes: [badPass] }),
    ).rejects.toThrow(/verification pass returned invalid verdict: bad -> skip/);
  });

  it("fails closed when a pass returns a null category", async () => {
    const badPass: VerificationPass = {
      name: "bad-category",
      async run() {
        return { ...result("bad-category"), category: null } as unknown as VerificationResult;
      },
    };

    await expect(
      runVerificationPipeline({ projectRoot: "D:/repo" }, { passes: [badPass] }),
    ).rejects.toThrow(/verification pass returned invalid category: bad-category -> null/);
  });

  it("fails closed when a pass returns oversized string fields", async () => {
    const oversizedPass: VerificationPass = {
      name: "oversized",
      async run() {
        return result("oversized", {
          evidence: [{ id: "x".repeat(4097), type: "file", source: "source.txt" }],
        });
      },
    };

    await expect(
      runVerificationPipeline({ projectRoot: "D:/repo" }, { passes: [oversizedPass] }),
    ).rejects.toThrow(/verification pass returned evidence.id that is too long/);
  });

  it("fails closed when a pass returns too much evidence", async () => {
    const noisyPass: VerificationPass = {
      name: "noisy",
      async run() {
        return result("noisy", {
          evidence: [
            { id: "one", type: "file", source: "one.txt" },
            { id: "two", type: "file", source: "two.txt" },
            { id: "three", type: "file", source: "three.txt" },
          ],
        });
      },
    };

    await expect(
      runVerificationPipeline(
        { projectRoot: "D:/repo" },
        { passes: [noisyPass], maxEvidencePerPass: 2 },
      ),
    ).rejects.toThrow(/verification pass returned too much evidence: noisy -> 3\/2/);
  });

  it("fails closed on invalid evidence limits", async () => {
    await expect(
      runVerificationPipeline(
        { projectRoot: "D:/repo" },
        { passes: [verificationPass("docs", result("docs"))], maxEvidencePerPass: 0 },
      ),
    ).rejects.toThrow(/verification max evidence per pass must be a positive integer: 0/);
  });

  it("merges caller abort signals into pass input", async () => {
    const controller = new AbortController();
    let passSignal: AbortSignal | undefined;
    const abortAwarePass: VerificationPass = {
      name: "abort-aware",
      async run(input) {
        passSignal = input.signal;
        controller.abort();
        return result("abort-aware");
      },
    };

    await runVerificationPipeline(
      { projectRoot: "D:/repo", signal: controller.signal },
      { passes: [abortAwarePass] },
    );

    expect(passSignal?.aborted).toBe(true);
  });

  it("turns ignored pass timeouts into fail results", async () => {
    let passSignal: AbortSignal | undefined;
    const slowPass: VerificationPass = {
      name: "slow",
      category: "exec",
      async run(input) {
        passSignal = input.signal;
        return new Promise<VerificationResult>(() => {});
      },
    };

    const run = await runVerificationPipeline(
      { projectRoot: "D:/repo" },
      { passes: [slowPass], timeoutMs: 1 },
    );

    expect(run.results).toEqual([
      {
        passName: "slow",
        verdict: "fail",
        severity: "high",
        confidence: "high",
        evidence: [],
        message: "verification pass timed out after 1ms",
        category: "exec",
      },
    ]);
    expect(run.summary.finalVerdict).toBe("fail");
    expect(run.summary.failedPasses).toEqual(["slow"]);
    expect(passSignal?.aborted).toBe(true);
  });

  it("turns pass exceptions into fail results without leaking error text", async () => {
    const throwingPass: VerificationPass = {
      name: "throws",
      category: "security",
      async run() {
        throw new Error("SECRET_TOKEN=123");
      },
    };

    const run = await runVerificationPipeline(
      { projectRoot: "D:/repo" },
      { passes: [throwingPass] },
    );

    expect(run.results).toEqual([
      {
        passName: "throws",
        verdict: "fail",
        severity: "high",
        confidence: "high",
        evidence: [],
        message: "verification pass threw before returning a result",
        category: "security",
      },
    ]);
    expect(run.results[0]?.message).not.toContain("SECRET_TOKEN");
    expect(run.summary.finalVerdict).toBe("fail");
  });

  it("keeps synthetic fail results valid for bad runtime pass categories", async () => {
    const throwingPass: VerificationPass = {
      name: "bad-runtime-category",
      category: "bad-category" as unknown as VerificationPass["category"],
      async run() {
        throw new Error("boom");
      },
    };

    const run = await runVerificationPipeline(
      { projectRoot: "D:/repo" },
      { passes: [throwingPass] },
    );

    expect(run.results[0]?.category).toBe("other");
    expect(run.summary.finalVerdict).toBe("fail");
  });

  it("fails fast when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const pass: VerificationPass = {
      name: "pre-aborted",
      async run() {
        called = true;
        return result("pre-aborted");
      },
    };

    const run = await runVerificationPipeline(
      { projectRoot: "D:/repo", signal: controller.signal },
      { passes: [pass] },
    );

    expect(called).toBe(false);
    expect(run.results).toEqual([
      {
        passName: "pre-aborted",
        verdict: "fail",
        severity: "high",
        confidence: "high",
        evidence: [],
        message: "verification pipeline aborted before pass completed",
        category: "other",
      },
    ]);
    expect(run.summary.finalVerdict).toBe("fail");
  });

  it("sorts merge output by verdict, category priority, severity, then pass name", () => {
    expect(() => mergeVerificationResults([])).toThrow(
      /mergeVerificationResults requires at least one result/,
    );
    expect(() =>
      mergeVerificationResults([
        { ...result("bad"), verdict: "skip" } as unknown as VerificationResult,
      ]),
    ).toThrow(/mergeVerificationResults received invalid verdict at result 0: skip/);
    const summary = mergeVerificationResults([
      result("docs", { verdict: "fail", category: "doc", severity: "critical" }),
      result("policy", { verdict: "fail", category: "policy", severity: "low" }),
      result("exec", { verdict: "fail", category: "exec", severity: "medium" }),
      result("dependency", { verdict: "warn", category: "dependency", severity: "high" }),
    ]);

    expect(summary.finalVerdict).toBe("fail");
    expect(summary.failedPasses).toEqual(["exec", "policy", "docs"]);
    expect(summary.warnings).toEqual(["dependency"]);
    expect(mergeVerificationResults([result("ok", { severity: "critical" })]).trustScore).toBe(100);
    expect(
      mergeVerificationResults([
        result("a-pass", { verdict: "fail", category: "doc", severity: "low" }),
        result("B-pass", { verdict: "fail", category: "doc", severity: "low" }),
      ]).failedPasses,
    ).toEqual(["B-pass", "a-pass"]);
    expect(
      mergeVerificationResults([
        result("policy", {
          evidence: [{ id: "shared", type: "file", source: "policy.json" }],
        }),
        result("docs", {
          evidence: [{ id: "shared", type: "file", source: "README.md" }],
        }),
      ]).aggregatedEvidence.map((evidence) => evidence.source),
    ).toEqual(["README.md", "policy.json"]);
  });
});
