import { describe, expect, it } from "vitest";
import {
  normalizeStrixVulnerabilities,
  preflightStrix,
  STRIX_INVOCATION_LIMITS,
  StrixEvidenceSchema,
} from "../../src/index.js";

describe("Strix public package surface", () => {
  it("exports the separate security detector contract from the library root", () => {
    expect(normalizeStrixVulnerabilities).toEqual(expect.any(Function));
    expect(preflightStrix).toEqual(expect.any(Function));
    expect(StrixEvidenceSchema).toBeDefined();
    expect(STRIX_INVOCATION_LIMITS).toEqual({
      maxBudgetCents: 1_000,
      maxTurns: 20,
      timeoutMs: 300_000,
    });
  });
});
