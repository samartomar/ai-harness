import { describe, expect, it, vi } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";

const mocks = vi.hoisted(() => ({
  skill: vi.fn(() => ({
    schemaVersion: 1 as const,
    status: "applied" as const,
    operation: "add" as const,
    packageId: "package:skill-pack/review",
    writes: ["aih-capability-packages.json"],
    removes: [],
    report: { schemaVersion: 1 },
  })),
}));
vi.mock("../../src/capability/package-manager/domains/skill-pack-coordinator.js", () => ({
  reconcileSkillPackCapabilityPackage: mocks.skill,
}));

import { executeCapabilityPackageCommand } from "../../src/capability/package-manager/commands.js";

function context(packageId: string): PlanContext {
  return {
    root: "/tmp/package-command-dispatch",
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: false,
    env: {},
    options: { packageId },
  } as unknown as PlanContext;
}

describe("capability package command dispatch", () => {
  it("refuses ECC agent, rule, and MCP mutations with the developer route", async () => {
    for (const id of [
      "package:ecc-agent/reviewer",
      "package:ecc-rule/rules",
      "package:ecc-mcp/memxus",
    ]) {
      await expect(executeCapabilityPackageCommand("remove", context(id))).rejects.toMatchObject({
        code: "AIH_CONFIG",
        message: expect.stringContaining("run aih ecc for the exact ECC commands"),
      });
    }
    expect(mocks.skill).not.toHaveBeenCalled();
  });

  it("keeps skill-pack mutation dispatch", async () => {
    const result = await executeCapabilityPackageCommand(
      "add",
      context("package:skill-pack/review"),
    );
    expect(mocks.skill).toHaveBeenCalledOnce();
    expect(result.writes.map((entry) => entry.path)).toEqual(["aih-capability-packages.json"]);
  });
});
