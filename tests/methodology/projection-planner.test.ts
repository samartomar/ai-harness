import { describe, expect, it } from "vitest";
import {
  ProjectionDecisionSchema,
  ProjectionMappingSchema,
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

function statefulOversizedArray(
  values: unknown[],
  reportedMaximum: number,
  allowedLengthReads: number,
): unknown[] {
  let lengthReads = 0;
  return new Proxy(values, {
    get(target, property, receiver) {
      if (property === "length") {
        lengthReads += 1;
        return lengthReads <= allowedLengthReads ? reportedMaximum : target.length;
      }
      if (property === String(reportedMaximum)) {
        throw new Error(`stateful collection parser visited forbidden index ${reportedMaximum}`);
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
    ["decision", { decisionVersion: "phase-3-decision-v2" }],
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

  it("does not treat lexically similar sibling targets as a collision", () => {
    const result = planSyntheticProjection(
      input({
        mappings: [
          { artifactId: "root", target: "rules" },
          { artifactId: "dependency", target: "rules-a" },
        ],
      }),
    );

    expect(result.state).toBe("planned");
  });

  it("blocks ineligible classification, duplicate requests, invalid targets, and incomplete mappings", () => {
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
    const duplicateRequest = input();
    (
      duplicateRequest.classifierInput as {
        requested: string[];
      }
    ).requested = ["root", "root"];

    expect(planSyntheticProjection(executable).state).toBe("blocked");
    expect(planSyntheticProjection(duplicateRequest).state).toBe("blocked");
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
    const firstArtifact = (
      dependencies.classifierInput as { artifacts: Array<Record<string, unknown>> }
    ).artifacts[0];
    if (firstArtifact === undefined) throw new Error("test fixture lost its root artifact");
    firstArtifact.dependencies = guardedOversizedArray(33, 32);
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

  it("rejects state-changing proxy collections and records before schema traversal", () => {
    const maximal = maximalInput();
    const maximalPlan = planSyntheticProjection(maximal);
    const maximalManifest = manifestOf(maximalPlan);
    const mappings = [...(maximal.mappings as unknown[])];
    const firstMapping = mappings[0];
    if (firstMapping === undefined) throw new Error("maximal fixture lost its first mapping");
    mappings.push(firstMapping);
    expectFailFast(() =>
      ProjectionPlannerInputSchema.safeParse({
        ...maximal,
        mappings: statefulOversizedArray(mappings, 64, 1),
      }),
    );

    const evidence = [...maximalManifest.decision.classifierInput.evidence];
    const firstEvidence = evidence[0];
    if (firstEvidence === undefined) throw new Error("maximal fixture lost its first evidence");
    evidence.push(firstEvidence);
    expectFailFast(() =>
      ProjectionDecisionSchema.safeParse({
        ...maximalManifest.decision,
        classifierInput: {
          ...maximalManifest.decision.classifierInput,
          evidence: statefulOversizedArray(evidence, 64, 1),
        },
      }),
    );

    const entries = [...maximalManifest.entries];
    const firstEntry = entries[0];
    if (firstEntry === undefined) throw new Error("maximal fixture lost its first entry");
    entries.push(firstEntry);
    expectFailFast(() =>
      ProjectionPlanResultSchema.safeParse({
        ...maximalPlan,
        manifest: {
          ...maximalManifest,
          entries: statefulOversizedArray(entries, 64, 1),
        },
      }),
    );

    const nestedDependencyPlan = structuredClone(maximalPlan);
    const nestedManifest = manifestOf(nestedDependencyPlan);
    const firstArtifact = nestedManifest.decision.classifierInput.artifacts[0];
    if (firstArtifact === undefined) throw new Error("maximal fixture lost its first artifact");
    firstArtifact.dependencies = statefulOversizedArray(
      Array.from({ length: 33 }, () => "item-01"),
      32,
      2,
    ) as string[];
    expectFailFast(() => ProjectionPlanResultSchema.safeParse(nestedDependencyPlan));

    const proxiedInput = new Proxy(input(), {
      get() {
        throw new Error("planner schema read a proxied root record");
      },
    });
    expectFailFast(() => ProjectionPlannerInputSchema.safeParse(proxiedInput));

    const accessorInput = input();
    Object.defineProperty(accessorInput, "mappings", {
      enumerable: true,
      get() {
        throw new Error("planner schema invoked an accessor-backed field");
      },
    });
    expectFailFast(() => ProjectionPlannerInputSchema.safeParse(accessorInput));
  });

  it("rejects sparse or inherited-accessor inputs without invoking inherited code", () => {
    let inheritedReads = 0;
    const inheritedMappings = Object.create({
      get mappings() {
        inheritedReads += 1;
        throw new Error("planner schema invoked an inherited record accessor");
      },
    }) as Record<string, unknown>;
    const { mappings: _mappings, ...mappinglessInput } = input();
    Object.assign(inheritedMappings, mappinglessInput);

    const inheritedIndexPrototype = Object.create(Array.prototype) as unknown[];
    Object.defineProperty(inheritedIndexPrototype, "1", {
      configurable: true,
      get() {
        inheritedReads += 1;
        throw new Error("planner schema invoked an inherited array accessor");
      },
    });
    const sparseMappings = new Array(2) as unknown[];
    sparseMappings[0] = { artifactId: "root", target: "rules/root.md" };
    Object.setPrototypeOf(sparseMappings, inheritedIndexPrototype);

    expectFailFast(() => ProjectionPlannerInputSchema.safeParse(inheritedMappings));
    expectFailFast(() =>
      ProjectionPlannerInputSchema.safeParse(input({ mappings: sparseMappings })),
    );
    expect(inheritedReads).toBe(0);
  });

  it("fails closed for direct mapping proxies, inherited fields, and accessors", () => {
    const mapping = { artifactId: "root", target: "rules/root.md" };
    const proxied = new Proxy(mapping, {
      get() {
        throw new Error("mapping schema invoked a proxy trap");
      },
    });
    const revocable = Proxy.revocable(mapping, {});
    revocable.revoke();
    const inherited = Object.create(mapping) as Record<string, unknown>;
    const accessor = { target: "rules/root.md" } as Record<string, unknown>;
    Object.defineProperty(accessor, "artifactId", {
      enumerable: true,
      get() {
        throw new Error("mapping schema invoked an accessor");
      },
    });
    const sparseArray = new Array(1);
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get() {
        throw new Error("mapping schema invoked an array accessor");
      },
    });

    for (const candidate of [
      proxied,
      revocable.proxy,
      inherited,
      accessor,
      sparseArray,
      accessorArray,
    ]) {
      expectFailFast(() => ProjectionMappingSchema.safeParse(candidate));
    }
  });

  it("rejects polluted prototypes and hidden record properties without reading them", () => {
    let inheritedReads = 0;
    const missingMappings = input();
    delete missingMappings.mappings;
    const missingDependencies = input();
    const firstArtifact = (
      missingDependencies.classifierInput as { artifacts: Array<Record<string, unknown>> }
    ).artifacts[0];
    if (firstArtifact === undefined) throw new Error("test fixture lost its root artifact");
    delete firstArtifact.dependencies;

    Object.defineProperty(Object.prototype, "mappings", {
      configurable: true,
      get() {
        inheritedReads += 1;
        throw new Error("planner schema invoked Object.prototype.mappings");
      },
    });
    Object.defineProperty(Object.prototype, "dependencies", {
      configurable: true,
      get() {
        inheritedReads += 1;
        throw new Error("planner schema invoked Object.prototype.dependencies");
      },
    });
    try {
      expectFailFast(() => ProjectionPlannerInputSchema.safeParse(missingMappings));
      expectFailFast(() => ProjectionPlannerInputSchema.safeParse(missingDependencies));
    } finally {
      delete (Object.prototype as Record<string, unknown>).mappings;
      delete (Object.prototype as Record<string, unknown>).dependencies;
    }
    expect(inheritedReads).toBe(0);

    const withSymbol = input();
    Object.defineProperty(withSymbol, Symbol("hidden"), { value: true, enumerable: true });
    const withHidden = input();
    Object.defineProperty(withHidden, "hidden", { value: true, enumerable: false });
    expect(ProjectionPlannerInputSchema.safeParse(withSymbol).success).toBe(false);
    expect(ProjectionPlannerInputSchema.safeParse(withHidden).success).toBe(false);
  });

  it("does not invoke ambient toJSON hooks while canonicalizing or hashing", () => {
    const baseline = planSyntheticProjection(input());
    const manifest = manifestOf(baseline);
    let hookCalls = 0;

    for (const prototype of [Object.prototype, Array.prototype]) {
      Object.defineProperty(prototype, "toJSON", {
        configurable: true,
        value() {
          hookCalls += 1;
          throw new Error("planner invoked an ambient toJSON hook");
        },
      });
      try {
        expect(planSyntheticProjection(input()).state).toBe("planned");
        expect(ProjectionDecisionSchema.safeParse(manifest.decision).success).toBe(true);
        expect(ProjectionPlanResultSchema.safeParse(baseline).success).toBe(true);
      } finally {
        delete (prototype as { toJSON?: unknown }).toJSON;
      }
    }

    expect(hookCalls).toBe(0);
  });

  it("does not execute post-initialization ambient collection and path hooks", () => {
    const candidate = input();
    const hooks: Array<{ prototype: object; property: PropertyKey }> = [
      { prototype: Array.prototype, property: "sort" },
      { prototype: Array.prototype, property: "map" },
      { prototype: Array.prototype, property: "some" },
      { prototype: Array.prototype, property: "every" },
      { prototype: Array.prototype, property: "includes" },
      { prototype: Array.prototype, property: Symbol.iterator },
      { prototype: Map.prototype, property: "get" },
      { prototype: Set.prototype, property: "has" },
      { prototype: WeakSet.prototype, property: "has" },
      { prototype: WeakSet.prototype, property: "add" },
      { prototype: WeakSet.prototype, property: "delete" },
      { prototype: RegExp.prototype, property: "test" },
      { prototype: String.prototype, property: "split" },
      { prototype: String.prototype, property: "startsWith" },
      { prototype: String.prototype, property: "endsWith" },
    ];
    let hookCalls = 0;
    let escapedError: unknown;
    let planned = 0;

    for (let index = 0; index < hooks.length; index += 1) {
      const hook = hooks[index];
      if (hook === undefined) continue;
      const original = Object.getOwnPropertyDescriptor(hook.prototype, hook.property);
      Object.defineProperty(hook.prototype, hook.property, {
        configurable: true,
        value() {
          hookCalls += 1;
          throw new Error(`planner invoked ambient ${String(hook.property)}`);
        },
      });
      try {
        if (planSyntheticProjection(candidate).state === "planned") planned += 1;
      } catch (error) {
        escapedError = error;
      } finally {
        if (original === undefined)
          delete (hook.prototype as Record<PropertyKey, unknown>)[hook.property];
        else Object.defineProperty(hook.prototype, hook.property, original);
      }
    }

    expect(escapedError).toBeUndefined();
    expect(hookCalls).toBe(0);
    expect(planned).toBe(hooks.length);
  });

  it("exports frozen parse-only planner schema boundaries", () => {
    const schemas = [
      ProjectionMappingSchema,
      ProjectionPlannerInputSchema,
      ProjectionDecisionSchema,
      ProjectionPlanResultSchema,
    ];
    const methods = [
      "decode",
      "decodeAsync",
      "parse",
      "parseAsync",
      "safeDecode",
      "safeDecodeAsync",
      "safeParse",
      "safeParseAsync",
      "spa",
    ];

    for (const schema of schemas) {
      expect(Object.getPrototypeOf(schema)).toBeNull();
      expect(Object.isFrozen(schema)).toBe(true);
      expect(Object.keys(schema).sort()).toEqual(methods);
      expect("clone" in schema).toBe(false);
      expect("optional" in schema).toBe(false);
      expect("encode" in schema).toBe(false);
    }
  });

  it("does not invoke ambient Object prototype error hooks or numeric setters", () => {
    const planned = planSyntheticProjection(input());
    const manifest = manifestOf(planned);
    const validCases = [
      [ProjectionMappingSchema, { artifactId: "root", target: "rules/root.md" }],
      [ProjectionPlannerInputSchema, input()],
      [ProjectionDecisionSchema, manifest.decision],
      [ProjectionPlanResultSchema, planned],
    ] as const;
    const invalidCases = [
      [ProjectionMappingSchema, { artifactId: "root", target: "" }],
      [ProjectionPlannerInputSchema, { ...input(), classifierVersion: "future" }],
      [ProjectionDecisionSchema, { ...manifest.decision, digestVersion: 2 }],
      [ProjectionPlanResultSchema, { ...planned, unexpected: true }],
    ] as const;
    let escapedError: unknown;
    let failures = 0;
    let hookCalls = 0;

    for (const property of ["toJSON", "path", "message", "0", "1"] as const) {
      const original = Object.getOwnPropertyDescriptor(Object.prototype, property);
      const descriptor: PropertyDescriptor =
        property === "0" || property === "1"
          ? {
              configurable: true,
              set() {
                hookCalls += 1;
                throw new Error(`planner invoked ambient ${property}`);
              },
            }
          : {
              configurable: true,
              get() {
                hookCalls += 1;
                throw new Error(`planner invoked ambient ${property}`);
              },
            };
      Object.defineProperty(Object.prototype, property, descriptor);
      try {
        for (const [schema, value] of validCases) {
          try {
            if (!schema.safeParse(value).success) failures += 1;
          } catch (error) {
            escapedError = error;
          }
        }
        for (const [schema, value] of invalidCases) {
          try {
            if (schema.safeParse(value).success) failures += 1;
          } catch (error) {
            escapedError = error;
          }
        }
        try {
          if (planSyntheticProjection(input()).state !== "planned") failures += 1;
        } catch (error) {
          escapedError = error;
        }
      } finally {
        if (original === undefined) delete (Object.prototype as Record<string, unknown>)[property];
        else Object.defineProperty(Object.prototype, property, original);
      }
    }

    expect(escapedError).toBeUndefined();
    expect(failures).toBe(0);
    expect(hookCalls).toBe(0);
  });

  it("does not assimilate ambient then hooks through planner async schema methods", async () => {
    const valid = input();
    const invalid = { ...valid, classifierVersion: "future" };
    let hookCalls = 0;
    let escapedError: unknown;
    let failures = 0;
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "then");
    // biome-ignore lint/suspicious/noThenProperty: this hostile ambient hook is the boundary under test
    Object.defineProperty(Object.prototype, "then", {
      configurable: true,
      get() {
        hookCalls += 1;
        throw new Error("planner invoked ambient then");
      },
    });
    try {
      try {
        if (!(await ProjectionPlannerInputSchema.safeParseAsync(valid)).success) failures += 1;
        if ((await ProjectionPlannerInputSchema.safeDecodeAsync(invalid)).success) failures += 1;
        if ((await ProjectionPlannerInputSchema.spa(invalid)).success) failures += 1;
        await ProjectionPlannerInputSchema.parseAsync(valid);
      } catch (error) {
        escapedError = error;
      }
    } finally {
      if (original === undefined) delete (Object.prototype as Record<string, unknown>).then;
      // biome-ignore lint/suspicious/noThenProperty: restore the exact ambient descriptor after the test
      else Object.defineProperty(Object.prototype, "then", original);
    }

    expect(escapedError).toBeUndefined();
    expect(failures).toBe(0);
    expect(hookCalls).toBe(0);
  });

  it("rejects oversized targets before canonical path operations", () => {
    const baseline = manifestOf(planSyntheticProjection(input()));
    const first = baseline.decision.entries[0];
    if (first === undefined) throw new Error("test fixture lost its first decision entry");
    const oversized = "a".repeat(241);
    const decision = {
      ...baseline.decision,
      entries: [{ ...first, target: oversized }, ...baseline.decision.entries.slice(1)],
    };
    let splitCalls = 0;
    const original = String.prototype.split;
    String.prototype.split = function guardedSplit(separator, limit) {
      if (this.toString() === oversized) {
        splitCalls += 1;
        throw new Error("oversized target reached canonical path splitting");
      }
      return Reflect.apply(original, this.toString(), [separator, limit]) as string[];
    };
    try {
      expect(ProjectionDecisionSchema.safeParse(decision).success).toBe(false);
    } finally {
      String.prototype.split = original;
    }
    expect(splitCalls).toBe(0);
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
