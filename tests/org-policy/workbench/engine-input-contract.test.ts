import { describe, expect, it } from "vitest";
import {
  parseWorkbenchInput,
  WORKBENCH_INPUT_FORMAT,
  WORKBENCH_INPUT_VERSION,
} from "../../../src/org-policy/workbench/engine/index.js";

/**
 * The versioned page input (Policy Workbench UI delivery, "Real hosts"). Pure
 * lane: the parser is strict and never throws, whatever a host hands it.
 */

function accepted(door: "admin" | "user" | "chooser" = "admin"): unknown {
  return { format: WORKBENCH_INPUT_FORMAT, version: 1, door, model: { catalog: {} } };
}

describe("workbench input contract", () => {
  it("names the format and the one supported version", () => {
    expect(WORKBENCH_INPUT_FORMAT).toBe("aih-workbench-input");
    expect(WORKBENCH_INPUT_VERSION).toBe(1);
  });

  it.each(["admin", "user", "chooser"] as const)("accepts the %s door", (door) => {
    const result = parseWorkbenchInput(accepted(door));
    expect(result).toEqual({
      ok: true,
      value: { format: WORKBENCH_INPUT_FORMAT, version: 1, door, model: { catalog: {} } },
    });
  });

  it.each([
    ["null", null],
    ["a number", 42],
    ["an array", []],
    ["a string", "{}"],
  ])("refuses %s as an object", (_label, value) => {
    const result = parseWorkbenchInput(value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(["The page input is not a JSON object."]);
  });

  it.each([
    ["an extra key", { ...(accepted() as object), extra: 1 }],
    ["a missing model", { format: WORKBENCH_INPUT_FORMAT, version: 1, door: "admin" }],
    ["a missing door", { format: WORKBENCH_INPUT_FORMAT, version: 1, model: {} }],
  ])("refuses %s by exact keys", (_label, value) => {
    const result = parseWorkbenchInput(value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      "The page input must have exactly the keys door, format, model, version.",
    ]);
  });

  it("refuses another format", () => {
    const result = parseWorkbenchInput({ ...(accepted() as object), format: "other" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(["The page input is not aih-workbench-input."]);
  });

  it("refuses an unknown version and names both versions", () => {
    const result = parseWorkbenchInput({ ...(accepted() as object), version: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(["The page input is version 2. This page supports version 1."]);
  });

  it("refuses an unknown door", () => {
    const result = parseWorkbenchInput({ ...(accepted() as object), door: "root" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(["The page input door must be one of admin, user, chooser."]);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "model"],
  ])("refuses %s as the model", (_label, model) => {
    const result = parseWorkbenchInput({ ...(accepted() as object), model });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(["The page input model is not a JSON object."]);
  });
});
