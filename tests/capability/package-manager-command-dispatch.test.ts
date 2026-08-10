import { describe, expect, it, vi } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";

const mocks = vi.hoisted(() => ({
  ownership: vi.fn(() => ({ state: "absent" as const })),
  mixed: vi.fn(() => ({
    schemaVersion: 1 as const,
    status: "applied" as const,
    operation: "add" as const,
    packageId: "package:ecc-agent/reviewer",
    writes: ["aih-capability-packages.json"],
    removes: [],
    report: { schemaVersion: 1 },
  })),
  skill: vi.fn(() => {
    throw new Error("skill coordinator must not receive ECC packages");
  }),
}));

vi.mock("../../src/capability/package-manager/receipt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/capability/package-manager/receipt.js")>()),
  readCapabilityPackageOwnershipReceipt: mocks.ownership,
}));

vi.mock("../../src/capability/package-manager/domains/mixed-coordinator.js", () => ({
  reconcileMixedCapabilityPackages: mocks.mixed,
}));
vi.mock("../../src/capability/package-manager/domains/skill-pack-coordinator.js", () => ({
  reconcileSkillPackCapabilityPackage: mocks.skill,
}));

import { executeCapabilityPackageCommand } from "../../src/capability/package-manager/commands.js";

describe("capability package command domain dispatch", () => {
  it("routes removal through the closure coordinator when another package remains", async () => {
    mocks.ownership.mockReturnValueOnce({
      state: "valid",
      receipt: {
        packages: [
          { id: "package:ecc-agent/reviewer" },
          { id: "package:ecc-agent/security-reviewer" },
        ],
      },
    } as never);
    const ctx = {
      root: "/tmp/package-command-dispatch",
      contextDir: "ai-coding",
      apply: true,
      verify: false,
      json: false,
      env: {},
      options: { packageId: "package:ecc-agent/reviewer" },
    } as unknown as PlanContext;

    await executeCapabilityPackageCommand("remove", ctx);

    expect(mocks.mixed).toHaveBeenCalledWith({
      root: ctx.root,
      contextDir: ctx.contextDir,
      operation: "remove",
      packageId: "package:ecc-agent/reviewer",
      apply: true,
    });
  });

  it("routes a single-domain ECC removal through the closure coordinator", async () => {
    const ctx = {
      root: "/tmp/package-command-dispatch",
      contextDir: "ai-coding",
      apply: true,
      verify: false,
      json: false,
      env: {},
      options: { packageId: "package:ecc-agent/reviewer" },
    } as unknown as PlanContext;

    const result = await executeCapabilityPackageCommand("remove", ctx);

    expect(mocks.mixed).toHaveBeenCalledWith({
      root: ctx.root,
      contextDir: ctx.contextDir,
      operation: "remove",
      packageId: "package:ecc-agent/reviewer",
      apply: true,
    });
    expect(mocks.skill).not.toHaveBeenCalled();
    expect(result.digests[0]?.data).toMatchObject({ status: "applied" });
  });

  it("routes a single-domain ECC MCP removal through the closure coordinator", async () => {
    const ctx = {
      root: "/tmp/package-command-dispatch",
      contextDir: "ai-coding",
      apply: true,
      verify: false,
      json: false,
      env: {},
      options: { packageId: "package:ecc-mcp/memxus" },
    } as unknown as PlanContext;

    await executeCapabilityPackageCommand("remove", ctx);

    expect(mocks.mixed).toHaveBeenCalledWith({
      root: ctx.root,
      contextDir: ctx.contextDir,
      operation: "remove",
      packageId: "package:ecc-mcp/memxus",
      apply: true,
    });
    expect(mocks.skill).not.toHaveBeenCalled();
  });

  it("routes add/update through the closure-wide coordinator", async () => {
    const ctx = {
      root: "/tmp/package-command-dispatch",
      contextDir: "ai-coding",
      apply: true,
      verify: false,
      json: false,
      env: {},
      options: { packageId: "package:ecc-agent/reviewer" },
    } as unknown as PlanContext;

    await executeCapabilityPackageCommand("add", ctx);

    expect(mocks.mixed).toHaveBeenCalledWith({
      root: ctx.root,
      contextDir: ctx.contextDir,
      operation: "add",
      packageId: "package:ecc-agent/reviewer",
      apply: true,
    });
  });

  it("surfaces a stable stage and reason when reconciliation refuses", async () => {
    mocks.mixed.mockReturnValueOnce({
      schemaVersion: 1,
      status: "refused",
      stage: "custody",
      reason: "invalid-current-custody",
    } as never);
    const ctx = {
      root: "/tmp/package-command-dispatch",
      contextDir: "ai-coding",
      apply: true,
      verify: false,
      json: false,
      env: {},
      options: { packageId: "package:ecc-agent/reviewer" },
    } as unknown as PlanContext;

    await expect(executeCapabilityPackageCommand("update", ctx)).rejects.toThrow(
      "reconciliation refused at custody: invalid-current-custody",
    );
  });

  it("projects reconciled removals into the command result", async () => {
    mocks.mixed.mockReturnValueOnce({
      schemaVersion: 1,
      status: "applied",
      operation: "remove",
      packageId: "package:ecc-agent/reviewer",
      writes: [],
      removes: [".claude/agents/reviewer.md"],
      report: { schemaVersion: 1 },
    } as never);
    const ctx = {
      root: "/tmp/package-command-dispatch",
      contextDir: "ai-coding",
      apply: true,
      verify: false,
      json: false,
      env: {},
      options: { packageId: "package:ecc-agent/reviewer" },
    } as unknown as PlanContext;

    const result = await executeCapabilityPackageCommand("remove", ctx);

    expect(result.removed).toEqual([
      {
        path: ".claude/agents/reviewer.md",
        describe: "receipt-bound capability package subtraction",
        effect: "delete",
      },
    ]);
  });
});
