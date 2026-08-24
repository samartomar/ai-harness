import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { executePolicyManagedUsageReconcileCommandV1 } from "../../src/org-policy/aih-managed-usage-command-v1.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { buildProgram } from "../../src/program.js";

describe("policy managed usage-metering command", () => {
  it("exposes only the fixed describe, reconcile, and inspect lifecycle", () => {
    const policy = buildProgram().commands.find((command) => command.name() === "policy");
    const managed = policy?.commands.find((command) => command.name() === "managed");
    const usage = managed?.commands.find((command) => command.name() === "usage-metering");

    expect(usage?.commands.map((command) => command.name())).toEqual([
      "describe",
      "reconcile",
      "inspect",
    ]);

    const describeCommand = usage?.commands.find((command) => command.name() === "describe");
    const reconcile = usage?.commands.find((command) => command.name() === "reconcile");
    const inspect = usage?.commands.find((command) => command.name() === "inspect");

    expect(describeCommand?.registeredArguments).toHaveLength(0);
    expect(inspect?.registeredArguments.map((argument) => argument.name())).toEqual(["root"]);
    expect(reconcile?.registeredArguments.map((argument) => argument.name())).toEqual(["root"]);
    expect(reconcile?.options.map((option) => option.flags)).toEqual(
      expect.arrayContaining([
        "--decision <id>",
        "--decision-digest <sha256>",
        "--target <id>",
        "--evidence <root-relative-file>",
      ]),
    );
    expect(reconcile?.options.map((option) => option.flags)).not.toEqual(
      expect.arrayContaining([
        "--adapter <id>",
        "--effect <effect>",
        "--command <command>",
        "--path <path>",
        "--script <path>",
        "--source <source>",
      ]),
    );
  });

  it("returns nonzero structured verification for invalid durable custody", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-managed-usage-command-"));
    const priorExitCode = process.exitCode;
    const output: string[] = [];
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        output.push(String(chunk));
        return true;
      });
    try {
      mkdirSync(join(root, ".aih"));
      writeFileSync(join(root, ".aih", "org-policy-hook-receipt.json"), "{}");
      const program = buildProgram();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      await program.parseAsync([
        "node",
        "aih",
        "policy",
        "managed",
        "usage-metering",
        "inspect",
        root,
        "--json",
      ]);

      expect(process.exitCode).toBe(1);
      expect(output.join("")).toContain("org-policy.invalid");
    } finally {
      stdout.mockRestore();
      process.exitCode = priorExitCode;
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("passes absent inspection and refuses an incomplete direct reconcile request", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-managed-usage-command-"));
    const priorExitCode = process.exitCode;
    const output: string[] = [];
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        output.push(String(chunk));
        return true;
      });
    try {
      process.exitCode = 0;
      const program = buildProgram();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      await program.parseAsync([
        "node",
        "aih",
        "policy",
        "managed",
        "usage-metering",
        "inspect",
        root,
        "--json",
      ]);
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({
        digests: [{ data: { state: "absent", audit: "bounded-history" } }],
        report: { ok: true },
      });

      const run = fakeRunner(() => ({ code: 1 }));
      const ctx: PlanContext = {
        root,
        contextDir: "ai-coding",
        apply: false,
        verify: false,
        json: true,
        run,
        host: makeHostAdapter({ platform: "linux", run, env: {} }),
        env: {},
        options: {},
      };
      const result = await executePolicyManagedUsageReconcileCommandV1(ctx);
      expect(result.digests[0]?.data).toMatchObject({
        domain: { outcome: "refused", reason: "invalid-input" },
        inspection: { state: "absent" },
      });
    } finally {
      stdout.mockRestore();
      process.exitCode = priorExitCode;
      rmSync(root, { force: true, recursive: true });
    }
  });
});
