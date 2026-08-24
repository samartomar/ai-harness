import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import {
  ALL_COMMAND_SPEC_PATHS,
  ALL_COMMAND_SPECS,
  ALL_COMMANDS,
  CAPABILITIES,
  PARENT_GROUPS,
  READONLY,
} from "../src/commands/index.js";
import { buildProgram } from "../src/program.js";

describe("CLI program", () => {
  it("registers every capability and read-only command", () => {
    const names = buildProgram()
      .commands.map((c) => c.name())
      .filter((n) => n !== "help");
    for (const spec of ALL_COMMANDS) {
      expect(names).toContain(spec.name);
    }
  });

  it("declares 30 top-level capabilities and 9 read-only commands", () => {
    expect(CAPABILITIES).toHaveLength(30);
    expect(READONLY).toHaveLength(9);
  });

  it("registers repair with its isolated apply surface", () => {
    const repair = buildProgram().commands.find((command) => command.name() === "repair");
    expect(repair).toBeDefined();
    expect(repair?.options.map((option) => option.flags).sort()).toEqual([
      "--apply",
      "--context-dir <dir>",
      "--json",
      "--posture <posture>",
      "--root <dir>",
    ]);
    expect(repair?.options.map((option) => option.long)).not.toContain("--yes");
  });

  it("registers workspace acquisition, graph, snapshot, and plan subcommands", () => {
    const workspace = buildProgram().commands.find((c) => c.name() === "workspace");
    expect(workspace?.commands.map((c) => c.name()).sort()).toEqual([
      "add",
      "graph",
      "hydrate",
      "init",
      "link",
      "plan",
      "report",
      "snapshot",
    ]);
  });

  it("registers mcp approve as a nested command", () => {
    const mcp = buildProgram().commands.find((c) => c.name() === "mcp");
    expect(mcp?.commands.map((c) => c.name()).sort()).toEqual(["approve"]);
  });

  it("registers explicit ECC MCP add and remove as nested commands", () => {
    const ecc = buildProgram().commands.find((c) => c.name() === "ecc");
    const mcp = ecc?.commands.find((c) => c.name() === "mcp");
    expect(mcp?.commands.map((c) => c.name()).sort()).toEqual(["add", "remove"]);
  });

  it("registers trust scan as a nested command", () => {
    const trust = buildProgram().commands.find((c) => c.name() === "trust");
    expect(trust?.commands.map((c) => c.name()).sort()).toEqual([
      "allow",
      "list",
      "pin",
      "scan",
      "skillspector-pin",
      "verify",
    ]);
  });

  it("registers skill vet, card, approve, inventory, quarantine, remove, and sync as nested commands", () => {
    const skill = buildProgram().commands.find((c) => c.name() === "skill");
    expect(skill?.commands.map((c) => c.name()).sort()).toEqual([
      "approve",
      "card",
      "inventory",
      "quarantine",
      "remove",
      "sync",
      "vet",
    ]);
  });

  it("registers pack authoring, install, plan, status, uninstall, and validate as nested commands", () => {
    const pack = buildProgram().commands.find((c) => c.name() === "pack");
    expect(pack?.commands.map((c) => c.name()).sort()).toEqual([
      "add",
      "init",
      "install",
      "plan",
      "remove-entry",
      "scaffold",
      "status",
      "uninstall",
      "validate",
    ]);
  });

  it("registers capability resolve, prune, and package commands", () => {
    const capability = buildProgram().commands.find((c) => c.name() === "capability");
    expect(capability?.commands.map((c) => c.name()).sort()).toEqual([
      "package",
      "prune",
      "resolve",
    ]);
  });

  it("keeps package reads zero-write and exposes apply only on mutations", () => {
    const capability = buildProgram().commands.find((command) => command.name() === "capability");
    const packageCommand = capability?.commands.find((command) => command.name() === "package");
    for (const command of packageCommand?.commands ?? []) {
      const flags = command.options.map((option) => option.long);
      if (["add", "update", "remove"].includes(command.name())) {
        expect(flags).toContain("--apply");
      } else {
        expect(flags).not.toContain("--apply");
      }
      expect(flags).not.toContain("--force");
      expect(flags).not.toContain("--support-out");
      expect(flags).not.toContain("--no-log");
    }
  });

  it("registers policy workbench generation, starter, evidence resolution, evaluation, projection, validation, and pin verification as nested commands", () => {
    const policy = buildProgram().commands.find((c) => c.name() === "policy");
    expect(policy?.commands.map((c) => c.name()).sort()).toEqual([
      "evaluate",
      "generate",
      "init",
      "lifecycle",
      "managed",
      "observe",
      "project",
      "resolve",
      "supported",
      "validate",
      "verify",
    ]);
  });

  it("keeps policy generate rootless while repo-scoped policy subcommands accept optional [root]", () => {
    const policy = buildProgram().commands.find((c) => c.name() === "policy");
    expect(policy?.commands.length).toBeGreaterThan(0);
    for (const sub of policy?.commands ?? []) {
      if (sub.name() === "generate") {
        // Still rootless with respect to a governed TARGET repository: its only
        // positional is the administrator root that opts into signed supported
        // catalog consumption, never the conventional repo-scoped [root].
        expect(
          sub.registeredArguments.map((a) => ({ name: a.name(), required: a.required })),
        ).toEqual([{ name: "admin-root", required: false }]);
        continue;
      }
      if (sub.name() === "observe" || sub.name() === "lifecycle") {
        expect(sub.commands.map((nested) => nested.name())).toEqual([
          "npm-package",
          "upstream-artifact",
        ]);
        expect(sub.registeredArguments).toEqual([]);
        continue;
      }
      if (sub.name() === "supported") {
        expect(sub.commands.map((nested) => nested.name())).toEqual(["accept", "inspect"]);
        expect(sub.registeredArguments).toEqual([]);
        continue;
      }
      if (sub.name() === "managed") {
        expect(sub.commands.map((nested) => nested.name())).toEqual(["usage-metering"]);
        expect(sub.registeredArguments).toEqual([]);
        continue;
      }
      expect(
        sub.registeredArguments.map((a) => ({ name: a.name(), required: a.required })),
        `policy ${sub.name()} should take an optional [root]`,
      ).toEqual([{ name: "root", required: false }]);
    }
  });

  it("generates standalone from cwd despite hostile root markers, AIH_ROOT, and legacy GStack config", async () => {
    const repo = mkdtempSync(join(tmpdir(), "aih-policy-generate-hostile-root-"));
    const output = mkdtempSync(join(tmpdir(), "aih-policy-generate-output-"));
    const priorCwd = process.cwd();
    const priorRoot = process.env.AIH_ROOT;
    const priorExitCode = process.exitCode;
    try {
      const staleConfig = JSON.stringify({ binding: { framework: { id: "gstack" } } });
      mkdirSync(join(repo, ".git"));
      mkdirSync(join(repo, ".aih"));
      writeFileSync(join(repo, ".aih-config.json"), staleConfig);
      writeFileSync(join(repo, "aih-org-policy.json"), "{not valid policy");
      writeFileSync(join(output, ".aih-config.json"), staleConfig);
      process.chdir(output);
      process.env.AIH_ROOT = repo;
      const dryRun = buildProgram();
      dryRun.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      await dryRun.parseAsync(["node", "aih", "policy", "generate", "--root", repo, "--no-log"]);
      expect(process.exitCode).toBe(0);
      expect(existsSync(join(output, "aih-policy-workbench.html"))).toBe(false);
      expect(existsSync(join(output, ".aih", "runs"))).toBe(false);

      process.exitCode = undefined;
      const program = buildProgram();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      await program.parseAsync([
        "node",
        "aih",
        "policy",
        "generate",
        "--root",
        repo,
        "--apply",
        "--no-log",
      ]);

      expect(process.exitCode).toBe(0);
      expect(existsSync(join(output, "aih-policy-workbench.html"))).toBe(true);
      expect(existsSync(join(output, ".aih", "runs"))).toBe(false);
      expect(existsSync(join(repo, "aih-policy-workbench.html"))).toBe(false);
      expect(existsSync(join(repo, ".aih", "runs"))).toBe(false);
    } finally {
      process.chdir(priorCwd);
      if (priorRoot === undefined) delete process.env.AIH_ROOT;
      else process.env.AIH_ROOT = priorRoot;
      process.exitCode = priorExitCode;
      rmSync(repo, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("resolves a policy validate positional root like other repo-scoped commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aih-policy-root-"));
    const priorExitCode = process.exitCode;
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      writeFileSync(join(dir, "aih-org-policy.json"), "{not json");
      const program = buildProgram();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      await program.parseAsync(["node", "aih", "policy", "validate", dir, "--json", "--no-log"]);

      // The positional root targeted the tmp repo: its malformed policy is the finding.
      expect(process.exitCode).toBe(1);
      expect(writes.join("")).toContain("org-policy.invalid");
    } finally {
      spy.mockRestore();
      process.exitCode = priorExitCode;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers truth pack and verify as nested commands", () => {
    const truth = buildProgram().commands.find((c) => c.name() === "truth");
    expect(truth?.commands.map((c) => c.name()).sort()).toEqual(["pack", "verify"]);
  });

  it("keeps the canonical CommandSpec registry complete for every registered built-in spec", () => {
    const bareParentPaths = new Set<string>([
      ...PARENT_GROUPS.filter((name) => name !== "workspace"),
      "capability package",
      "ecc mcp",
      "policy observe",
      "policy lifecycle",
      "policy supported",
      "policy managed",
      "policy managed usage-metering",
    ]);
    const registeredPaths = (program: Command, parent: string[] = []): string[] =>
      program.commands.flatMap((cmd) => {
        const path = [...parent, cmd.name()];
        const ownPath = bareParentPaths.has(path.join(" ")) ? [] : [path.join(" ")];
        return [...ownPath, ...registeredPaths(cmd, path)];
      });
    const expected = registeredPaths(buildProgram()).sort();
    const actual = ALL_COMMAND_SPEC_PATHS.map((path) => path.join(" ")).sort();

    expect(actual).toEqual(expected);
    expect(ALL_COMMAND_SPECS).toHaveLength(expected.length);
  });

  it("parses a dry-run capability invocation without throwing", async () => {
    const program = buildProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    await expect(program.parseAsync(["node", "aih", "certs", "--json"])).resolves.toBeDefined();
  }, 20000); // full-program cold start + certs dry-run can edge past the 5s default on slow Windows CI

  it("dispatches registered repair as a dry-run command without applying the effect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aih-cli-repair-"));
    const priorExitCode = process.exitCode;
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      writeFileSync(
        join(dir, ".aih-config.json"),
        JSON.stringify({ contextDir: "ai-coding", schemaVersion: 1, targets: [] }),
      );
      const program = buildProgram();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

      await expect(
        program.parseAsync(["node", "aih", "repair", "--json", "--root", dir]),
      ).resolves.toBeDefined();

      expect(process.exitCode).toBe(0);
      const report = JSON.parse(writes.join("")) as {
        capability?: string;
        digests?: readonly {
          data?: {
            auditCompleteness?: unknown;
            outcome?: unknown;
            preconditionSha256?: unknown;
            targetOccupancy?: unknown;
            targetPath?: unknown;
          };
        }[];
      };
      expect(report.capability).toBe("repair");
      expect(report.digests?.map((digest) => digest.data?.outcome)).toEqual(["plan"]);
      expect(report.digests?.[0]?.data).toMatchObject({
        auditCompleteness: "evidence-gap",
        targetOccupancy: "unoccupied",
        targetPath: "ai-coding",
      });
      expect(report.digests?.[0]?.data?.preconditionSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(existsSync(join(dir, "ai-coding"))).toBe(false);
    } finally {
      spy.mockRestore();
      process.exitCode = priorExitCode;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
