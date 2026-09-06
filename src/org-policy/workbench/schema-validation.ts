import { z } from "zod";

/**
 * Browser-safe, fail-closed JSON Schema subset used by generated policy forms.
 *
 * This supports only the keywords emitted by this repository's generated
 * policy, decision, receipt, and Workbench bundle schemas. Adding a keyword
 * requires adding its semantics here; silently ignoring a constraint would
 * weaken the browser validation boundary.
 */
const annotationKeywords = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "annotation",
]);

const validationKeywords = new Set([
  "format",
  "allOf",
  "anyOf",
  "oneOf",
  "if",
  "then",
  "else",
  "const",
  "enum",
  "type",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "items",
  "required",
  "properties",
  "additionalProperties",
  "propertyNames",
]);

const supportedTypes = new Set([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "integer",
  "string",
]);

const isoDateTimeWithOffset = z.iso.datetime({ offset: true });
const maximumValidationIssues = 100;
const maximumValidationNodes = 100_000;

type ValidationContext = { exhausted: boolean; nodes: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(path: string, detail: string): string {
  return `${path}: ${detail}`;
}

function propertyPath(path: string, property: string): string {
  return `${path}.${property}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((item, index) => sameJson(item, right[index]))
    );
  if (!isRecord(left) || !isRecord(right)) return false;

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]))
  );
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function schemas(
  value: unknown,
  path: string,
  keyword: string,
): { schemas?: readonly unknown[]; errors: string[] } {
  if (!Array.isArray(value)) return { errors: [issue(path, `${keyword} must be an array`)] };
  return { schemas: value, errors: [] };
}

function nonNegativeInteger(value: unknown, path: string, keyword: string): string[] {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? []
    : [issue(path, `${keyword} must be a non-negative integer`)];
}

function finiteNumber(value: unknown, path: string, keyword: string): string[] {
  return typeof value === "number" && Number.isFinite(value)
    ? []
    : [issue(path, `${keyword} must be a finite number`)];
}

function validateSchema(
  schema: unknown,
  value: unknown,
  path: string,
  context: ValidationContext,
): string[] {
  if (++context.nodes > maximumValidationNodes) {
    context.exhausted = true;
    return [issue(path, "validation node limit exceeded")];
  }
  if (!isRecord(schema)) return [issue(path, "schema must be an object")];

  const errors: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!annotationKeywords.has(key) && !validationKeywords.has(key))
      errors.push(issue(path, `unsupported schema keyword ${key}`));
  }
  if (errors.length > 0) return errors;

  if ("allOf" in schema) {
    const allOf = schemas(schema.allOf, path, "allOf");
    errors.push(...allOf.errors);
    for (const branch of allOf.schemas ?? [])
      errors.push(...validateSchema(branch, value, path, context));
  }
  if ("anyOf" in schema) {
    const anyOf = schemas(schema.anyOf, path, "anyOf");
    errors.push(...anyOf.errors);
    if (
      (anyOf.schemas ?? []).every(
        (branch) => validateSchema(branch, value, path, context).length > 0,
      )
    )
      errors.push(issue(path, "must match at least one schema variant"));
  }
  if ("oneOf" in schema) {
    const oneOf = schemas(schema.oneOf, path, "oneOf");
    errors.push(...oneOf.errors);
    if (
      (oneOf.schemas ?? []).filter(
        (branch) => validateSchema(branch, value, path, context).length === 0,
      ).length !== 1
    )
      errors.push(issue(path, "must match exactly one schema variant"));
  }
  if ("if" in schema) {
    const condition = validateSchema(schema.if, value, path, context);
    const branch = condition.length === 0 ? schema.then : schema.else;
    if (branch !== undefined) errors.push(...validateSchema(branch, value, path, context));
  }
  if ("const" in schema && !sameJson(value, schema.const))
    errors.push(issue(path, "must equal the expected value"));
  if ("enum" in schema) {
    if (!Array.isArray(schema.enum)) errors.push(issue(path, "enum must be an array"));
    else if (!schema.enum.some((candidate) => sameJson(value, candidate)))
      errors.push(issue(path, "must be one of the allowed values"));
  }
  if ("type" in schema) {
    const types =
      typeof schema.type === "string"
        ? [schema.type]
        : Array.isArray(schema.type) && schema.type.every((entry) => typeof entry === "string")
          ? schema.type
          : undefined;
    if (!types || types.length === 0 || types.some((type) => !supportedTypes.has(type)))
      errors.push(issue(path, "type must name supported JSON types"));
    else if (!types.some((type) => matchesType(value, type)))
      errors.push(issue(path, `must be ${types.join(" or ")}`));
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    for (const [keyword, comparison, detail] of [
      ["minimum", (bound: number) => value < bound, "must be at least"],
      ["maximum", (bound: number) => value > bound, "must be at most"],
      ["exclusiveMinimum", (bound: number) => value <= bound, "must be greater than"],
      ["exclusiveMaximum", (bound: number) => value >= bound, "must be less than"],
    ] as const) {
      if (!(keyword in schema)) continue;
      errors.push(...finiteNumber(schema[keyword], path, keyword));
      if (
        typeof schema[keyword] === "number" &&
        Number.isFinite(schema[keyword]) &&
        comparison(schema[keyword])
      )
        errors.push(issue(path, `${detail} ${schema[keyword]}`));
    }
  }
  if (typeof value === "string") {
    for (const [keyword, comparison, detail] of [
      ["minLength", (bound: number) => value.length < bound, "must have at least"],
      ["maxLength", (bound: number) => value.length > bound, "must have at most"],
    ] as const) {
      if (!(keyword in schema)) continue;
      errors.push(...nonNegativeInteger(schema[keyword], path, keyword));
      if (
        typeof schema[keyword] === "number" &&
        Number.isSafeInteger(schema[keyword]) &&
        schema[keyword] >= 0 &&
        comparison(schema[keyword])
      )
        errors.push(issue(path, `${detail} ${schema[keyword]} characters`));
    }
    if ("format" in schema) {
      if (schema.format !== "date-time") errors.push(issue(path, "has an unsupported format"));
      else if (!isoDateTimeWithOffset.safeParse(value).success)
        errors.push(issue(path, "has an invalid date-time"));
    }
    if ("pattern" in schema) {
      if (typeof schema.pattern !== "string") errors.push(issue(path, "pattern must be a string"));
      else
        try {
          if (!new RegExp(schema.pattern, "u").test(value))
            errors.push(issue(path, "has an invalid format"));
        } catch {
          errors.push(issue(path, "pattern must be a valid regular expression"));
        }
    }
  }
  if (Array.isArray(value)) {
    for (const [keyword, comparison, detail] of [
      ["minItems", (bound: number) => value.length < bound, "must contain at least"],
      ["maxItems", (bound: number) => value.length > bound, "must contain at most"],
    ] as const) {
      if (!(keyword in schema)) continue;
      errors.push(...nonNegativeInteger(schema[keyword], path, keyword));
      if (
        typeof schema[keyword] === "number" &&
        Number.isSafeInteger(schema[keyword]) &&
        schema[keyword] >= 0 &&
        comparison(schema[keyword])
      )
        errors.push(issue(path, `${detail} ${schema[keyword]} items`));
    }
    const exceedsDeclaredMaximum =
      typeof schema.maxItems === "number" &&
      Number.isSafeInteger(schema.maxItems) &&
      schema.maxItems >= 0 &&
      value.length > schema.maxItems;
    if ("items" in schema && !exceedsDeclaredMaximum)
      for (const [index, item] of value.entries()) {
        if (errors.length >= maximumValidationIssues) {
          errors.push(issue(path, "validation error limit exceeded"));
          break;
        }
        errors.push(...validateSchema(schema.items, item, `${path}[${index}]`, context));
      }
  }
  if (
    isRecord(value) &&
    ("required" in schema ||
      "properties" in schema ||
      "additionalProperties" in schema ||
      "propertyNames" in schema)
  ) {
    if ("required" in schema) {
      if (
        !Array.isArray(schema.required) ||
        !schema.required.every((entry) => typeof entry === "string")
      )
        errors.push(issue(path, "required must be an array of property names"));
      else
        for (const key of schema.required)
          if (!(key in value)) errors.push(issue(propertyPath(path, key), "is required"));
    }
    const properties =
      "properties" in schema && !isRecord(schema.properties)
        ? undefined
        : (schema.properties as Record<string, unknown> | undefined);
    if ("properties" in schema && !properties)
      errors.push(issue(path, "properties must be an object"));
    if ("propertyNames" in schema)
      for (const key of Object.keys(value)) {
        if (errors.length >= maximumValidationIssues) {
          errors.push(issue(path, "validation error limit exceeded"));
          break;
        }
        errors.push(...validateSchema(schema.propertyNames, key, path, context));
      }
    for (const [key, item] of Object.entries(value)) {
      if (errors.length >= maximumValidationIssues) {
        errors.push(issue(path, "validation error limit exceeded"));
        break;
      }
      if (properties && key in properties)
        errors.push(...validateSchema(properties[key], item, propertyPath(path, key), context));
      else if (schema.additionalProperties === true) continue;
      else if (isRecord(schema.additionalProperties))
        errors.push(
          ...validateSchema(schema.additionalProperties, item, propertyPath(path, key), context),
        );
      else if (schema.additionalProperties === false || schema.additionalProperties === undefined)
        errors.push(issue(propertyPath(path, key), "is not allowed"));
      else errors.push(issue(path, "additionalProperties must be a boolean or schema"));
    }
  }
  return errors.length > maximumValidationIssues
    ? [
        ...errors.slice(0, maximumValidationIssues - 1),
        issue(path, "validation error limit exceeded"),
      ]
    : errors;
}

/**
 * Returns stable, human-readable validation errors for a generated policy
 * schema. `path` names the root in errors and defaults to "policy".
 */
export function policySchemaErrors(schema: unknown, value: unknown, path = "policy"): string[] {
  const context: ValidationContext = { exhausted: false, nodes: 0 };
  const errors = validateSchema(schema, value, path, context);
  if (!context.exhausted) return errors;
  const terminal = issue(path, "validation node limit exceeded");
  return errors.includes(terminal)
    ? errors
    : [...errors.slice(0, maximumValidationIssues - 1), terminal];
}
