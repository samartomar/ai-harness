import { describe, expect, it } from "vitest";
import {
  ProjectionDecisionSchema,
  ProjectionPlannerInputSchema,
  ProjectionPlanResultSchema,
  planSyntheticProjection,
} from "../../src/methodology/projection-planner.js";

function digest(character: string): string {
  return character.repeat(64);
}

function artifact(id: string, dependencies: string[] = []): Record<string, unknown> {
  return {
    id,
    sourceLocator: `synthetic:${id}`,
    contentDigest: digest(id === "root" ? "a" : "b"),
    contentDisposition: "inert",
    linkDisposition: "none",
    licenseDisposition: "permissive",
    evidenceDigest: digest(id === "root" ? "c" : "d"),
    dependencies,
  };
}

function evidence(candidate: Record<string, unknown>): Record<string, unknown> {
  return {
    artifactId: candidate.id,
    sourceLocator: candidate.sourceLocator,
    contentDigest: candidate.contentDigest,
    licenseDisposition: candidate.licenseDisposition,
    evidenceDigest: candidate.evidenceDigest,
  };
}

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const root = artifact("root", ["dependency"]);
  const dependency = artifact("dependency");
  return {
    schemaVersion: 1,
    decisionVersion: "phase-3-decision-v1",
    classifierVersion: "phase-2-classifier-v1",
    policyVersion: "phase-3-policy-v1",
    manifestVersion: 1,
    owner: "aih-methodology",
    classifierInput: {
      schemaVersion: 1,
      requested: ["root"],
      declaredClosure: ["root", "dependency"],
      artifacts: [root, dependency],
      evidence: [evidence(root), evidence(dependency)],
    },
    mappings: [
      { artifactId: "root", target: "rules/root.md" },
      { artifactId: "dependency", target: "rules/dependency.md" },
    ],
    ...overrides,
  };
}

function manifestOf(result: ReturnType<typeof planSyntheticProjection>) {
  if (result.state !== "planned") throw new Error("expected planned synthetic projection");
  return result.manifest;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
    );
  }
  return value;
}

function maximalInput(): Record<string, unknown> {
  const ids = Array.from({ length: 64 }, (_, index) => `item-${index.toString().padStart(2, "0")}`);
  const artifacts = ids.map((id, index) => {
    const dependency = ids[index + 1];
    return artifact(id, dependency === undefined ? [] : [dependency]);
  });
  return input({
    owner: "a".repeat(64),
    classifierInput: {
      schemaVersion: 1,
      requested: [ids[0]],
      declaredClosure: ids,
      artifacts,
      evidence: artifacts.map(evidence),
    },
    mappings: ids.map((id) => ({ artifactId: id, target: `rules/${id}.md` })),
  });
}

function guardedOversizedArray(length: number, firstForbiddenIndex: number): unknown[] {
  return new Proxy(new Array(length), {
    get(target, property, receiver) {
      if (property === String(firstForbiddenIndex)) {
        throw new Error(`collection parser visited forbidden index ${firstForbiddenIndex}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function expectFailFast(parse: () => unknown): void {
  let result: unknown;
  expect(() => {
    result = parse();
  }).not.toThrow();
  expect(result).toMatchObject({ success: false });
}

describe("Phase 3 host-neutral synthetic projection planner", () => {
  it("creates a deterministic digest-bound manifest from an eligible Phase 2 decision", () => {
    const forward = planSyntheticProjection(input());
    const reversed = planSyntheticProjection(
      input({
        classifierInput: {
          ...(input().classifierInput as Record<string, unknown>),
          artifacts: [...(input().classifierInput as { artifacts: unknown[] }).artifacts].reverse(),
          evidence: [...(input().classifierInput as { evidence: unknown[] }).evidence].reverse(),
        },
        mappings: [...(input().mappings as unknown[])].reverse(),
      }),
    );

    expect(forward).toMatchObject({
      schemaVersion: 1,
      state: "planned",
      manifest: {
        schemaVersion: 1,
        digestVersion: 1,
        owner: "aih-methodology",
        entries: [
          { artifactId: "dependency", target: "rules/dependency.md" },
          { artifactId: "root", target: "rules/root.md" },
        ],
      },
      boundary: { reads: false, writes: false, cli: false, executor: false },
      findings: [],
    });
    expect(reversed).toEqual(forward);
  });

  it("is deterministic across object-key and complete decision-set permutations", () => {
    const candidate = input();
    const classifierInput = candidate.classifierInput as {
      artifacts: Array<Record<string, unknown>>;
      evidence: Array<Record<string, unknown>>;
      declaredClosure: string[];
    };
    const extra = artifact("extra");
    classifierInput.artifacts = [
      { ...classifierInput.artifacts[0], dependencies: ["extra", "dependency"] },
      classifierInput.artifacts[1] as Record<string, unknown>,
      extra,
    ];
    classifierInput.evidence.push(evidence(extra));
    classifierInput.declaredClosure = ["root", "extra", "dependency"];
    candidate.mappings = [
      { artifactId: "root", target: "rules/root.md" },
      { artifactId: "dependency", target: "rules/dependency.md" },
      { artifactId: "extra", target: "rules/extra.md" },
    ];
    const permuted = structuredClone(candidate);
    const permutedClassifier = permuted.classifierInput as {
      artifacts: Array<Record<string, unknown>>;
      evidence: Array<Record<string, unknown>>;
      declaredClosure: string[];
    };
    permutedClassifier.artifacts.reverse();
    permutedClassifier.evidence.reverse();
    permutedClassifier.declaredClosure.reverse();
    for (const item of permutedClassifier.artifacts) {
      (item.dependencies as unknown[]).reverse();
    }
    (permuted.mappings as unknown[]).reverse();

    expect(planSyntheticProjection(reverseObjectKeys(permuted))).toEqual(
      planSyntheticProjection(candidate),
    );
  });

  it.each([
    ["classifier", { classifierVersion: "phase-2-classifier-v2" }],
    ["policy", { policyVersion: "phase-3-policy-v2" }],
    ["manifest", { manifestVersion: 2 }],
  ])("rejects an unsupported %s version", (_label, override) => {
    expect(() => planSyntheticProjection(input(override))).toThrow();
  });

  it.each([
    [
      "exact target",
      [
        { artifactId: "root", target: "rules/root.md" },
        { artifactId: "dependency", target: "rules/root.md" },
      ],
    ],
    [
      "file/directory prefix",
      [
        { artifactId: "root", target: "rules" },
        { artifactId: "dependency", target: "rules/root.md" },
      ],
    ],
  ])("blocks %s collision", (_label, mappings) => {
    const result = planSyntheticProjection(input({ mappings }));

    expect(result.state).toBe("blocked");
    expect("manifest" in result).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain(
      "METHODOLOGY_TARGET_COLLISION",
    );
  });

  it("blocks ineligible classification, noncanonical target, and incomplete mapping coverage", () => {
    const executable = input();
    (
      (executable.classifierInput as { artifacts: Array<Record<string, unknown>> })
        .artifacts[0] as Record<string, unknown>
    ).contentDisposition = "executable";
    const invalidTarget = planSyntheticProjection(
      input({
        mappings: [
          { artifactId: "root", target: "../rules/root.md" },
          { artifactId: "dependency", target: "rules/dependency.md" },
        ],
      }),
    );
    const incomplete = planSyntheticProjection(
      input({ mappings: [{ artifactId: "root", target: "rules/root.md" }] }),
    );

    expect(planSyntheticProjection(executable).state).toBe("blocked");
    expect(invalidTarget.findings.map((finding) => finding.code)).toContain(
      "METHODOLOGY_TARGET_INVALID",
    );
    expect(incomplete.findings.map((finding) => finding.code)).toContain(
      "METHODOLOGY_MAPPING_COVERAGE",
    );
  });

  it("blocks every logical-target alias class and interleaved ancestor collisions", () => {
    for (const target of [
      "/outside/root.md",
      "C:/outside/root.md",
      "C:\\outside\\root.md",
      "Rules/root.md",
      "rules\\root.md",
      "rules//root.md",
      "rules/./root.md",
      "rules/../root.md",
      "rules/item.",
      "rules/item ",
      "rules/con",
      "rules/nul.txt",
      "rules/com1.txt",
      "rules/lpt9.md",
    ]) {
      const result = planSyntheticProjection(
        input({
          mappings: [
            { artifactId: "root", target },
            { artifactId: "dependency", target: "rules/dependency.md" },
          ],
        }),
      );
      expect(result.findings.map((finding) => finding.code)).toContain(
        "METHODOLOGY_TARGET_INVALID",
      );
    }
    const candidate = input();
    const classifierInput = candidate.classifierInput as {
      artifacts: Array<Record<string, unknown>>;
      evidence: Array<Record<string, unknown>>;
      declaredClosure: string[];
    };
    const extra = artifact("extra");
    const dependency = classifierInput.artifacts[1];
    if (dependency === undefined) throw new Error("test fixture lost its dependency artifact");
    classifierInput.artifacts = [
      { ...classifierInput.artifacts[0], dependencies: ["dependency", "extra"] },
      dependency,
      extra,
    ];
    classifierInput.evidence.push(evidence(extra));
    classifierInput.declaredClosure = ["root", "dependency", "extra"];
    candidate.mappings = [
      { artifactId: "root", target: "rules" },
      { artifactId: "dependency", target: "rules-a" },
      { artifactId: "extra", target: "rules/root.md" },
    ];

    const interleaved = planSyntheticProjection(candidate);

    expect(interleaved.findings.map((finding) => finding.code)).toContain(
      "METHODOLOGY_TARGET_COLLISION",
    );
  });

  it("binds every decision-critical field into the manifest digest", () => {
    const baseline = planSyntheticProjection(input());
    const mutations = [
      input({ owner: "other-owner" }),
      input({
        mappings: [
          { artifactId: "root", target: "rules/other.md" },
          { artifactId: "dependency", target: "rules/dependency.md" },
        ],
      }),
    ].map(planSyntheticProjection);

    for (const mutation of mutations) {
      expect(mutation.state).toBe("planned");
      expect(manifestOf(mutation).digest).not.toBe(manifestOf(baseline).digest);
    }
  });

  it("changes the digest when evidence or an otherwise-equivalent closure edge changes", () => {
    const evidenceChanged = input();
    const evidenceInput = evidenceChanged.classifierInput as {
      artifacts: Array<Record<string, unknown>>;
      evidence: Array<Record<string, unknown>>;
    };
    evidenceInput.artifacts[0] = { ...evidenceInput.artifacts[0], contentDigest: digest("e") };
    evidenceInput.evidence[0] = { ...evidenceInput.evidence[0], contentDigest: digest("e") };

    const edgeInput = input();
    const classifierInput = edgeInput.classifierInput as {
      artifacts: Array<Record<string, unknown>>;
      evidence: Array<Record<string, unknown>>;
      declaredClosure: string[];
    };
    const extra = artifact("extra");
    classifierInput.artifacts = [
      { ...classifierInput.artifacts[0], dependencies: ["dependency", "extra"] },
      { ...classifierInput.artifacts[1], dependencies: ["extra"] },
      extra,
    ];
    classifierInput.evidence.push(evidence(extra));
    classifierInput.declaredClosure = ["root", "dependency", "extra"];
    edgeInput.mappings = [
      ...(edgeInput.mappings as unknown[]),
      { artifactId: "extra", target: "rules/extra.md" },
    ];
    const withoutRedundantEdge = structuredClone(edgeInput);
    (
      (withoutRedundantEdge.classifierInput as { artifacts: Array<Record<string, unknown>> })
        .artifacts[1] as Record<string, unknown>
    ).dependencies = [];

    const baseline = planSyntheticProjection(input());
    const evidencePlan = planSyntheticProjection(evidenceChanged);
    const edgePlan = planSyntheticProjection(edgeInput);
    const edgeMutationPlan = planSyntheticProjection(withoutRedundantEdge);

    expect(manifestOf(evidencePlan).digest).not.toBe(manifestOf(baseline).digest);
    expect(manifestOf(edgePlan).digest).not.toBe(manifestOf(edgeMutationPlan).digest);
  });

  it("keeps result schemas closed and disallows forged planned records", () => {
    const planned = planSyntheticProjection(input());
    const manifest = manifestOf(planned);

    expect(() => ProjectionPlanResultSchema.parse({ ...planned, unexpected: true })).toThrow();
    expect(() =>
      ProjectionPlanResultSchema.parse({
        ...planned,
        state: "planned",
        findings: [{ code: "METHODOLOGY_TARGET_COLLISION" }],
      }),
    ).toThrow();
    expect(() =>
      ProjectionPlanResultSchema.parse({
        ...planned,
        manifest: { ...manifest, digest: digest("f") },
      }),
    ).toThrow();
    expect(() =>
      ProjectionPlanResultSchema.parse({
        ...planned,
        manifest: {
          ...manifest,
          decision: { ...manifest.decision, closure: ["root"] },
        },
      }),
    ).toThrow();
    expect(() =>
      ProjectionPlanResultSchema.parse({
        ...planned,
        manifest: { ...manifest, entries: [...manifest.entries].reverse() },
      }),
    ).toThrow();
    expect(() =>
      ProjectionPlanResultSchema.parse({
        ...planned,
        manifest: {
          ...manifest,
          entries: [
            { ...manifest.entries[0], target: "rules/a" },
            { ...manifest.entries[1], target: "rules/a/b" },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      ProjectionPlanResultSchema.parse({
        ...planned,
        manifest: {
          ...manifest,
          entries: [
            { ...manifest.entries[0], artifactId: "root", target: "rules/a" },
            { ...manifest.entries[1], artifactId: "root", target: "rules/b" },
          ],
        },
      }),
    ).toThrow();
  });

  it("rejects forged blocked findings with fixed cardinality and no attribution", () => {
    const blocked = planSyntheticProjection(
      input({
        mappings: [
          { artifactId: "root", target: "../rules/root.md" },
          { artifactId: "dependency", target: "rules/dependency.md" },
        ],
      }),
    );
    if (blocked.state !== "blocked") throw new Error("expected blocked synthetic projection");

    expect(() =>
      ProjectionPlanResultSchema.parse({
        ...blocked,
        findings: [blocked.findings[0], blocked.findings[0]],
      }),
    ).toThrow();
    expect(() =>
      ProjectionPlanResultSchema.parse({
        ...blocked,
        findings: [{ ...blocked.findings[0], artifactId: "root" }],
      }),
    ).toThrow();
  });

  it("rejects oversized planner and nested classifier collections before traversal", () => {
    const plannerCases: Array<[string, number, number]> = [
      ["requested", 33, 32],
      ["declaredClosure", 65, 64],
      ["artifacts", 65, 64],
      ["evidence", 65, 64],
    ];
    for (const [field, length, forbidden] of plannerCases) {
      const candidate = input();
      (candidate.classifierInput as Record<string, unknown>)[field] = guardedOversizedArray(
        length,
        forbidden,
      );
      expectFailFast(() => ProjectionPlannerInputSchema.safeParse(candidate));
    }

    const dependencies = input();
    (
      (dependencies.classifierInput as { artifacts: Array<Record<string, unknown>> }).artifacts[0] as
        | Record<string, unknown>
        | undefined
    )!.dependencies = guardedOversizedArray(33, 32);
    expectFailFast(() => ProjectionPlannerInputSchema.safeParse(dependencies));

    const mappings = input({ mappings: guardedOversizedArray(65, 64) });
    expectFailFast(() => ProjectionPlannerInputSchema.safeParse(mappings));
  });

  it("rejects oversized decision and result collections before traversal", () => {
    const planned = planSyntheticProjection(input());
    const manifest = manifestOf(planned);
    for (const field of ["closure", "eligible", "mappings", "entries"] as const) {
      expectFailFast(() =>
        ProjectionDecisionSchema.safeParse({
          ...manifest.decision,
          [field]: guardedOversizedArray(65, 64),
        }),
      );
    }
    expectFailFast(() =>
      ProjectionDecisionSchema.safeParse({
        ...manifest.decision,
        classifierInput: {
          ...manifest.decision.classifierInput,
          artifacts: guardedOversizedArray(65, 64),
        },
      }),
    );
    expectFailFast(() =>
      ProjectionPlanResultSchema.safeParse({
        ...planned,
        manifest: { ...manifest, entries: guardedOversizedArray(65, 64) },
      }),
    );

    const blocked = planSyntheticProjection(
      input({ mappings: [{ artifactId: "root", target: "rules/root.md" }] }),
    );
    expectFailFast(() =>
      ProjectionPlanResultSchema.safeParse({
        ...blocked,
        findings: guardedOversizedArray(2, 1),
      }),
    );
  });

  it("accepts exact resource maxima and rejects the first value beyond each bound", () => {
    const maximal = maximalInput();
    const maximalResult = planSyntheticProjection(maximal);
    const exactTarget = planSyntheticProjection(
      input({
        mappings: [
          { artifactId: "root", target: "a".repeat(240) },
          { artifactId: "dependency", target: "rules/dependency.md" },
        ],
      }),
    );

    expect(maximalResult.state).toBe("planned");
    expect(manifestOf(maximalResult).entries).toHaveLength(64);
    expect(exactTarget.state).toBe("planned");
    expect(() =>
      planSyntheticProjection({
        ...maximal,
        mappings: [
          ...(maximal.mappings as unknown[]),
          { artifactId: "overflow", target: "rules/overflow.md" },
        ],
      }),
    ).toThrow();
    expect(() =>
      planSyntheticProjection(
        input({
          mappings: [
            { artifactId: "root", target: "a".repeat(241) },
            { artifactId: "dependency", target: "rules/dependency.md" },
          ],
        }),
      ),
    ).toThrow();
    expect(() => planSyntheticProjection(input({ owner: "a".repeat(65) }))).toThrow();
  });
});
