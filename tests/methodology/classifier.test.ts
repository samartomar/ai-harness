import { describe, expect, it } from "vitest";
import {
  classifySyntheticProjection,
  SyntheticClassificationResultSchema,
  SyntheticClassifierInputSchema,
} from "../../src/methodology/classifier.js";

type ArtifactOverrides = Record<string, unknown>;

function digest(character: string): string {
  return character.repeat(64);
}

function artifact(id: string, overrides: ArtifactOverrides = {}): Record<string, unknown> {
  const contentDigest = digest(id === "root" ? "a" : id === "dependency" ? "b" : "c");
  return {
    id,
    sourceLocator: `synthetic:${id}`,
    contentDigest,
    contentDisposition: "inert",
    linkDisposition: "none",
    licenseDisposition: "permissive",
    evidenceDigest: digest(id === "root" ? "d" : id === "dependency" ? "e" : "f"),
    dependencies: [],
    ...overrides,
  };
}

function evidence(forArtifact: Record<string, unknown>): Record<string, unknown> {
  return {
    artifactId: forArtifact.id,
    sourceLocator: forArtifact.sourceLocator,
    contentDigest: forArtifact.contentDigest,
    licenseDisposition: forArtifact.licenseDisposition,
    evidenceDigest: forArtifact.evidenceDigest,
  };
}

function input(
  artifacts: Record<string, unknown>[] = [artifact("root")],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    requested: ["root"],
    declaredClosure: artifacts.map((candidate) => candidate.id),
    artifacts,
    evidence: artifacts.map(evidence),
    ...overrides,
  };
}

function codes(result: ReturnType<typeof classifySyntheticProjection>): string[] {
  return result.findings.map((finding) => finding.code);
}

describe("Phase 2 synthetic methodology classifier", () => {
  it("returns an eligibility-only deterministic closure for complete inert synthetic input", () => {
    const root = artifact("root", { dependencies: ["dependency"] });
    const dependency = artifact("dependency");
    const forward = classifySyntheticProjection(input([root, dependency]));
    const reverse = classifySyntheticProjection(
      input([dependency, root], { declaredClosure: ["root", "dependency"] }),
    );

    expect(forward).toEqual({
      schemaVersion: 1,
      disposition: "eligible",
      closure: ["dependency", "root"],
      eligible: ["dependency", "root"],
      findings: [],
    });
    expect(reverse).toEqual(forward);
    expect(JSON.stringify(forward)).not.toContain("admitted");
  });

  it.each([
    [artifact("root", { contentDisposition: "executable" }), "METHODOLOGY_CONTENT_EXECUTABLE"],
    [artifact("root", { contentDisposition: "ambiguous" }), "METHODOLOGY_CONTENT_AMBIGUOUS"],
    [artifact("root", { linkDisposition: "symbolic" }), "METHODOLOGY_CONTENT_LINKED"],
    [artifact("root", { linkDisposition: "hard" }), "METHODOLOGY_CONTENT_LINKED"],
    [artifact("root", { linkDisposition: "reparse" }), "METHODOLOGY_CONTENT_LINKED"],
    [artifact("root", { licenseDisposition: "unknown" }), "METHODOLOGY_LICENSE_UNAPPROVED"],
    [artifact("root", { licenseDisposition: "restricted" }), "METHODOLOGY_LICENSE_UNAPPROVED"],
  ])("denies hostile synthetic artifact disposition %s", (hostile, expectedCode) => {
    const result = classifySyntheticProjection(input([hostile]));

    expect(result.disposition).toBe("ineligible");
    expect(result.eligible).toEqual([]);
    expect(codes(result)).toContain(expectedCode);
  });

  it("denies missing, conflicting, and drifted evidence bindings", () => {
    const root = artifact("root");
    const missing = classifySyntheticProjection(input([root], { evidence: [] }));
    const conflict = classifySyntheticProjection(
      input([root], { evidence: [evidence(root), evidence(root)] }),
    );
    const driftedEvidence = { ...evidence(root), contentDigest: digest("9") };
    const drifted = classifySyntheticProjection(input([root], { evidence: [driftedEvidence] }));

    expect(codes(missing)).toEqual(["METHODOLOGY_EVIDENCE_MISSING"]);
    expect(codes(conflict)).toEqual(["METHODOLOGY_EVIDENCE_CONFLICT"]);
    expect(codes(drifted)).toEqual(["METHODOLOGY_EVIDENCE_DRIFT"]);
  });

  it.each([
    ["source locator", { sourceLocator: "synthetic:other" }],
    ["content digest", { contentDigest: digest("9") }],
    ["license", { licenseDisposition: "restricted" }],
    ["evidence digest", { evidenceDigest: digest("8") }],
  ])("binds exact evidence %s", (_label, mutation) => {
    const root = artifact("root");
    const result = classifySyntheticProjection(
      input([root], { evidence: [{ ...evidence(root), ...mutation }] }),
    );

    expect(codes(result)).toEqual(["METHODOLOGY_EVIDENCE_DRIFT"]);
  });

  it("denies evidence that is not bound to a supplied synthetic artifact", () => {
    const root = artifact("root");
    const unboundEvidence = {
      ...evidence(root),
      artifactId: "dependency",
      sourceLocator: "synthetic:dependency",
    };

    const result = classifySyntheticProjection(
      input([root], { evidence: [evidence(root), unboundEvidence] }),
    );

    expect(codes(result)).toEqual(["METHODOLOGY_EVIDENCE_UNBOUND"]);
  });

  it("denies missing and declared-out-of-closure dependencies", () => {
    const missingDependency = artifact("root", { dependencies: ["missing"] });
    const missing = classifySyntheticProjection(input([missingDependency]));
    const dependency = artifact("dependency");
    const root = artifact("root", { dependencies: ["dependency"] });
    const outOfClosure = classifySyntheticProjection(
      input([root, dependency], { declaredClosure: ["root"] }),
    );

    expect(codes(missing)).toContain("METHODOLOGY_DEPENDENCY_MISSING");
    expect(codes(outOfClosure)).toContain("METHODOLOGY_DEPENDENCY_OUT_OF_CLOSURE");
  });

  it("denies self and multi-node dependency cycles with deterministic findings", () => {
    const self = artifact("root", { dependencies: ["root"] });
    const selfResult = classifySyntheticProjection(input([self]));
    const root = artifact("root", { dependencies: ["dependency"] });
    const dependency = artifact("dependency", { dependencies: ["root"] });
    const forward = classifySyntheticProjection(input([root, dependency]));
    const reverse = classifySyntheticProjection(input([dependency, root]));

    expect(codes(selfResult)).toContain("METHODOLOGY_DEPENDENCY_CYCLE");
    expect(codes(forward)).toContain("METHODOLOGY_DEPENDENCY_CYCLE");
    expect(reverse).toEqual(forward);
  });

  it("denies duplicate synthetic identities and locators", () => {
    const root = artifact("root");
    const duplicateId = { ...artifact("dependency"), id: "root" };
    const duplicateLocator = { ...artifact("dependency"), sourceLocator: "synthetic:root" };

    expect(codes(classifySyntheticProjection(input([root, duplicateId])))).toContain(
      "METHODOLOGY_ARTIFACT_DUPLICATE",
    );
    expect(codes(classifySyntheticProjection(input([root, duplicateLocator])))).toContain(
      "METHODOLOGY_LOCATOR_DUPLICATE",
    );
  });

  it("uses a total canonical ordering for duplicate artifacts and evidence", () => {
    const dependency = artifact("dependency");
    const rootWithoutDependency = artifact("root");
    const rootWithDependency = artifact("root", { dependencies: ["dependency"] });
    const artifactForward = classifySyntheticProjection(
      input([rootWithoutDependency, rootWithDependency, dependency], {
        declaredClosure: ["root", "dependency"],
      }),
    );
    const artifactReverse = classifySyntheticProjection(
      input([dependency, rootWithDependency, rootWithoutDependency], {
        declaredClosure: ["root", "dependency"],
      }),
    );
    const root = artifact("root");
    const exactEvidence = evidence(root);
    const driftedEvidence = { ...exactEvidence, evidenceDigest: digest("9") };
    const evidenceForward = classifySyntheticProjection(
      input([root], { evidence: [exactEvidence, driftedEvidence] }),
    );
    const evidenceReverse = classifySyntheticProjection(
      input([root], { evidence: [driftedEvidence, exactEvidence] }),
    );

    expect(artifactReverse).toEqual(artifactForward);
    expect(evidenceReverse).toEqual(evidenceForward);
  });

  it("does not invoke ambient toJSON hooks while ordering synthetic records", () => {
    const root = artifact("root", { dependencies: ["dependency"] });
    const dependency = artifact("dependency");
    let hookCalls = 0;

    for (const prototype of [Object.prototype, Array.prototype]) {
      Object.defineProperty(prototype, "toJSON", {
        configurable: true,
        value() {
          hookCalls += 1;
          throw new Error("classifier invoked an ambient toJSON hook");
        },
      });
      try {
        const forward = classifySyntheticProjection(input([root, dependency]));
        const reverse = classifySyntheticProjection(input([dependency, root]));
        expect(reverse).toEqual(forward);
      } finally {
        delete (prototype as { toJSON?: unknown }).toJSON;
      }
    }

    expect(hookCalls).toBe(0);
  });

  it("keeps input and result schemas closed and result dispositions self-consistent", () => {
    const valid = classifySyntheticProjection(input());
    const root = artifact("root");

    expect(() => SyntheticClassifierInputSchema.parse({ ...input(), unexpected: true })).toThrow();
    expect(() =>
      SyntheticClassifierInputSchema.parse(input([{ ...root, unexpected: true }])),
    ).toThrow();
    expect(() =>
      SyntheticClassifierInputSchema.parse(
        input([root], { evidence: [{ ...evidence(root), unexpected: true }] }),
      ),
    ).toThrow();
    expect(() =>
      SyntheticClassificationResultSchema.parse({
        ...valid,
        disposition: "eligible",
        findings: [{ code: "METHODOLOGY_CONTENT_EXECUTABLE", artifactId: "root" }],
      }),
    ).toThrow();
    expect(() =>
      SyntheticClassificationResultSchema.parse({
        schemaVersion: 1,
        disposition: "eligible",
        closure: [],
        eligible: [],
        findings: [],
      }),
    ).toThrow();
    expect(() =>
      SyntheticClassificationResultSchema.parse({
        schemaVersion: 1,
        disposition: "ineligible",
        closure: ["root"],
        eligible: [],
        findings: [
          { code: "METHODOLOGY_CONTENT_EXECUTABLE", artifactId: "root" },
          { code: "METHODOLOGY_FINDINGS_LIMIT" },
        ],
      }),
    ).toThrow();
    expect(() =>
      SyntheticClassificationResultSchema.parse({
        schemaVersion: 1,
        disposition: "ineligible",
        closure: ["root"],
        eligible: [],
        findings: [{ code: "METHODOLOGY_CONTENT_EXECUTABLE" }],
      }),
    ).toThrow();
    expect(() =>
      SyntheticClassificationResultSchema.parse({
        ...valid,
        disposition: "ineligible",
        eligible: [],
      }),
    ).toThrow();
    expect(() =>
      SyntheticClassificationResultSchema.parse({ ...valid, unexpected: true }),
    ).toThrow();
    expect(() =>
      SyntheticClassificationResultSchema.parse({
        ...valid,
        disposition: "ineligible",
        eligible: [],
        findings: [
          { code: "METHODOLOGY_CONTENT_EXECUTABLE", artifactId: "root", unexpected: true },
        ],
      }),
    ).toThrow();
    expect(() =>
      SyntheticClassificationResultSchema.parse({ ...valid, disposition: "admitted" }),
    ).toThrow();
    expect(() =>
      SyntheticClassificationResultSchema.parse({
        ...valid,
        closure: ["root", "root"],
      }),
    ).toThrow();
    expect(() =>
      SyntheticClassificationResultSchema.parse({
        ...valid,
        eligible: ["root", "root"],
      }),
    ).toThrow();
    expect(() =>
      SyntheticClassificationResultSchema.parse({
        schemaVersion: 1,
        disposition: "ineligible",
        closure: ["root"],
        eligible: [],
        findings: [
          { code: "METHODOLOGY_CONTENT_EXECUTABLE", artifactId: "root" },
          { code: "METHODOLOGY_CONTENT_EXECUTABLE", artifactId: "root" },
        ],
      }),
    ).toThrow();
  });

  it("denies duplicate requested components deterministically", () => {
    const result = classifySyntheticProjection(input(undefined, { requested: ["root", "root"] }));

    expect(codes(result)).toContain("METHODOLOGY_REQUEST_DUPLICATE");
  });

  it("rejects resource overflow before graph traversal", () => {
    const root = artifact("root", { dependencies: Array.from({ length: 33 }, () => "dependency") });
    const tooManyRequested = input([artifact("root")], {
      requested: Array.from({ length: 33 }, (_, index) => `root-${index}`),
    });
    const tooManyArtifacts = input(
      Array.from({ length: 65 }, (_, index) => artifact(`artifact-${index}`)),
      { requested: ["artifact-0"] },
    );

    expect(() => classifySyntheticProjection(input([root]))).toThrow();
    expect(() => classifySyntheticProjection(tooManyRequested)).toThrow();
    expect(() => classifySyntheticProjection(tooManyArtifacts)).toThrow();
    expect(() =>
      classifySyntheticProjection(
        input([artifact("root", { dependencies: ["dependency", "dependency"] })]),
      ),
    ).toThrow();
  });

  it("accepts the exact graph-edge bound before applying deterministic denial rules", () => {
    const ids = ["root", ...Array.from({ length: 63 }, (_, index) => `node-${index}`)];
    const artifacts = ids.map((id) => artifact(id, { dependencies: ids.slice(0, 32) }));

    const result = classifySyntheticProjection(input(artifacts, { declaredClosure: ["root"] }));

    expect(codes(result)).toContain("METHODOLOGY_DEPENDENCY_CYCLE");
  });

  it("handles a maximal bounded synthetic closure deterministically", () => {
    const ids = ["root", ...Array.from({ length: 63 }, (_, index) => `node-${index}`)];
    const artifacts = ids.map((id, index) =>
      artifact(id, { dependencies: ids.slice(index + 1, index + 33) }),
    );
    const maximal = input(artifacts, { declaredClosure: [...ids].reverse() });

    const result = classifySyntheticProjection(maximal);

    expect(result.disposition).toBe("eligible");
    expect(result.closure).toHaveLength(64);
    expect(result.eligible).toEqual(result.closure);
    expect(result.findings).toEqual([]);
  });

  it("accepts the bounded maximum of deterministic hostile findings without truncation", () => {
    const ids = ["root", ...Array.from({ length: 63 }, (_, index) => `node-${index}`)];
    const artifacts = ids.map((id, index) =>
      artifact(id, {
        dependencies: index + 1 < ids.length ? [ids[index + 1]] : [],
        contentDisposition: "executable",
        linkDisposition: "symbolic",
        licenseDisposition: "unknown",
      }),
    );
    const evidenceRecords = artifacts.map((candidate) => ({
      ...evidence(candidate),
      contentDigest: digest("9"),
    }));

    const result = classifySyntheticProjection(
      input(artifacts, { declaredClosure: ids, evidence: evidenceRecords }),
    );

    expect(result.disposition).toBe("ineligible");
    expect(result.findings).toHaveLength(256);
    expect(result.findings).toEqual(
      [...result.findings].sort((left, right) => {
        const leftKey = `${left.code}\u0000${left.artifactId ?? ""}`;
        const rightKey = `${right.code}\u0000${right.artifactId ?? ""}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
    );
  });

  it("fails closed with one fixed finding instead of emitting a partial overflow result", () => {
    const ids = ["root", ...Array.from({ length: 63 }, (_, index) => `node-${index}`)];
    const artifacts = ids.map((id, index) =>
      artifact(id, {
        dependencies: index + 1 < ids.length ? [ids[index + 1]] : [],
        contentDisposition: "executable",
        linkDisposition: "symbolic",
        licenseDisposition: "unknown",
      }),
    );
    const evidenceRecords = artifacts.map((candidate) => ({
      ...evidence(candidate),
      contentDigest: digest("9"),
    }));

    const result = classifySyntheticProjection(
      input(artifacts, { declaredClosure: ["root"], evidence: evidenceRecords }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      disposition: "ineligible",
      closure: ids.slice().sort(),
      eligible: [],
      findings: [{ code: "METHODOLOGY_FINDINGS_LIMIT" }],
    });
  });
});
