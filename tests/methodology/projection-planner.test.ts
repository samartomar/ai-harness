import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  planSyntheticMethodologyProjection,
  SyntheticMethodologyProjectionPlanSchema,
  SyntheticMethodologyProjectionSchema,
} from "../../src/methodology/projection-planner.js";

function digest(seed: string): string {
  const encoded = [...seed]
    .map((character) => character.codePointAt(0)?.toString(16).padStart(2, "0") ?? "00")
    .join("");
  return `sha256:${encoded.slice(0, 64).padEnd(64, "0")}`;
}

function entry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    admission: "admitted",
    source: {
      locator: `synthetic://fixture/${id}`,
      sourceDigest: digest(`source-${id}`),
      contentDigest: digest(`content-${id}`),
    },
    target: {
      path: `methodology/v1/rules/${id}.md`,
      owner: "aih-methodology-v1",
    },
    ...overrides,
  };
}

function projection(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    entries: [entry("review-loop")],
    ...overrides,
  };
}

describe("synthetic methodology projection planner", () => {
  it("creates a deterministic host-neutral manifest from admitted synthetic entries", () => {
    const forward = planSyntheticMethodologyProjection(
      projection({
        entries: [entry("review-loop"), entry("method-routing")],
      }),
    );
    const reverse = planSyntheticMethodologyProjection(
      projection({
        entries: [entry("method-routing"), entry("review-loop")],
      }),
    );

    const entries = [
      {
        id: "method-routing",
        source: {
          locator: "synthetic://fixture/method-routing",
          sourceDigest: digest("source-method-routing"),
          contentDigest: digest("content-method-routing"),
        },
        target: "methodology/v1/rules/method-routing.md",
      },
      {
        id: "review-loop",
        source: {
          locator: "synthetic://fixture/review-loop",
          sourceDigest: digest("source-review-loop"),
          contentDigest: digest("content-review-loop"),
        },
        target: "methodology/v1/rules/review-loop.md",
      },
    ];
    const manifest = {
      schemaVersion: 1,
      owner: "aih-methodology-v1",
      entries,
    };
    const manifestDigest = `sha256:${createHash("sha256")
      .update(JSON.stringify(manifest), "utf8")
      .digest("hex")}`;

    expect(forward).toEqual({
      schemaVersion: 1,
      state: "planned",
      manifest: { ...manifest, digest: manifestDigest },
      findings: [],
      boundary: {
        providerExecution: false,
        hostExecution: false,
        reads: false,
        writes: false,
        cli: false,
      },
    });
    expect(reverse).toEqual(forward);
  });

  it("blocks colliding owned projection targets with a fixed finding", () => {
    const result = planSyntheticMethodologyProjection(
      projection({
        entries: [
          entry("review-loop", {
            target: { path: "methodology/v1/rules/shared.md", owner: "aih-methodology-v1" },
          }),
          entry("method-routing", {
            target: { path: "methodology/v1/rules/shared.md", owner: "aih-methodology-v1" },
          }),
        ],
      }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      state: "blocked",
      manifest: null,
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_DESTINATION_COLLISION",
          disposition: "blocked",
          target: "methodology/v1/rules/shared.md",
        },
      ],
      boundary: {
        providerExecution: false,
        hostExecution: false,
        reads: false,
        writes: false,
        cli: false,
      },
    });
  });

  it.each([
    ["an external owner", { path: "methodology/v1/rules/review-loop.md", owner: "external" }],
    [
      "a target outside the owned root",
      { path: "foreign/v1/rules/review-loop.md", owner: "aih-methodology-v1" },
    ],
  ])("blocks %s", (_name, target) => {
    const result = planSyntheticMethodologyProjection(
      projection({ entries: [entry("review-loop", { target })] }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      state: "blocked",
      manifest: null,
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_TARGET_UNOWNED",
          disposition: "blocked",
          target: target.path,
        },
      ],
      boundary: {
        providerExecution: false,
        hostExecution: false,
        reads: false,
        writes: false,
        cli: false,
      },
    });
  });

  it("blocks duplicate source locators without selecting an arbitrary source", () => {
    const result = planSyntheticMethodologyProjection(
      projection({
        entries: [
          entry("review-loop", {
            source: {
              locator: "synthetic://fixture/shared-source",
              sourceDigest: digest("source-shared"),
              contentDigest: digest("content-review-loop"),
            },
          }),
          entry("method-routing", {
            source: {
              locator: "synthetic://fixture/shared-source",
              sourceDigest: digest("source-shared"),
              contentDigest: digest("content-method-routing"),
            },
          }),
        ],
      }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      state: "blocked",
      manifest: null,
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_SOURCE_IDENTITY_AMBIGUOUS",
          disposition: "blocked",
          target: "methodology/v1/rules/method-routing.md",
        },
        {
          code: "METHODOLOGY_SYNTHETIC_SOURCE_IDENTITY_AMBIGUOUS",
          disposition: "blocked",
          target: "methodology/v1/rules/review-loop.md",
        },
      ],
      boundary: {
        providerExecution: false,
        hostExecution: false,
        reads: false,
        writes: false,
        cli: false,
      },
    });
  });

  it("keeps projection records closed, admitted, and canonical at their boundary", () => {
    expect(() =>
      SyntheticMethodologyProjectionSchema.parse({ ...projection(), unknown: true }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyProjectionSchema.parse(
        projection({ entries: [entry("review-loop", { admission: "excluded" })] }),
      ),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyProjectionSchema.parse(
        projection({
          entries: [
            entry("review-loop", {
              target: { path: "methodology/v1/rules/Review-loop.md", owner: "aih-methodology-v1" },
            }),
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects contradictory or duplicated externally supplied plan results", () => {
    const finding = {
      code: "METHODOLOGY_SYNTHETIC_TARGET_UNOWNED",
      disposition: "blocked" as const,
      target: "foreign/v1/rules/review-loop.md",
    };
    expect(() =>
      SyntheticMethodologyProjectionPlanSchema.parse({
        schemaVersion: 1,
        state: "planned",
        manifest: null,
        findings: [],
        boundary: {
          providerExecution: false,
          hostExecution: false,
          reads: false,
          writes: false,
          cli: false,
        },
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyProjectionPlanSchema.parse({
        schemaVersion: 1,
        state: "blocked",
        manifest: null,
        findings: [finding, finding],
        boundary: {
          providerExecution: false,
          hostExecution: false,
          reads: false,
          writes: false,
          cli: false,
        },
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyProjectionPlanSchema.parse({
        schemaVersion: 1,
        state: "blocked",
        manifest: null,
        findings: [
          {
            code: "METHODOLOGY_SYNTHETIC_SOURCE_IDENTITY_AMBIGUOUS",
            disposition: "blocked",
            target: "methodology/v1/rules/review-loop.md",
          },
          finding,
        ],
        boundary: {
          providerExecution: false,
          hostExecution: false,
          reads: false,
          writes: false,
          cli: false,
        },
      }),
    ).toThrow();
  });

  it("rejects unordered, duplicate, overlong, or digest-mismatched manifests", () => {
    const planned = planSyntheticMethodologyProjection(
      projection({ entries: [entry("review-loop"), entry("method-routing")] }),
    );
    const manifest = planned.manifest;
    if (planned.state !== "planned" || manifest === null) {
      throw new Error("test fixture must plan");
    }

    expect(() =>
      SyntheticMethodologyProjectionPlanSchema.parse({
        ...planned,
        manifest: { ...manifest, entries: [...manifest.entries].reverse() },
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyProjectionPlanSchema.parse({
        ...planned,
        manifest: {
          ...manifest,
          entries: [manifest.entries[0], manifest.entries[0]],
        },
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyProjectionPlanSchema.parse({
        ...planned,
        manifest: { ...manifest, digest: digest("tampered") },
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyProjectionPlanSchema.parse({
        ...planned,
        manifest: {
          ...manifest,
          entries: Array.from({ length: 33 }, (_, index) => ({
            id: `component-${index}`,
            source: {
              locator: `synthetic://fixture/component-${index}`,
              sourceDigest: digest(`source-${index}`),
              contentDigest: digest(`content-${index}`),
            },
            target: `methodology/v1/rules/component-${index}.md`,
          })),
        },
      }),
    ).toThrow();
  });
});
