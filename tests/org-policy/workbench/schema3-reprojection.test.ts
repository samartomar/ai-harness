/**
 * The shared schema-3 re-projection (main.ts): both shells re-project an
 * imported schema-3 policy through the prepared catalog with the same step,
 * report the same diagnostics, and surface a rejected restore instead of
 * swallowing it.
 */
import { describe, expect, it } from "vitest";
import type { WorkbenchStateV1 } from "../../../src/org-policy/workbench/contracts.js";
import { createWorkbenchState } from "../../../src/org-policy/workbench/selection-engine.js";
import {
  reprojectSchema3Policy,
  type Schema3ReprojectionSteps,
} from "../../../src/org-policy/workbench/ui/schema3-reprojection.js";

const state: WorkbenchStateV1 = createWorkbenchState();

function steps(overrides: Partial<Schema3ReprojectionSteps> = {}) {
  const restored: unknown[] = [];
  const base: Schema3ReprojectionSteps = {
    importSelections: () => ({ accepted: true, state, diagnostics: ["saved note"] }),
    project: (policy) => ({
      accepted: true,
      policy: { ...policy, projected: true },
      diagnostics: [],
    }),
    restore: (policy) => {
      restored.push(policy);
    },
  };
  return { restored, steps: { ...base, ...overrides } };
}

describe("reprojectSchema3Policy", () => {
  it("re-projects a schema-3 policy and restores the projection", () => {
    const { restored, steps: s } = steps();
    expect(reprojectSchema3Policy({ schemaVersion: 3 }, s)).toEqual({
      state,
      diagnostics: ["saved note"],
    });
    expect(restored).toEqual([{ schemaVersion: 3, projected: true }]);
  });

  it("leaves a schema-2 policy, a rejected import and a non-object alone", () => {
    for (const [snapshot, accepted] of [
      [{ schemaVersion: 2 }, true],
      [{ schemaVersion: 3 }, false],
      [[], true],
    ] as const) {
      const { restored, steps: s } = steps({
        importSelections: () => ({ accepted, state, diagnostics: ["import note"] }),
      });
      expect(reprojectSchema3Policy(snapshot, s)).toEqual({
        state,
        diagnostics: ["import note"],
      });
      expect(restored).toEqual([]);
    }
  });

  it("reports the projection diagnostics after the import diagnostics", () => {
    const { restored, steps: s } = steps({
      project: (policy) => ({ accepted: false, policy, diagnostics: ["projection refused"] }),
    });
    expect(reprojectSchema3Policy({ schemaVersion: 3 }, s).diagnostics).toEqual([
      "saved note",
      "projection refused",
    ]);
    expect(restored).toEqual([]);
  });

  it("surfaces a rejected restore instead of swallowing it", () => {
    const rejecting = steps({
      restore: () => {
        throw new Error("Policy import rejected: grammar");
      },
    });
    expect(reprojectSchema3Policy({ schemaVersion: 3 }, rejecting.steps).diagnostics).toEqual([
      "saved note",
      "Policy import rejected: grammar",
    ]);
    const opaque = steps({
      restore: () => {
        throw "not an error";
      },
    });
    expect(reprojectSchema3Policy({ schemaVersion: 3 }, opaque.steps).diagnostics).toEqual([
      "saved note",
      "Policy update was rejected.",
    ]);
  });
});
