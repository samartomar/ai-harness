import { describe, expect, it } from "vitest";
import { pendingPlan } from "../../src/commands/stub.js";
import type { PlanContext } from "../../src/internals/plan.js";

describe("pendingPlan", () => {
  it("emits a single safe doc action for a not-yet-built capability", async () => {
    const fn = pendingPlan("widgets", "coming soon");
    const p = await fn({} as PlanContext);
    expect(p.capability).toBe("widgets");
    expect(p.actions).toHaveLength(1);
    const [action] = p.actions;
    expect(action?.kind).toBe("doc");
    expect(action?.kind === "doc" && action.describe).toContain("implementation pending");
    expect(action?.kind === "doc" && action.text).toBe("coming soon");
  });
});
