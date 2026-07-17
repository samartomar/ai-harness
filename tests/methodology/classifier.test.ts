import { describe, expect, it } from "vitest";
import {
  classifySyntheticProjection,
  SyntheticArtifactSchema,
  SyntheticClassificationResultSchema,
  SyntheticClassifierInputSchema,
  SyntheticEvidenceSchema,
  SyntheticFindingCodeSchema,
  SyntheticFindingSchema,
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
    const sharedRoot = { ...root, sourceLocator: "synthetic:shared" };
    const duplicateLocator = {
      ...artifact("dependency"),
      sourceLocator: "synthetic:shared",
    };

    expect(codes(classifySyntheticProjection(input([root, duplicateId])))).toContain(
      "METHODOLOGY_ARTIFACT_DUPLICATE",
    );
    const locatorResult = classifySyntheticProjection(input([sharedRoot, duplicateLocator]));
    expect(locatorResult.findings).toContainEqual({
      code: "METHODOLOGY_LOCATOR_DUPLICATE",
      artifactId: "root",
    });
    expect(locatorResult.findings).not.toContainEqual(
      expect.objectContaining({ artifactId: "shared" }),
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

  it("does not read optional finding fields through ambient prototypes", () => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "artifactId");
    let hookCalls = 0;
    Object.defineProperty(Object.prototype, "artifactId", {
      configurable: true,
      get() {
        hookCalls += 1;
        throw new Error("classifier read an optional finding field from Object.prototype");
      },
    });

    try {
      expect(
        classifySyntheticProjection(input(undefined, { requested: ["root", "root"] })).findings,
      ).toEqual([{ code: "METHODOLOGY_REQUEST_DUPLICATE" }]);
      for (const code of [
        "METHODOLOGY_DEPENDENCY_OUT_OF_CLOSURE",
        "METHODOLOGY_FINDINGS_LIMIT",
        "METHODOLOGY_REQUEST_DUPLICATE",
      ] as const) {
        expect(
          SyntheticClassificationResultSchema.safeParse({
            schemaVersion: 1,
            disposition: "ineligible",
            closure: ["root"],
            eligible: [],
            findings: [{ code }],
          }).success,
        ).toBe(true);
      }
    } finally {
      if (original === undefined) delete (Object.prototype as { artifactId?: unknown }).artifactId;
      else Object.defineProperty(Object.prototype, "artifactId", original);
    }

    expect(hookCalls).toBe(0);
  });

  it("fails closed before hostile object surfaces can execute across exported schemas", () => {
    const root = artifact("root");
    const validInput = input([root]);
    const validResult = classifySyntheticProjection(validInput);
    const cases = [
      [SyntheticArtifactSchema, root],
      [SyntheticEvidenceSchema, evidence(root)],
      [SyntheticFindingSchema, { code: "METHODOLOGY_CONTENT_EXECUTABLE", artifactId: "root" }],
      [SyntheticClassifierInputSchema, validInput],
      [SyntheticClassificationResultSchema, validResult],
    ] as const;
    let trapCalls = 0;

    for (const [schema, value] of cases) {
      const hostile = new Proxy(value, {
        get() {
          trapCalls += 1;
          throw new Error("schema invoked a hostile proxy trap");
        },
      });
      const inherited = Object.create(value) as unknown;
      const hidden = { ...value } as Record<string, unknown>;
      Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
      const symbolKeyed = { ...value } as Record<PropertyKey, unknown>;
      symbolKeyed[Symbol("hidden")] = true;

      expect(() => schema.safeParse(hostile)).not.toThrow();
      expect(schema.safeParse(hostile).success).toBe(false);
      expect(schema.safeParse(inherited).success).toBe(false);
      expect(schema.safeParse(hidden).success).toBe(false);
      expect(schema.safeParse(symbolKeyed).success).toBe(false);
    }

    const hostileInput = new Proxy(validInput, {
      get() {
        trapCalls += 1;
        throw new Error("classifier invoked a hostile proxy trap");
      },
    });
    const nestedHostileInput = {
      ...validInput,
      artifacts: [
        new Proxy(root, {
          get() {
            trapCalls += 1;
            throw new Error("classifier invoked a nested hostile proxy trap");
          },
        }),
      ],
    };
    const accessorInput = { ...validInput };
    Object.defineProperty(accessorInput, "requested", {
      enumerable: true,
      get() {
        trapCalls += 1;
        throw new Error("classifier invoked an input accessor");
      },
    });

    expect(() => classifySyntheticProjection(hostileInput)).toThrow();
    expect(() => classifySyntheticProjection(nestedHostileInput)).toThrow();
    expect(SyntheticClassifierInputSchema.safeParse(accessorInput).success).toBe(false);
    expect(trapCalls).toBe(0);
  });

  it("rejects oversized collections before reading forbidden elements", () => {
    const root = artifact("root");
    let forbiddenReads = 0;
    const accessorDependencies = ["dependency"];
    Object.defineProperty(accessorDependencies, "0", {
      configurable: true,
      enumerable: true,
      get() {
        forbiddenReads += 1;
        throw new Error("dependency accessor was read");
      },
    });
    const extraKeyRequested = ["root"];
    Object.defineProperty(extraKeyRequested, "hidden", {
      enumerable: false,
      value: true,
    });
    const requested = Array.from({ length: 33 }, (_, index) => `root-${index}`);
    Object.defineProperty(requested, "32", {
      configurable: true,
      enumerable: true,
      get() {
        forbiddenReads += 1;
        throw new Error("requested overflow element was read");
      },
    });
    const dependencies = Array.from({ length: 33 }, () => "dependency");
    Object.defineProperty(dependencies, "32", {
      configurable: true,
      enumerable: true,
      get() {
        forbiddenReads += 1;
        throw new Error("dependency overflow element was read");
      },
    });
    const closure = Array.from({ length: 65 }, (_, index) => `node-${index}`);
    Object.defineProperty(closure, "64", {
      configurable: true,
      enumerable: true,
      get() {
        forbiddenReads += 1;
        throw new Error("result overflow element was read");
      },
    });

    expect(SyntheticClassifierInputSchema.safeParse(input([root], { requested })).success).toBe(
      false,
    );
    expect(
      SyntheticClassifierInputSchema.safeParse(
        input([artifact("root", { dependencies: accessorDependencies })]),
      ).success,
    ).toBe(false);
    expect(
      SyntheticClassifierInputSchema.safeParse(input([root], { requested: extraKeyRequested }))
        .success,
    ).toBe(false);
    expect(
      SyntheticClassifierInputSchema.safeParse(input([artifact("root", { dependencies })])).success,
    ).toBe(false);
    expect(
      SyntheticClassificationResultSchema.safeParse({
        schemaVersion: 1,
        disposition: "eligible",
        closure,
        eligible: ["root"],
        findings: [],
      }).success,
    ).toBe(false);
    expect(forbiddenReads).toBe(0);
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

  it("enforces dependency uniqueness and fixed attribution in exported leaf schemas", () => {
    expect(
      SyntheticArtifactSchema.safeParse(
        artifact("root", { dependencies: ["dependency", "dependency"] }),
      ).success,
    ).toBe(false);
    for (const finding of [
      { code: "METHODOLOGY_CONTENT_EXECUTABLE" },
      { code: "METHODOLOGY_DEPENDENCY_MISSING" },
      { code: "METHODOLOGY_FINDINGS_LIMIT", artifactId: "root" },
      { code: "METHODOLOGY_REQUEST_DUPLICATE", artifactId: "root" },
    ]) {
      expect(SyntheticFindingSchema.safeParse(finding).success).toBe(false);
    }
  });

  it("attributes closed-schema failures to named record fields", () => {
    const root = artifact("root");
    const cases = [
      [SyntheticArtifactSchema, { ...root, id: "ROOT" }, ["id"]],
      [
        SyntheticEvidenceSchema,
        { ...evidence(root), sourceLocator: "not-synthetic" },
        ["sourceLocator"],
      ],
      [SyntheticFindingSchema, { code: "NOT_A_FINDING" }, ["code"]],
      [
        SyntheticClassifierInputSchema,
        input([{ ...root, id: "ROOT" }], { declaredClosure: ["root"] }),
        ["artifacts", 0, "id"],
      ],
      [
        SyntheticClassificationResultSchema,
        {
          schemaVersion: 1,
          disposition: "admitted",
          closure: ["root"],
          eligible: ["root"],
          findings: [],
        },
        ["disposition"],
      ],
    ] as const;

    for (const [schema, value, expectedPath] of cases) {
      const result = schema.safeParse(value);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(expectedPath);
    }
  });

  it("attributes structural and first-over-limit failures to exact named fields", () => {
    const root = artifact("root");
    const withoutId = { ...root };
    delete withoutId.id;
    const withUnknown = { ...root, unexpected: true };
    const evidenceWithoutDigest = { ...evidence(root) };
    delete evidenceWithoutDigest.contentDigest;
    const resultWithoutFindings: Record<string, unknown> = {
      schemaVersion: 1,
      disposition: "eligible",
      closure: ["root"],
      eligible: ["root"],
    };
    const tooManyFindings = Array.from({ length: 257 }, () => ({
      code: "METHODOLOGY_FINDINGS_LIMIT",
    }));
    const farTooManyFindings = Array.from({ length: 258 }, () => ({
      code: "METHODOLOGY_FINDINGS_LIMIT",
    }));
    const cases = [
      [SyntheticArtifactSchema, withoutId, ["id"]],
      [SyntheticArtifactSchema, withUnknown, ["unexpected"]],
      [SyntheticArtifactSchema, { ...root, sourceLocator: "" }, ["sourceLocator"]],
      [SyntheticEvidenceSchema, evidenceWithoutDigest, ["contentDigest"]],
      [SyntheticClassifierInputSchema, { ...input(), schemaVersion: 2 }, ["schemaVersion"]],
      [
        SyntheticClassifierInputSchema,
        input([withoutId], { declaredClosure: ["root"] }),
        ["artifacts", 0, "id"],
      ],
      [SyntheticClassifierInputSchema, input([withUnknown]), ["artifacts", 0, "unexpected"]],
      [
        SyntheticClassifierInputSchema,
        input([artifact("root", { dependencies: Array.from({ length: 33 }, () => "root") })]),
        ["artifacts", 0, "dependencies"],
      ],
      [
        SyntheticClassifierInputSchema,
        input(undefined, { requested: Array.from({ length: 33 }, () => "root") }),
        ["requested"],
      ],
      [
        SyntheticClassifierInputSchema,
        input(undefined, { requested: Array.from({ length: 258 }, () => "root") }),
        ["requested"],
      ],
      [
        SyntheticClassifierInputSchema,
        input([artifact("root", { dependencies: Array.from({ length: 258 }, () => "root") })]),
        ["artifacts", 0, "dependencies"],
      ],
      [SyntheticClassificationResultSchema, resultWithoutFindings, ["findings"]],
      [
        SyntheticClassificationResultSchema,
        {
          schemaVersion: 2,
          disposition: "eligible",
          closure: ["root"],
          eligible: ["root"],
          findings: [],
        },
        ["schemaVersion"],
      ],
      [
        SyntheticClassificationResultSchema,
        {
          schemaVersion: 1,
          disposition: "ineligible",
          closure: ["root"],
          eligible: [],
          findings: tooManyFindings,
        },
        ["findings"],
      ],
      [
        SyntheticClassificationResultSchema,
        {
          schemaVersion: 1,
          disposition: "ineligible",
          closure: ["root"],
          eligible: [],
          findings: farTooManyFindings,
        },
        ["findings"],
      ],
    ] as const;

    for (const [schema, value, expectedPath] of cases) {
      const result = schema.safeParse(value);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(expectedPath);
    }
  });

  it("keeps asynchronous schema entry points closed", async () => {
    const valid = input();
    const invalid = { ...valid, schemaVersion: 2 };

    await expect(SyntheticClassifierInputSchema.safeParseAsync(valid)).resolves.toMatchObject({
      success: true,
    });
    await expect(SyntheticClassifierInputSchema.safeParseAsync(invalid)).resolves.toMatchObject({
      success: false,
    });
    await expect(SyntheticClassifierInputSchema.safeDecodeAsync(invalid)).resolves.toMatchObject({
      success: false,
    });
    await expect(SyntheticClassifierInputSchema.spa(invalid)).resolves.toMatchObject({
      success: false,
    });
    await expect(SyntheticClassifierInputSchema.parseAsync(valid)).resolves.toMatchObject({
      schemaVersion: 1,
    });
    await expect(SyntheticClassifierInputSchema.parseAsync(invalid)).rejects.toMatchObject({
      issues: [{ path: ["schemaVersion"] }],
    });
    await expect(SyntheticClassifierInputSchema.decodeAsync(invalid)).rejects.toMatchObject({
      issues: [{ path: ["schemaVersion"] }],
    });
  });

  it("returns closed invalid results without invoking ambient error hooks", () => {
    const root = artifact("root");
    const cases = [
      [SyntheticArtifactSchema, { ...root, id: "ROOT" }],
      [SyntheticEvidenceSchema, { ...evidence(root), artifactId: "ROOT" }],
      [SyntheticFindingCodeSchema, "NOT_A_FINDING"],
      [SyntheticFindingSchema, { code: "NOT_A_FINDING" }],
      [
        SyntheticClassifierInputSchema,
        input([{ ...root, id: "ROOT" }], { declaredClosure: ["root"] }),
      ],
      [
        SyntheticClassificationResultSchema,
        {
          schemaVersion: 1,
          disposition: "admitted",
          closure: ["root"],
          eligible: ["root"],
          findings: [],
        },
      ],
    ] as const;
    const validResult = {
      schemaVersion: 1,
      disposition: "eligible",
      closure: ["root"],
      eligible: ["root"],
      findings: [],
    } as const;
    const validCases = [
      [SyntheticArtifactSchema, root],
      [SyntheticEvidenceSchema, evidence(root)],
      [SyntheticFindingCodeSchema, "METHODOLOGY_EVIDENCE_MISSING"],
      [SyntheticFindingSchema, { code: "METHODOLOGY_EVIDENCE_MISSING", artifactId: "root" }],
      [SyntheticClassifierInputSchema, input()],
      [SyntheticClassificationResultSchema, validResult],
    ] as const;
    let hookCalls = 0;
    let escapedError: unknown;
    let unexpectedSuccesses = 0;
    let unexpectedFailures = 0;
    let classifierDidNotThrow = 0;

    for (const property of ["toJSON", "path", "message"] as const) {
      const original = Object.getOwnPropertyDescriptor(Object.prototype, property);
      Object.defineProperty(Object.prototype, property, {
        configurable: true,
        get() {
          hookCalls += 1;
          throw new Error(`schema invoked ambient ${property}`);
        },
      });
      try {
        for (const [schema, value] of cases) {
          try {
            if (schema.safeParse(value).success) unexpectedSuccesses += 1;
            const decodeBoundary = schema as unknown as {
              decode(candidate: unknown): unknown;
              safeDecode(candidate: unknown): { success: boolean };
            };
            if (decodeBoundary.safeDecode(value).success) unexpectedSuccesses += 1;
            decodeBoundary.decode(value);
            classifierDidNotThrow += 1;
          } catch (error) {
            if (!(error instanceof Error) || !Object.hasOwn(error, "issues")) {
              escapedError = error;
            }
          }
        }
        for (const [schema, value] of validCases) {
          try {
            if (!schema.safeParse(value).success) unexpectedFailures += 1;
          } catch (error) {
            escapedError = error;
          }
        }
        try {
          classifySyntheticProjection(cases[4][1]);
          classifierDidNotThrow += 1;
        } catch {
          // Invalid classifier input must throw without consulting ambient hooks.
        }
      } finally {
        if (original === undefined) delete (Object.prototype as Record<string, unknown>)[property];
        else Object.defineProperty(Object.prototype, property, original);
      }
    }

    expect(escapedError).toBeUndefined();
    expect(unexpectedSuccesses).toBe(0);
    expect(unexpectedFailures).toBe(0);
    expect(classifierDidNotThrow).toBe(0);
    expect(hookCalls).toBe(0);
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
