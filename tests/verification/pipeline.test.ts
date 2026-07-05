import { describe, expect, it } from "vitest";
import {
  buildEvidenceGraph,
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
    expect(run.evidenceGraph.nodes.map((node) => node.id)).toEqual([
      "finding:exec-locality",
      "source:source:src%2Fcommands%2Frun.ts",
      "finding:docs",
      "source:file:ai-coding%2Fsetup.md",
    ]);
    expect(run.evidenceGraph.edges.map((edge) => edge.id)).toEqual([
      "edge:exec-locality:source:src%2Fcommands%2Frun.ts:exec%3Aremote",
      "edge:docs:file:ai-coding%2Fsetup.md:docs%3Asetup",
    ]);
    expect(run.summary.trustScore).toBeLessThan(100);
  });

  it("runs passes in parallel while keeping deterministic output and graph ordering", async () => {
    const completionOrder: string[] = [];
    const slowPass: VerificationPass = {
      name: "slow-docs",
      category: "doc",
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        completionOrder.push("slow-docs");
        return result("slow-docs", {
          verdict: "warn",
          severity: "low",
          category: "doc",
          evidence: [{ id: "docs:slow", type: "file", source: "README.md" }],
        });
      },
    };
    const fastPass: VerificationPass = {
      name: "fast-security",
      category: "security",
      async run() {
        completionOrder.push("fast-security");
        return result("fast-security", {
          verdict: "fail",
          severity: "critical",
          category: "security",
          evidence: [{ id: "secret", type: "file", source: "src/config.ts" }],
        });
      },
    };

    const run = await runVerificationPipeline(
      { projectRoot: "D:/repo" },
      { passes: [slowPass, fastPass], timeoutMs: 250 },
    );

    expect(completionOrder).toEqual(["fast-security", "slow-docs"]);
    expect(run.results.map((entry) => entry.passName)).toEqual(["slow-docs", "fast-security"]);
    expect(run.summary.failedPasses).toEqual(["fast-security"]);
    expect(run.evidenceGraph.nodes.map((node) => node.id)).toEqual([
      "finding:fast-security",
      "source:file:src%2Fconfig.ts",
      "finding:slow-docs",
      "source:file:README.md",
    ]);
  });

  it("builds a deterministic evidence graph with explicit findings for missing evidence", () => {
    const graph = buildEvidenceGraph([
      result("docs", {
        verdict: "warn",
        category: "doc",
        severity: "low",
      }),
      result("exec-locality", {
        verdict: "fail",
        category: "exec",
        severity: "high",
        evidence: [
          { id: "exec:remote", type: "file", source: "src/commands/run.ts", snippet: "curl" },
          { id: "exec:remote", type: "file", source: "src/commands/run.ts", snippet: "curl" },
        ],
      }),
    ]);

    expect(graph.nodes).toEqual([
      {
        id: "finding:exec-locality",
        kind: "finding",
        passName: "exec-locality",
        verdict: "fail",
        severity: "high",
        category: "exec",
        confidence: "high",
        message: "exec-locality complete",
        evidenceCount: 1,
      },
      {
        id: "source:file:src%2Fcommands%2Frun.ts",
        kind: "source",
        evidenceType: "file",
        source: "src/commands/run.ts",
      },
      {
        id: "finding:docs",
        kind: "finding",
        passName: "docs",
        verdict: "warn",
        severity: "low",
        category: "doc",
        confidence: "high",
        message: "docs complete",
        evidenceCount: 0,
      },
    ]);
    expect(graph.edges).toEqual([
      {
        id: "edge:exec-locality:file:src%2Fcommands%2Frun.ts:exec%3Aremote",
        kind: "finding-source",
        from: "finding:exec-locality",
        to: "source:file:src%2Fcommands%2Frun.ts",
        evidenceId: "exec:remote",
      },
    ]);
    expect(() => buildEvidenceGraph([])).toThrow(/buildEvidenceGraph requires at least one result/);
    expect(() => buildEvidenceGraph([result("dupe"), result("dupe")])).toThrow(
      /buildEvidenceGraph received duplicate passName: dupe/,
    );
    expect(() =>
      buildEvidenceGraph(Array.from({ length: 129 }, (_, index) => result(`result-${index}`))),
    ).toThrow(/buildEvidenceGraph received too many results: 129\/128/);
    expect(() =>
      buildEvidenceGraph([
        result("too-noisy", {
          evidence: Array.from({ length: 1_001 }, (_, index) => ({
            id: `evidence-${index}`,
            type: "file",
            source: `${index}.txt`,
          })),
        }),
      ]),
    ).toThrow(/buildEvidenceGraph received too much evidence at result 0: 1001\/1000/);
    expect(() =>
      buildEvidenceGraph([
        { ...result("bad-category"), category: "bad" } as unknown as VerificationResult,
      ]),
    ).toThrow(/buildEvidenceGraph received invalid category at result 0: bad/);
  });

  it("fails closed on malformed direct evidence graph inputs", () => {
    const oversized = "x".repeat(4097);

    expect(() => buildEvidenceGraph([result("ok")], { maxResults: 0 })).toThrow(
      /verification graph max results must be a positive integer: 0/,
    );
    expect(() => buildEvidenceGraph([result("ok")], { maxEvidencePerResult: Number.NaN })).toThrow(
      /verification graph max evidence per result must be a positive integer: NaN/,
    );
    expect(() =>
      buildEvidenceGraph([
        { ...result("bad-verdict"), verdict: "skip" } as unknown as VerificationResult,
      ]),
    ).toThrow(/buildEvidenceGraph received invalid verdict at result 0: skip/);
    expect(() =>
      buildEvidenceGraph([
        { ...result("bad-severity"), severity: "urgent" } as unknown as VerificationResult,
      ]),
    ).toThrow(/buildEvidenceGraph received invalid severity at result 0: urgent/);
    expect(() =>
      buildEvidenceGraph([
        { ...result("bad-confidence"), confidence: "sure" } as unknown as VerificationResult,
      ]),
    ).toThrow(/buildEvidenceGraph received invalid confidence at result 0: sure/);
    expect(() => buildEvidenceGraph([{ ...result("bad-message"), message: oversized }])).toThrow(
      /buildEvidenceGraph received message that is too long at result 0: 4097\/4096/,
    );
    expect(() =>
      buildEvidenceGraph([
        result("bad-snippet", {
          evidence: [{ id: "one", type: "file", source: "one.txt", snippet: oversized }],
        }),
      ]),
    ).toThrow(
      /buildEvidenceGraph received evidence\.snippet that is too long at result 0\[0\]: 4097\/4096/,
    );
    expect(() => buildEvidenceGraph([null as unknown as VerificationResult])).toThrow(
      /buildEvidenceGraph received invalid result at index 0/,
    );
    expect(() =>
      buildEvidenceGraph([
        { ...result("bad-evidence-array"), evidence: {} } as unknown as VerificationResult,
      ]),
    ).toThrow(/buildEvidenceGraph received invalid evidence at result 0/);
    expect(() =>
      buildEvidenceGraph([
        { ...result("bad-evidence-entry"), evidence: [null] } as unknown as VerificationResult,
      ]),
    ).toThrow(/buildEvidenceGraph received invalid evidence at result 0\[0\]/);
    expect(() =>
      buildEvidenceGraph([
        result("bad-surrogate", {
          evidence: [{ id: "\uD800", type: "file", source: "one.txt" }],
        }),
      ]),
    ).toThrow(/buildEvidenceGraph received malformed evidence.id at result 0/);
  });

  it("builds shared source nodes and delimiter-safe ids across findings", () => {
    const sharedSourceGraph = buildEvidenceGraph([
      result("policy/scan", {
        verdict: "fail",
        category: "policy",
        severity: "medium",
        evidence: [{ id: "rule:2", type: "file:ts", source: "src/config:settings.ts" }],
      }),
      result("security:scan", {
        verdict: "fail",
        category: "security",
        severity: "high",
        evidence: [{ id: "rule:1", type: "file:ts", source: "src/config:settings.ts" }],
      }),
    ]);

    expect(sharedSourceGraph.nodes.map((node) => node.id)).toEqual([
      "finding:security%3Ascan",
      "source:file%3Ats:src%2Fconfig%3Asettings.ts",
      "finding:policy%2Fscan",
    ]);
    expect(sharedSourceGraph.edges).toEqual([
      {
        id: "edge:security%3Ascan:file%3Ats:src%2Fconfig%3Asettings.ts:rule%3A1",
        kind: "finding-source",
        from: "finding:security%3Ascan",
        to: "source:file%3Ats:src%2Fconfig%3Asettings.ts",
        evidenceId: "rule:1",
      },
      {
        id: "edge:policy%2Fscan:file%3Ats:src%2Fconfig%3Asettings.ts:rule%3A2",
        kind: "finding-source",
        from: "finding:policy%2Fscan",
        to: "source:file%3Ats:src%2Fconfig%3Asettings.ts",
        evidenceId: "rule:2",
      },
    ]);

    const collisionGraph = buildEvidenceGraph([
      result("left", {
        evidence: [{ id: "one", type: "a:b", source: "c" }],
      }),
      result("right", {
        evidence: [{ id: "two", type: "a", source: "b:c" }],
      }),
    ]);

    expect(
      collisionGraph.nodes.filter((node) => node.kind === "source").map((node) => node.id),
    ).toEqual(["source:a%3Ab:c", "source:a:b%3Ac"]);

    const emojiGraph = buildEvidenceGraph([
      result("emoji-\u{1F600}", {
        evidence: [{ id: "smile-\u{1F600}", type: "file", source: "src/\u{1F600}.ts" }],
      }),
    ]);

    expect(emojiGraph.nodes.map((node) => node.id)).toEqual([
      "finding:emoji-%F0%9F%98%80",
      "source:file:src%2F%F0%9F%98%80.ts",
    ]);
    expect(emojiGraph.edges.map((edge) => edge.id)).toEqual([
      "edge:emoji-%F0%9F%98%80:file:src%2F%F0%9F%98%80.ts:smile-%F0%9F%98%80",
    ]);
  });

  it("keeps graph evidence deduplication aligned with merged evidence", () => {
    const results = [
      result("policy", {
        evidence: [
          { id: "same", type: "file", source: "first.txt" },
          { id: "same", type: "file", source: "second.txt" },
        ],
      }),
    ];

    const graph = buildEvidenceGraph(results);
    const summary = mergeVerificationResults(results);

    expect(summary.aggregatedEvidence).toEqual([{ id: "same", type: "file", source: "first.txt" }]);
    expect(graph.nodes.find((node) => node.kind === "finding")).toMatchObject({
      id: "finding:policy",
      evidenceCount: 1,
    });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.to).toBe("source:file:first.txt");
  });

  it("rejects malformed UTF-16 at the pipeline boundary", async () => {
    const badPass: VerificationPass = {
      name: "bad-surrogate",
      async run() {
        return result("bad-surrogate", {
          evidence: [{ id: "\uD800", type: "file", source: "one.txt" }],
        });
      },
    };

    await expect(
      runVerificationPipeline({ projectRoot: "D:/repo" }, { passes: [badPass] }),
    ).rejects.toThrow(/verification pass returned malformed evidence.id: bad-surrogate/);
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
