import { expect, it } from "vitest";
import { policySchemaErrors } from "../../../src/org-policy/workbench/schema-validation.js";

const settingsSchema = {
  type: "object",
  required: ["name", "count", "mode", "values"],
  properties: {
    name: { type: "string", minLength: 3, maxLength: 5, pattern: "^[a-z]+$" },
    count: { type: "integer", minimum: 1, exclusiveMaximum: 4 },
    mode: { enum: ["safe", "fast"] },
    values: { type: "array", minItems: 1, maxItems: 2, items: { type: "integer", minimum: 0 } },
  },
  additionalProperties: false,
} as const;

it("accepts generated-schema primitives, annotations, objects, and items", () => {
  expect(
    policySchemaErrors(
      settingsSchema,
      { name: "valid", count: 3, mode: "safe", values: [0, 2] },
      "settings",
    ),
  ).toEqual([]);
  expect(
    policySchemaErrors(
      { type: "string", title: "Note", default: "x", annotation: { display: "note" } },
      "ok",
    ),
  ).toEqual([]);
});

it("rejects non-finite, fractional, and out-of-range integer values", () => {
  expect(
    policySchemaErrors(
      settingsSchema,
      { name: "valid", count: 1.5, mode: "safe", values: [0] },
      "settings",
    ),
  ).toContain("settings.count: must be integer");
  expect(
    policySchemaErrors(
      settingsSchema,
      { name: "valid", count: Number.NaN, mode: "safe", values: [0] },
      "settings",
    ),
  ).toContain("settings.count: must be integer");
  expect(
    policySchemaErrors(
      settingsSchema,
      { name: "valid", count: 4, mode: "safe", values: [0] },
      "settings",
    ),
  ).toContain("settings.count: must be less than 4");
});

it("applies every allOf branch for generated decision-style objects", () => {
  const schema = {
    type: "object",
    properties: {
      decision: { const: "approve" },
      maxTurns: { type: "integer" },
    },
    required: ["decision", "maxTurns"],
    additionalProperties: false,
    allOf: [
      {
        type: "object",
        properties: { decision: { const: "approve" }, maxTurns: { minimum: 1 } },
        additionalProperties: true,
      },
      {
        type: "object",
        properties: { decision: { const: "approve" }, maxTurns: { maximum: 2 } },
        additionalProperties: true,
      },
    ],
  };
  expect(policySchemaErrors(schema, { decision: "approve", maxTurns: 2 }, "decision")).toEqual([]);
  expect(policySchemaErrors(schema, { decision: "approve", maxTurns: 0 }, "decision")).toContain(
    "decision.maxTurns: must be at least 1",
  );
  expect(policySchemaErrors(schema, { decision: "approve", maxTurns: 3 }, "decision")).toContain(
    "decision.maxTurns: must be at most 2",
  );
});

it("retains oneOf, anyOf, conditional, property-name, and closed-object semantics", () => {
  expect(policySchemaErrors({ oneOf: [{ const: "a" }, { const: "b" }] }, "c")).toContain(
    "policy: must match exactly one schema variant",
  );
  expect(policySchemaErrors({ anyOf: [{ type: "string" }, { type: "integer" }] }, false)).toContain(
    "policy: must match at least one schema variant",
  );
  expect(
    policySchemaErrors(
      { anyOf: [{ const: "safe" }, { const: "fast" }], type: "string", minLength: 5 },
      "safe",
    ),
  ).toContain("policy: must have at least 5 characters");
  expect(
    policySchemaErrors(
      {
        type: "object",
        properties: { mode: { const: "strict" }, reviewer: { type: "string" } },
        required: ["mode"],
        additionalProperties: false,
        if: {
          type: "object",
          properties: { mode: { const: "strict" } },
          required: ["mode"],
          additionalProperties: true,
        },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword.
        then: {
          type: "object",
          properties: { mode: { const: "strict" }, reviewer: { type: "string" } },
          required: ["reviewer"],
          additionalProperties: false,
        },
      },
      { mode: "strict" },
    ),
  ).toContain("policy.reviewer: is required");
  expect(
    policySchemaErrors(
      { type: "object", propertyNames: { pattern: "^[a-z]+$" }, additionalProperties: true },
      { "Bad-Key": true },
    ),
  ).toContain("policy: has an invalid format");
  expect(
    policySchemaErrors(
      settingsSchema,
      { name: "valid", count: 1, mode: "safe", values: [0], extra: true },
      "settings",
    ),
  ).toContain("settings.extra: is not allowed");
});

it("fails closed for unknown validation keywords", () => {
  expect(policySchemaErrors({ type: "string", contentEncoding: "base64" }, "not-an-email")).toEqual(
    ["policy: unsupported schema keyword contentEncoding"],
  );
});

it("uses Unicode pattern semantics to reject hidden characters", () => {
  const schema = { type: "string", pattern: "^[^\\p{C}]+$" };
  expect(policySchemaErrors(schema, "Cafe\u0301")).toEqual([]);
  expect(policySchemaErrors(schema, "safe\u0000value")).toContain("policy: has an invalid format");
});

it("accepts protected issuedAt date-times and rejects other formats or invalid values", () => {
  const issuedAt = { type: "string", format: "date-time" };
  expect(policySchemaErrors(issuedAt, "2026-09-04T23:00:00Z", "bundle.issuedAt")).toEqual([]);
  expect(policySchemaErrors(issuedAt, "2026-13-04T23:00:00Z", "bundle.issuedAt")).toContain(
    "bundle.issuedAt: has an invalid date-time",
  );
  expect(policySchemaErrors({ type: "string", format: "email" }, "x")).toContain(
    "policy: has an unsupported format",
  );
});

it("short-circuits oversized item validation and bounds returned issues", () => {
  const hostile = Array.from({ length: 15_000 }, () => -1);
  const oversized = policySchemaErrors(
    { type: "array", maxItems: 2, items: { type: "integer", minimum: 0 } },
    hostile,
  );
  expect(oversized).toEqual(["policy: must contain at most 2 items"]);
  const bounded = policySchemaErrors({ type: "array", items: { const: 0 } }, hostile);
  expect(bounded).toHaveLength(100);
  expect(bounded.at(-1)).toBe("policy: validation error limit exceeded");
});

it("keeps a valid v3 anyOf branch after its incompatible v2 branch fails", () => {
  const schema = {
    anyOf: [
      {
        type: "object",
        properties: { schemaVersion: { const: 2 }, legacy: { type: "string" } },
        required: ["schemaVersion", "legacy"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { schemaVersion: { const: 3 }, authoringSelections: { type: "object" } },
        required: ["schemaVersion", "authoringSelections"],
        additionalProperties: false,
      },
    ],
  };
  expect(policySchemaErrors(schema, { schemaVersion: 3, authoringSelections: {} })).toEqual([]);
});

it("keeps if-condition node-budget exhaustion terminal", () => {
  const hostile = Array.from({ length: 100_001 }, () => 0);
  expect(policySchemaErrors({ if: { type: "array", items: {} } }, hostile)).toContain(
    "policy: validation node limit exceeded",
  );
});

it("accepts ordinary valid large arrays within the shared node budget", () => {
  const values = Array.from({ length: 1_000 }, (_, index) => index);
  expect(
    policySchemaErrors({ type: "array", maxItems: 15_000, items: { type: "integer" } }, values),
  ).toEqual([]);
});
