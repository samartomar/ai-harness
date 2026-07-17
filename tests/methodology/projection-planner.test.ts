import { describe, expect, it } from "vitest";
import {
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

  it("blocks drive-qualified logical targets and interleaved ancestor collisions", () => {
    for (const target of ["C:/outside/root.md", "rules/item.", "rules/con", "rules/com1.txt"]) {
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
      input({ policyVersion: "phase-3-policy-v2" }),
      input({ classifierVersion: "phase-2-classifier-v2" }),
      input({ manifestVersion: 2 }),
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
        manifest: {
          ...manifestOf(planned),
          entries: [
            { ...manifestOf(planned).entries[0], target: "rules/a" },
            { ...manifestOf(planned).entries[1], target: "rules/a." },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      ProjectionPlanResultSchema.parse({
        ...planned,
        manifest: {
          ...manifestOf(planned),
          entries: [
            { ...manifestOf(planned).entries[0], artifactId: "root", target: "rules/a" },
            { ...manifestOf(planned).entries[1], artifactId: "root", target: "rules/b" },
          ],
        },
      }),
    ).toThrow();
  });
});
