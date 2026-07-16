import { describe, expect, it } from "vitest";
import {
  classifyEnrollment,
  findingCodes,
  isPhaseASupportLevel,
  phaseASupportLevels,
} from "../../src/methodology/state.js";

describe("methodology state", () => {
  it("treats an unenrolled project as valid and inactive", () => {
    expect(classifyEnrollment(undefined)).toEqual({
      enrollment: "unenrolled",
      activation: "inactive",
      selectedProvider: undefined,
    });
  });

  it("treats selected intent without Phase B state as selected but inactive", () => {
    expect(classifyEnrollment("gstack")).toEqual({
      enrollment: "selected-but-inactive",
      activation: "inactive",
      selectedProvider: "gstack",
    });
  });

  it("caps Phase A support at mutation-research-eligible", () => {
    expect(phaseASupportLevels).toEqual([
      "discoverable",
      "evaluable",
      "plannable",
      "mutation-research-eligible",
    ]);
    expect(isPhaseASupportLevel("mutation-research-eligible")).toBe(true);
    expect(isPhaseASupportLevel("deliverable")).toBe(false);
    expect(isPhaseASupportLevel("activatable")).toBe(false);
    expect(isPhaseASupportLevel("switchable")).toBe(false);
    expect(isPhaseASupportLevel("concurrent")).toBe(false);
  });

  it("exports stable Phase A finding codes", () => {
    expect(findingCodes).toContain("METHODOLOGY_INTENT_INVALID");
    expect(findingCodes).toContain("ADAPTER_COMPATIBILITY_UNKNOWN");
    expect(findingCodes).toContain("HOST_LOAD_SURFACE_UNKNOWN");
    expect(findingCodes).toContain("QUALIFICATION_INCOMPLETE");
    expect(new Set(findingCodes).size).toBe(findingCodes.length);
  });
});
