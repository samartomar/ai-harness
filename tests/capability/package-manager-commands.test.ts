import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  capabilityPackageAddCommand,
  capabilityPackageDoctorCommand,
  capabilityPackageListCommand,
  capabilityPackageRemoveCommand,
  capabilityPackageShowCommand,
  capabilityPackageStatusCommand,
  capabilityPackageUpdateCommand,
} from "../../src/capability/package-manager/commands.js";
import { runCapability } from "../../src/commands/run.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { buildProgram } from "../../src/program.js";

const SHA = "a".repeat(40);
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-package-command-"));
  const write = (path: string, value: unknown) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  const evidencePath = ".aih/skill-reports/owner-repo-aaaaaaaa.json";
  const evidence = {
    schemaVersion: 1,
    source: `owner/repo@${SHA}`,
    pinnedSha: SHA,
    checks: [],
    analyzersRun: ["aih-native"],
    verdict: "GREEN",
    reasons: [],
  };
  const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");
  write(evidencePath, evidence);
  write("ai-coding/skill-cards/clean.json", {
    schemaVersion: 1,
    name: "clean",
    source: `owner/repo@${SHA}`,
    commit: SHA,
    license: "Apache-2.0",
    installScope: "repo",
    riskClass: "green",
    requiresMcp: false,
    requiresShell: false,
    scanEvidence: [evidencePath],
    approval: {
      verdict: "GREEN",
      approvedBy: "security",
      approvedAt: "2026-08-10T00:00:00.000Z",
    },
  });
  write("aih-org-policy.json", {
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    capabilityPackages: {
      catalog: { provider: "github", repository: "host/capabilities" },
      roots: ["package:skill-pack/docs-quality"],
    },
  });
  write(".aih-config.json", {
    schemaVersion: 1,
    contextDir: "ai-coding",
    targets: [],
  });
  write("aih-skills.lock.json", {
    schemaVersion: 1,
    skills: [
      {
        name: "clean",
        source: `owner/repo@${SHA}`,
        commit: SHA,
        verdict: "GREEN",
        scope: "repo",
        card: "ai-coding/skill-cards/clean.json",
        evidenceSha256,
        approvedBy: "security",
        approvedAt: "2026-08-10T00:00:00.000Z",
      },
    ],
  });
  write("aih-packs.json", {
    schemaVersion: 1,
    packs: [
      {
        name: "docs-quality",
        skills: [{ name: "clean", source: `owner/repo@${SHA}`, commit: SHA }],
      },
    ],
  });
  const skillBytes = Buffer.from("# Clean\n", "utf8");
  write(".aih/trust-lock.json", {
    schemaVersion: 1,
    sources: [
      {
        id: "owner-repo",
        kind: "github",
        source: "owner/repo",
        ref: "main",
        pinnedSha: SHA,
        promotedAt: "2026-08-10T00:00:00.000Z",
        promotedSkills: ["clean"],
        analyzersRun: ["aih-native"],
        artifactHashes: [
          {
            path: "skills/clean/SKILL.md",
            sha256: createHash("sha256").update(skillBytes).digest("hex"),
          },
        ],
        findings: [],
      },
    ],
  });
  const installed = join(root, "ai-coding/skills/owner-repo/clean/SKILL.md");
  mkdirSync(dirname(installed), { recursive: true });
  writeFileSync(installed, skillBytes, { mode: 0o640 });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function ctx(options: Record<string, unknown> = {}): PlanContext {
  const run = fakeRunner(() => {
    throw new Error("package preview must not execute processes");
  });
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options,
  };
}

describe("aih capability package commands", () => {
  it("uses one typed report for list/show/status/doctor and emits only local digests", async () => {
    for (const [command, options] of [
      [capabilityPackageListCommand, {}],
      [capabilityPackageShowCommand, { packageId: "package:skill-pack/docs-quality" }],
      [capabilityPackageStatusCommand, {}],
      [capabilityPackageStatusCommand, { packageId: "package:skill-pack/docs-quality" }],
      [capabilityPackageDoctorCommand, {}],
    ] as const) {
      const result = await command.plan(ctx(options));
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toMatchObject({ kind: "digest", data: { schemaVersion: 1 } });
    }
  });

  it("makes add/update/remove preview-only with zero mutation or execution actions", async () => {
    for (const command of [
      capabilityPackageAddCommand,
      capabilityPackageUpdateCommand,
      capabilityPackageRemoveCommand,
    ]) {
      const result = await command.plan(ctx({ packageId: "package:skill-pack/docs-quality" }));
      expect(result.actions.map(({ kind }) => kind)).toEqual(["digest"]);
      expect(result.actions[0]).toMatchObject({
        data: { preview: { writes: 0, network: false, processExecution: false } },
      });
    }
  });

  it("keeps inspection read-only while making mutations explicit apply-only commands", () => {
    for (const command of [
      capabilityPackageListCommand,
      capabilityPackageShowCommand,
      capabilityPackageStatusCommand,
      capabilityPackageDoctorCommand,
    ]) {
      expect(command.readOnly).toBe(true);
      expect(command.zeroWrite).toBe(true);
    }
    for (const command of [
      capabilityPackageAddCommand,
      capabilityPackageUpdateCommand,
      capabilityPackageRemoveCommand,
    ]) {
      expect(command.readOnly).toBe(false);
      expect(command.zeroWrite).toBe(true);
    }
  });

  it("does not append the cross-cutting run ledger for a preview", async () => {
    const command = new Command("add")
      .option("--json")
      .option("--root <dir>")
      .option("--context-dir <dir>", "", "ai-coding")
      .option("--posture <posture>", "", "vibe")
      .option("--support-out <dir>")
      .option("--no-log");
    command.parse(["--root", root], { from: "user" });

    const code = await runCapability(capabilityPackageAddCommand, command, {
      env: {},
      write: () => {},
      optionOverrides: { packageId: "package:skill-pack/docs-quality" },
      positionalRoot: false,
    });

    expect(code).toBe(0);
    expect(existsSync(join(root, ".aih", "runs"))).toBe(false);
  });

  it("dispatches --apply through the registered command without acquisition or run-ledger writes", async () => {
    const output: string[] = [];
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        output.push(String(chunk));
        return true;
      });
    const priorExit = process.exitCode;
    try {
      process.exitCode = undefined;
      const program = buildProgram();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      await program.parseAsync([
        "node",
        "aih",
        "capability",
        "package",
        "add",
        "package:skill-pack/docs-quality",
        "--root",
        root,
        "--apply",
        "--json",
      ]);

      expect(process.exitCode ?? 0).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({
        capability: "capability package add",
        applied: true,
        digests: [{ data: { status: "applied" } }],
      });
      expect(existsSync(join(root, "aih-capability-packages.json"))).toBe(true);
      expect(existsSync(join(root, ".aih/capability-packages/ownership-v1.json"))).toBe(true);
      expect(existsSync(join(root, ".aih/runs"))).toBe(false);
    } finally {
      stdout.mockRestore();
      process.exitCode = priorExit;
    }
  });
});
